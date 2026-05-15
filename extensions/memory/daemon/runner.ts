/**
 * Daemon entry point — spawned as a child process by the pi extension.
 *
 * argv[2]  <memDir>       absolute path to the memory directory (.pi/memory)
 * argv[3]  <projectRoot>  absolute project root
 *
 * Startup sequence:
 *   1. Write pid + status files
 *   2. Open SQLite DB, load sqlite-vec, apply schema
 *   3. Optionally spawn Python embedding sidecar (Apple Silicon + uv only)
 *   4. Walk memDir, index all .md files (mtime-gated)
 *   5. Start socket server + file watcher, write "ready"
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync, openSync } from "node:fs";
import { resolve } from "node:path";
import type { ChildProcess } from "node:child_process";

import {
  getSocketPath, getSidecarSocketPath,
  getDbPath, getLogPath, getPidPath, getStatusPath,
  getEmbedScriptPath,
} from "../paths.ts";
import { getProjectCacheDir } from "../../_config/index.ts";
import { MemoryDB } from "./db.ts";
import { Indexer } from "./indexer.ts";
import { DaemonServer } from "./server.ts";
import { FileWatcher } from "./watcher.ts";
import { isAppleSilicon, isUvAvailable, spawnSidecar, waitForSidecar } from "../sidecar/index.ts";

const memDir      = process.argv[2];
const projectRoot = process.argv[3];

if (!memDir || !projectRoot) {
  process.stderr.write("usage: runner.ts <memDir> <projectRoot>\n");
  process.exit(1);
}

// Validates dir.txt and ensures the cache dir exists
getProjectCacheDir(resolve(projectRoot));

const sockPath    = getSocketPath(projectRoot);
const sidecarSock = getSidecarSocketPath(projectRoot);
const dbPath      = getDbPath(projectRoot);
const logPath     = getLogPath(projectRoot);
const pidPath     = getPidPath(projectRoot);
const statusPath  = getStatusPath(projectRoot);

const embedScript = getEmbedScriptPath();

function log(msg: string): void {
  process.stderr.write(`[memory] ${msg}\n`);
}

writeFileSync(pidPath, String(process.pid), "utf8");
writeFileSync(statusPath, "starting", "utf8");
if (existsSync(sockPath)) { try { unlinkSync(sockPath); } catch (_) {} }

let sidecarChild: ChildProcess | undefined;
let shuttingDown = false;

async function shutdown(server: DaemonServer, watcher: FileWatcher, db: MemoryDB): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down");
  watcher.stop();
  writeFileSync(statusPath, "stopped", "utf8");
  await server.close();
  if (sidecarChild) { try { sidecarChild.kill("SIGTERM"); } catch (_) {} }
  db.close();
  try {
    const stored = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    if (stored === process.pid) {
      try { unlinkSync(sockPath); } catch (_) {}
      try { unlinkSync(pidPath); } catch (_) {}
    }
  } catch (_) {}
  process.exit(0);
}

async function main(): Promise<void> {
  const db = new MemoryDB(dbPath);
  log(`database opened: ${dbPath}`);

  // Optionally spawn embedding sidecar (non-blocking)
  const canUseSidecar = isAppleSilicon() && isUvAvailable();
  if (canUseSidecar) {
    log("spawning embedding sidecar (mlx-embeddings)…");
    const logFd = openSync(logPath, "a");
    sidecarChild = spawnSidecar(embedScript, sidecarSock, logFd);
    sidecarChild.on("error", (err) => log(`sidecar spawn error: ${err.message}`));
    void waitForSidecar(sidecarSock, 30_000).then((ready) => {
      log(ready ? "sidecar ready (vector search enabled)" : "sidecar timed out (FTS5-only mode)");
    });
  } else {
    log(`sidecar skipped (Apple Silicon: ${isAppleSilicon()}, uv: ${isUvAvailable()}) — FTS5-only mode`);
  }

  // Index all .md files
  writeFileSync(statusPath, "indexing", "utf8");
  const indexer = new Indexer(memDir, db, sidecarSock, log);
  await indexer.indexAll();
  log(`initial index complete`);

  // Start server and file watcher
  const server = new DaemonServer(
    sockPath, memDir, db, indexer, sidecarSock,
    () => { void shutdown(server, watcher, db); },
  );

  const watcher = new FileWatcher(
    memDir,
    // onChanged — file created or modified
    async (changedPath) => {
      writeFileSync(statusPath, "indexing", "utf8");
      await indexer.indexFile(changedPath);
      writeFileSync(statusPath, "ready", "utf8");
    },
    // onDeleted — file removed or renamed away
    (deletedPath) => {
      const fileName = deletedPath.split("/").pop()?.replace(/\.md$/, "") ?? "";
      if (fileName) {
        db.deleteFile(fileName);
        log(`removed deleted file from index: ${fileName}.md`);
      }
    },
  );

  await server.listen();
  watcher.start();

  writeFileSync(statusPath, "ready", "utf8");
  log(`ready — listening on ${sockPath}`);

  process.on("SIGTERM", () => { void shutdown(server, watcher, db); });
  process.on("SIGINT",  () => { void shutdown(server, watcher, db); });
  process.on("SIGHUP",  () => { void shutdown(server, watcher, db); });
}

main().catch((err) => {
  log(`fatal: ${err}`);
  writeFileSync(statusPath, "error", "utf8");
  process.exit(1);
});
