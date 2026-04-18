/**
 * Daemon entry point — spawned as a child process by the pi extension.
 *
 * Args:
 *   argv[2]  <rootPath>         absolute project root
 *   argv[3+] --auto-install     install missing LSP + tree-sitter before starting
 *            --file-limit=<n>   max files for initial index (default 200)
 *
 * Startup sequence:
 *   1. Check / install tree-sitter grammars (if --auto-install)
 *   2. Load grammars → create TreeSitterParser
 *   3. Detect ALL matching LSP servers for the project
 *   4. Collect files (all tree-sitter-supported extensions)
 *   5. buildNodes(files, tsParser)   ← tree-sitter fast parse, mtime-gated
 *   6. Start socket server + file watcher → write "ready"
 *   7. Background: init each LSP in parallel → open its files → wait diagnostics
 *      → snapshot merged diagnostics → mark each language ready → buildReverseRefs
 *
 * The "ready" status is written BEFORE LSP initializes.
 * LSP failure after step 6 is non-fatal — the tree-sitter index stays available.
 */

import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

import { LspClient } from "../lsp/client.ts";
import { detectServers } from "../lsp/registry.ts";
import { installServer, isInstalled, getInstallHint } from "../lsp/installer.ts";
import { isTreeSitterInstalled, installTreeSitter, getTreeSitterDir } from "../tree-sitter/installer.ts";
import { loadGrammars } from "../tree-sitter/loader.ts";
import { TreeSitterParser } from "../tree-sitter/parser.ts";
import { getProjectDir, ensureDir } from "../paths.ts";
import { EXT_TO_LANG } from "./graph.ts";
import { CodeMapDB } from "./db.ts";
import { Indexer } from "./indexer.ts";
import { DaemonServer } from "./server.ts";
import { FileWatcher } from "./watcher.ts";
import type { LspServerDef } from "../lsp/registry.ts";
import type { Diagnostic } from "../lsp/protocol.ts";

// ── Args ──────────────────────────────────────────────────────────────────────

const rootPath = process.argv[2];
if (!rootPath) {
  process.stderr.write("usage: runner.ts <rootPath> [--auto-install] [--file-limit=N]\n");
  process.exit(1);
}

const autoInstall  = process.argv.includes("--auto-install");
const fileLimitArg = process.argv.find((a) => a.startsWith("--file-limit="));
const fileLimit    = fileLimitArg ? parseInt(fileLimitArg.split("=")[1], 10) || 200 : 200;

// ── Paths ─────────────────────────────────────────────────────────────────────

const projectDir = ensureDir(getProjectDir(rootPath));
const pidFile    = join(projectDir, "codemap-daemon.pid");
const sockFile   = join(projectDir, "codemap-daemon.sock");
const statusFile = join(projectDir, "codemap-daemon.status");
const dbPath     = join(projectDir, "codemap.db");

function log(msg: string) { process.stderr.write(`[code-map] ${msg}\n`); }

// ── Setup ─────────────────────────────────────────────────────────────────────

writeFileSync(pidFile, String(process.pid), "utf8");
writeFileSync(statusFile, "starting", "utf8");
if (existsSync(sockFile)) { try { unlinkSync(sockFile); } catch (_) {} }

// All file extensions tracked by tree-sitter (regardless of LSP availability)
const ALL_EXTENSIONS = new Set(Object.keys(EXT_TO_LANG));

// ── Shutdown ──────────────────────────────────────────────────────────────────

