/**
 * Daemon entry point — spawned as a child process by the pi extension.
 *
 * Args:
 *   argv[2]  <rootPath>         absolute project root
 *   argv[3+] --auto-install     install missing LSP before starting
 *            --file-limit=<n>   max files for initial index (default 200)
 */

import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

import { LspClient } from "../lsp/client.ts";
import { detectServer } from "../lsp/registry.ts";
import { installServer, isInstalled, getInstallHint } from "../lsp/installer.ts";
import { getProjectDir, ensureDir } from "../paths.ts";
import { CodeGraph } from "./graph.ts";
import { Indexer } from "./indexer.ts";
import { DaemonServer } from "./server.ts";
import { FileWatcher } from "./watcher.ts";

// ── Args ──────────────────────────────────────────────────────────────────────

const rootPath = process.argv[2];
if (!rootPath) {
  process.stderr.write("usage: runner.ts <rootPath> [--auto-install] [--file-limit=N]\n");
  process.exit(1);
}

const autoInstall = process.argv.includes("--auto-install");
const fileLimitArg = process.argv.find((a) => a.startsWith("--file-limit="));
const fileLimit = fileLimitArg ? parseInt(fileLimitArg.split("=")[1], 10) || 200 : 200;

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

async function shutdown(client: LspClient, server: DaemonServer, watcher: FileWatcher, indexer: Indexer) {
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

  // ── 0. Auto-install ───────────────────────────────────────────────────────

  if (!isInstalled(serverDef.installId)) {
    if (autoInstall) {
      log(`LSP server not found (${serverDef.installId}), installing…`);
      try {
        await installServer(serverDef.installId, log);
        const updated = detectServer(rootPath);
        serverDef.command = updated.command;
      } catch (err) {
        log(`Auto-install failed: ${err}`);
        log(`Hint: ${getInstallHint(serverDef.installId)}`);
        writeFileSync(statusFile, "error", "utf8");
        process.exit(1);
      }
    } else {
      log(`LSP server not found: ${serverDef.installId}`);
      log(`Hint: ${getInstallHint(serverDef.installId)}`);
      writeFileSync(statusFile, "error", "utf8");
      process.exit(1);
    }
  }

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

  // ── 1. Init LSP ───────────────────────────────────────────────────────────

  writeFileSync(statusFile, "indexing", "utf8");
  log("initializing LSP...");
  try {
    await client.initialize();
  } catch (err) {
    log(`LSP init failed: ${err}`);
    writeFileSync(statusFile, "error", "utf8");
    process.exit(1);
  }

  // ── 2. Collect + open files ───────────────────────────────────────────────

  const files = indexer.collectFiles(fileLimit);
  log(`found ${files.length} source files (limit: ${fileLimit})`);
  for (const f of files) client.openFile(f);

  log("waiting for diagnostics...");
  await client.waitForDiagnostics(4000);

  // ── 3. Phase 1: build node graph ──────────────────────────────────────────

  await indexer.buildNodes(files);

  // ── 4. Snapshot diagnostics ───────────────────────────────────────────────

  indexer.snapshotDiagnostics(
    client.getDiagnostics() as Map<string, import("../lsp/protocol.ts").Diagnostic[]>,
  );

  // ── 5. Start socket server + file watcher ─────────────────────────────────

  const watcher = new FileWatcher(rootPath, serverDef.extensions, async (changedFile) => {
    await indexer.reindexFile(changedFile);
  });

  const server = new DaemonServer(sockFile, graph, client, rootPath, () =>
    shutdown(client, server, watcher, indexer),
  );

  await server.listen();
  watcher.start();

  writeFileSync(statusFile, "ready", "utf8");
  log(`ready — ${graph.nodes.size} symbols indexed, listening on ${sockFile}`);

  // ── 6. Background Phase 2: reverse refs ───────────────────────────────────

  void indexer.buildReverseRefs();

  // ── Signal handlers ───────────────────────────────────────────────────────

  process.on("SIGTERM", () => shutdown(client, server, watcher, indexer));
  process.on("SIGINT",  () => shutdown(client, server, watcher, indexer));
}

main().catch((err) => {
  log(`fatal: ${err}`);
  writeFileSync(statusFile, "error", "utf8");
  process.exit(1);
});
