/**
 * Daemon entry point — spawned as a child process by the pi extension.
 *
 * argv[2]  <memDir>       absolute path to the memory directory (.pi/memory)
 * argv[3]  <cacheDir>     absolute path to cache directory (for DB)
 * argv[4]  <cwd>          current working directory (for temp paths)
 *
 * Startup sequence:
 *   1. Write pid + status files
 *   2. Open SQLite DB, load sqlite-vec, apply schema
 *   3. Optionally spawn Python embedding sidecar (Apple Silicon + uv only)
 *   4. Walk memDir, index all .md files (mtime-gated)
 *   5. Start socket server + file watcher, write "ready"
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync, openSync } from "node:fs";
import type { ChildProcess } from "node:child_process";

import {
  getSocketPath, getSidecarSocketPath,
  getDbPath, getLogPath, getPidPath, getStatusPath,
  getEmbedScriptPath,
} from "../paths.ts";
import { MemoryDB } from "./db.ts";
import { Indexer } from "./indexer.ts";
import { DaemonServer } from "./server.ts";
import { FileWatcher } from "./watcher.ts";
import { isAppleSilicon, isUvAvailable, spawnSidecar, waitForSidecar } from "../sidecar/index.ts";

const memDir   = process.argv[2];
const cacheDir = process.argv[3];
const cwd      = process.argv[4];

if (!memDir || !cacheDir || !cwd) {
  process.stderr.write("usage: runner.ts <memDir> <cacheDir> <cwd>\n");
  process.exit(1);
}

const sockPath    = getSocketPath(cwd);
const sidecarSock = getSidecarSocketPath(cwd);
const dbPath      = getDbPath(cacheDir);
const logPath     = getLogPath(cwd);
const pidPath     = getPidPath(cwd);
const statusPath  = getStatusPath(cwd);

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
  
  if (sidecarChild) {
    const pid = sidecarChild.pid;
    log(`sending SIGTERM to sidecar (pid ${pid})`);
    try {
      sidecarChild.kill("SIGTERM");
      // Wait up to 1s for sidecar to exit
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          log(`sidecar did not exit, sending SIGKILL (pid ${pid})`);
          try {
            sidecarChild?.kill("SIGKILL");
          } catch (err) {
            log(`SIGKILL failed: ${err}`);
          }
          resolve();
        }, 1000);
        sidecarChild!.once("exit", (code, signal) => {
          clearTimeout(timeout);
          log(`sidecar exited (pid ${pid}, code ${code}, signal ${signal})`);
          resolve();
        });
      });
    } catch (err) {
      log(`error killing sidecar: ${err}`);
    }
  }
  
  db.close();
  try {
    const stored = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    if (stored === process.pid) {
      try { unlinkSync(sockPath); } catch (err) { log(`error unlinking socket: ${err}`); }
      try { unlinkSync(pidPath); } catch (err) { log(`error unlinking pid: ${err}`); }
    }
  } catch (err) {
    log(`error reading pid file: ${err}`);
  }
  log("shutdown complete");
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
    sidecarChild.on("exit", (code, signal) => {
      if (!shuttingDown) {
        log(`sidecar exited unexpectedly (code ${code}, signal ${signal})`);
      }
    });
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