async function shutdown(
  uniqueClients: Array<{ client: LspClient; def: LspServerDef }>,
  server: DaemonServer,
  watcher: FileWatcher,
  indexer: Indexer,
  db: CodeMapDB,
) {
  log("shutting down");
  indexer.abort();
  watcher.stop();
  writeFileSync(statusFile, "stopped", "utf8");
  await server.close();
  await Promise.all(uniqueClients.map(({ client }) => client.shutdown()));
  db.close();
  try { unlinkSync(sockFile); } catch (_) {}
  try { unlinkSync(pidFile); } catch (_) {}
  process.exit(0);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── 0. Tree-sitter: check / install ───────────────────────────────────────

  if (!isTreeSitterInstalled()) {
    if (autoInstall) {
      log("tree-sitter not found, installing…");
      try {
        await installTreeSitter(log);
      } catch (err) {
        log(`tree-sitter install failed (will use LSP fallback): ${err}`);
      }
    } else {
      log("tree-sitter not installed — running in LSP-only mode");
    }
  }

  // ── 1. Load tree-sitter grammars ──────────────────────────────────────────

  let tsParser: TreeSitterParser | undefined;
  try {
    const grammars = loadGrammars(getTreeSitterDir());
    if (grammars) {
      tsParser = new TreeSitterParser(grammars);
      log(`tree-sitter loaded (${grammars.languages.size} grammars)`);
    } else {
      log("tree-sitter grammars unavailable — falling back to LSP symbols");
    }
  } catch (err) {
    log(`tree-sitter load error (falling back to LSP): ${err}`);
  }

  // ── 2. Detect all matching LSP servers ────────────────────────────────────

  const serverDefs = detectServers(rootPath);
  log(`detected languages: ${serverDefs.map((s) => s.languageId).join(", ") || "none (tree-sitter only)"}`);

  // ── 3. Build ext→LspClient map ────────────────────────────────────────────

  const lspClients = new Map<string, LspClient>();
  const uniqueClients: Array<{ client: LspClient; def: LspServerDef }> = [];

  for (const def of serverDefs) {
    if (!isInstalled(def.installId)) {
      if (autoInstall) {
        log(`LSP server not found (${def.installId}), installing…`);
        try {
          await installServer(def.installId, log);
          const updated = detectServers(rootPath).find((d) => d.installId === def.installId);
          if (updated) def.command = updated.command;
        } catch (err) {
          log(`LSP auto-install failed for ${def.installId}: ${err}`);
          log(`Hint: ${getInstallHint(def.installId)}`);
          if (!tsParser) {
            log(`Skipping ${def.languageId} LSP — no tree-sitter fallback available`);
          } else {
            log(`Continuing ${def.languageId} in tree-sitter-only mode.`);
          }
          continue;
        }
      } else {
        log(`LSP server not found: ${def.installId}`);
        log(`Hint: ${getInstallHint(def.installId)}`);
        if (tsParser) {
          log(`Continuing ${def.languageId} in tree-sitter-only mode.`);
        }
        continue;
      }
    }

    const client = new LspClient({
      command:        def.command.split(" ")[0],
      args:           [...def.command.split(" ").slice(1), ...def.args],
      rootPath,
      languageId:     def.languageId,
      initTimeout:    30000,
      requestTimeout: 20000,
    });

    client.on("error", (err: Error) => log(`lsp error [${def.languageId}]: ${err.message}`));

    for (const ext of def.extensions) {
      lspClients.set(ext, client);
    }
    uniqueClients.push({ client, def });
  }

  if (uniqueClients.length === 0 && !tsParser) {
    log("No LSP and no tree-sitter — cannot index. Exiting.");
    writeFileSync(statusFile, "error", "utf8");
    process.exit(1);
  }

  // ── 4. Open SQLite DB + build core objects ────────────────────────────────

  const db      = new CodeMapDB(dbPath);
  const indexer = new Indexer(lspClients, db, rootPath, ALL_EXTENSIONS, log);
  if (tsParser) indexer.tsParser = tsParser;

  // ── 5. Collect files + build node graph (incremental via mtime) ───────────

  writeFileSync(statusFile, "indexing", "utf8");

  const files = indexer.collectFiles(fileLimit);
  log(`found ${files.length} source files (limit: ${fileLimit})`);

  await indexer.buildNodes(files, tsParser);

  // ── 6. Start socket server + file watcher → write "ready" ─────────────────

  const watcher = new FileWatcher(rootPath, [...ALL_EXTENSIONS], async (changedFile) => {
    writeFileSync(statusFile, "indexing", "utf8");
    await indexer.reindexFile(changedFile);
    writeFileSync(statusFile, "ready", "utf8");
  });

  const server = new DaemonServer(sockFile, db, lspClients, rootPath, () =>
    shutdown(uniqueClients, server, watcher, indexer, db),
  );

  await server.listen();
  watcher.start();

  const { nodes } = db.stats() as { nodes: number };
  writeFileSync(statusFile, "ready", "utf8");
  log(`ready — ${nodes} symbols indexed, listening on ${sockFile}`);

  // ── 7. Background: init each LSP → diagnostics → reverse refs ────────────

  void (async () => {
    if (uniqueClients.length === 0) {
      log("No LSP servers — running in tree-sitter-only mode (no diagnostics/impact)");
      return;
    }

    try {
      log("initializing LSP servers (background)…");

      // Init all clients in parallel
      await Promise.all(
        uniqueClients.map(async ({ client, def }) => {
          try {
            await client.initialize();

            // Open files matching this client's extensions
            const clientFiles = files.filter((f) => def.extensions.some((ext) => f.endsWith(ext)));
            for (const f of clientFiles) client.openFile(f);

            log(`waiting for diagnostics [${def.languageId}]…`);
            await client.waitForDiagnostics(4000);

            indexer.snapshotDiagnostics(
              client.getDiagnostics() as Map<string, Diagnostic[]>,
            );

            server.setLangReady(def.languageId);
            log(`LSP ready [${def.languageId}] — diagnostics and impact analysis available`);
          } catch (err) {
            log(`LSP background init failed [${def.languageId}]: ${err}`);
          }
        }),
      );

      // Phase 2: reverse refs (background within background)
      void indexer.buildReverseRefs();
    } catch (err) {
      log(`LSP background init error (tree-sitter index still available): ${err}`);
    }
  })();

  // ── Signal handlers ───────────────────────────────────────────────────────

  process.on("SIGTERM", () => shutdown(uniqueClients, server, watcher, indexer, db));
  process.on("SIGINT",  () => shutdown(uniqueClients, server, watcher, indexer, db));
}

main().catch((err) => {
  log(`fatal: ${err}`);
  writeFileSync(statusFile, "error", "utf8");
  process.exit(1);
});
