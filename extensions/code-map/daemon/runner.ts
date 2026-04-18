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
 *   3. Collect files
 *   4. buildNodes(files, tsParser)   ← tree-sitter fast parse (no LSP)
 *   5. Start socket server + file watcher → write "ready"
 *   6. Background: init LSP → open files → wait diagnostics → snapshot → buildReverseRefs
 *
 * The "ready" status is written BEFORE LSP initializes.
 * LSP failure after step 5 is non-fatal — the tree-sitter index stays available.
 */

import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

import { LspClient } from "../lsp/client.ts";
import { detectServer } from "../lsp/registry.ts";
import { installServer, isInstalled, getInstallHint } from "../lsp/installer.ts";
import { isTreeSitterInstalled, installTreeSitter, getTreeSitterDir } from "../tree-sitter/installer.ts";
import { loadGrammars } from "../tree-sitter/loader.ts";
import { TreeSitterParser } from "../tree-sitter/parser.ts";
import { getProjectDir, ensureDir } from "../paths.ts";
import { CodeGraph } from "./graph.ts";
import { Indexer } from "./indexer.ts";
import { DaemonServer } from "./server.ts";
import { FileWatcher } from "./watcher.ts";
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
const pidFile    = join(projectDir, "daemon.pid");
const sockFile   = join(projectDir, "daemon.sock");
const statusFile = join(projectDir, "daemon.status");

function log(msg: string) { process.stderr.write(`[code-map] ${msg}\n`); }

// ── Setup ─────────────────────────────────────────────────────────────────────

writeFileSync(pidFile, String(process.pid), "utf8");
writeFileSync(statusFile, "starting", "utf8");
if (existsSync(sockFile)) { try { unlinkSync(sockFile); } catch (_) {} }

// ── Shutdown ──────────────────────────────────────────────────────────────────

async function shutdown(
  client: LspClient,
  server: DaemonServer,
  watcher: FileWatcher,
  indexer: Indexer,
) {
  log("shutting down");
  indexer.abort();
  watcher.stop();
  writeFileSync(statusFile, "stopped", "utf8");
  await server.close();
  await client.shutdown();
  try { unlinkSync(sockFile); } catch (_) {}
  try { unlinkSync(pidFile); } catch (_) {}
  process.exit(0);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const serverDef = detectServer(rootPath);
  log(`language: ${serverDef.languageId}  lsp: ${serverDef.command}`);

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

  // ── 2. LSP server check ───────────────────────────────────────────────────

  if (!isInstalled(serverDef.installId)) {
    if (autoInstall) {
      log(`LSP server not found (${serverDef.installId}), installing…`);
      try {
        await installServer(serverDef.installId, log);
        const updated = detectServer(rootPath);
        serverDef.command = updated.command;
      } catch (err) {
        log(`LSP auto-install failed: ${err}`);
        log(`Hint: ${getInstallHint(serverDef.installId)}`);
        if (!tsParser) {
          writeFileSync(statusFile, "error", "utf8");
          process.exit(1);
        }
        // If tree-sitter loaded, we can continue without LSP
        log("Continuing in tree-sitter-only mode (no LSP).");
      }
    } else {
      log(`LSP server not found: ${serverDef.installId}`);
      log(`Hint: ${getInstallHint(serverDef.installId)}`);
      if (!tsParser) {
        writeFileSync(statusFile, "error", "utf8");
        process.exit(1);
      }
      log("Continuing in tree-sitter-only mode (no LSP).");
    }
  }

  // ── 3. Build core objects ─────────────────────────────────────────────────

  const graph = new CodeGraph();

  const client = new LspClient({
    command:        serverDef.command.split(" ")[0],
    args:           [...serverDef.command.split(" ").slice(1), ...serverDef.args],
    rootPath,
    languageId:     serverDef.languageId,
    initTimeout:    30000,
    requestTimeout: 20000,
  });

  client.on("error", (err: Error) => log(`lsp error: ${err.message}`));

  const indexer = new Indexer(client, graph, rootPath, new Set(serverDef.extensions), log);
  if (tsParser) indexer.tsParser = tsParser;

  // ── 4. Collect files + build node graph with tree-sitter ──────────────────

  writeFileSync(statusFile, "indexing", "utf8");

  const files = indexer.collectFiles(fileLimit);
  log(`found ${files.length} source files (limit: ${fileLimit})`);

  await indexer.buildNodes(files, tsParser);

  // ── 5. Start socket server + file watcher → write "ready" ─────────────────

  const watcher = new FileWatcher(rootPath, serverDef.extensions, async (changedFile) => {
    writeFileSync(statusFile, "indexing", "utf8");
    await indexer.reindexFile(changedFile);
    writeFileSync(statusFile, "ready", "utf8");
  });

  const server = new DaemonServer(sockFile, graph, client, rootPath, () =>
    shutdown(client, server, watcher, indexer),
  );

  await server.listen();
  watcher.start();

  writeFileSync(statusFile, "ready", "utf8");
  log(`ready — ${graph.nodes.size} symbols indexed, listening on ${sockFile}`);

  // ── 6. Background: init LSP → diagnostics → reverse refs ─────────────────

  void (async () => {
    try {
      log("initializing LSP (background)…");
      await client.initialize();

      // Open all files so the LSP can provide diagnostics and references.
      for (const f of files) client.openFile(f);

      log("waiting for diagnostics…");
      await client.waitForDiagnostics(4000);

      indexer.snapshotDiagnostics(
        client.getDiagnostics() as Map<string, Diagnostic[]>,
      );

      server.lspReady = true;
      log("LSP ready — diagnostics and impact analysis available");

      // Phase 2: reverse refs (background within background)
      void indexer.buildReverseRefs();
    } catch (err) {
      log(`LSP background init failed (tree-sitter index still available): ${err}`);
    }
  })();

  // ── Signal handlers ───────────────────────────────────────────────────────

  process.on("SIGTERM", () => shutdown(client, server, watcher, indexer));
  process.on("SIGINT",  () => shutdown(client, server, watcher, indexer));
}

main().catch((err) => {
  log(`fatal: ${err}`);
  writeFileSync(statusFile, "error", "utf8");
  process.exit(1);
});
