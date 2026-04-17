/**
 * memory-md extension for pi.
 *
 * Manages the memory-md daemon lifecycle and exposes memory tools to the LLM.
 * The memory-md binary is used as-is — this extension only wraps it.
 *
 * Dir resolution (first match wins):
 *   1. MEMORY_MD_DIR env var (if already set in the environment)
 *   2. ~/.pi/memory (global default)
 *
 * Binary:  memory-md (must be in PATH)
 * Socket:  ~/.cache/memory-md/<sha256[:16] of MEMORY_MD_DIR>/channel.sock
 */

import { existsSync, openSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerTools } from "./tools.ts";

// ── Dir resolution ────────────────────────────────────────────────────────────

function resolveMemDir(_cwd: string): string {
  return process.env.MEMORY_MD_DIR?.trim() || join(homedir(), ".pi", "memory");
}

// ── Cache path helpers ────────────────────────────────────────────────────────
// memory-md names its cache dir: first 16 hex chars of SHA-256(MEMORY_MD_DIR)

function getCacheDir(memDir: string): string {
  const hash = createHash("sha256").update(memDir).digest("hex").slice(0, 16);
  return join(homedir(), ".cache", "memory-md", hash);
}

function getSocketPath(memDir: string): string {
  return join(getCacheDir(memDir), "channel.sock");
}

function getLogPath(memDir: string): string {
  return join(getCacheDir(memDir), "daemon.log");
}

/** Read the `dir` breadcrumb file — confirms which MEMORY_MD_DIR owns this cache dir. */
function readCacheDirBreadcrumb(memDir: string): string | undefined {
  try { return readFileSync(join(getCacheDir(memDir), "dir"), "utf-8").trim(); }
  catch { return undefined; }
}

function isDaemonRunning(memDir: string): boolean {
  return existsSync(getSocketPath(memDir));
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let memDir:      string | undefined;
  let daemonChild: ChildProcess | undefined;
  let poller:      ReturnType<typeof setInterval> | undefined;
  let uiCtx:       any;

  // ── Tools ─────────────────────────────────────────────────────────────────

  registerTools(pi, () => memDir);

  // ── Footer helpers ────────────────────────────────────────────────────────

  function updateFooter(): void {
    if (!uiCtx || !memDir) return;
    const running = isDaemonRunning(memDir);
    uiCtx.setStatus("memory-md", running ? "☰ memory: running   " : "☰ memory: stopped   ");
  }

  function clearFooter(): void {
    uiCtx?.setStatus("memory-md", undefined);
  }

  function startPolling(): void {
    if (poller) return;
    poller = setInterval(() => {
      updateFooter();
      if (memDir && isDaemonRunning(memDir)) {
        clearInterval(poller);
        poller = undefined;
      }
    }, 2000);
  }

  // ── Daemon lifecycle ──────────────────────────────────────────────────────

  function spawnDaemon(dir: string): ChildProcess {
    mkdirSync(getCacheDir(dir), { recursive: true });
    const logFd = openSync(getLogPath(dir), "a");

    const child = spawn("memory-md", ["start-daemon"], {
      env:      { ...process.env, MEMORY_MD_DIR: dir },
      stdio:    ["ignore", logFd, logFd],
      detached: false,
    });

    child.on("error", (err) => {
      process.stderr.write(`[memory-md] daemon spawn error: ${err.message}\n`);
    });

    return child;
  }

  function killDaemon(): void {
    if (!daemonChild) return;
    try { daemonChild.kill("SIGTERM"); } catch (_) {}
    daemonChild = undefined;
  }

  // ── Events ────────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    uiCtx  = ctx.ui;
    memDir = resolveMemDir(ctx.cwd);
    mkdirSync(memDir, { recursive: true });

    killDaemon();
    if (poller) { clearInterval(poller); poller = undefined; }

    uiCtx.setStatus("memory-md", isDaemonRunning(memDir) ? "☰ memory: running   " : "☰ memory: starting…   ");
    daemonChild = spawnDaemon(memDir);
    startPolling();
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    uiCtx = ctx.ui;
  });

  pi.on("session_shutdown", async () => {
    if (poller) { clearInterval(poller); poller = undefined; }
    killDaemon();
    clearFooter();
    memDir = undefined;
    uiCtx  = undefined;
  });

  // ── /memory command ───────────────────────────────────────────────────────

  pi.registerCommand("memory", {
    description: "memory-md daemon management: status | restart | snapshot | logs",
    handler: async (args, ctx) => {
      uiCtx = ctx.ui;
      const sub = (args ?? "").trim().toLowerCase();

      if (!memDir) {
        ctx.ui.notify("memory-md: not initialised yet.", "warning");
        return;
      }

      if (sub === "status" || sub === "") {
        const running    = isDaemonRunning(memDir);
        const source     = process.env.MEMORY_MD_DIR ? "$MEMORY_MD_DIR" : "~/.pi/memory";
        const breadcrumb = readCacheDirBreadcrumb(memDir);
        const cacheDir   = getCacheDir(memDir);
        ctx.ui.notify(
          [
            `Status:    ${running ? "running" : "stopped"}`,
            `Dir:       ${memDir}  (${source})`,
            `Cache:     ${cacheDir}`,
            breadcrumb ? `Confirmed: ${breadcrumb}` : "",
            `Socket:    ${getSocketPath(memDir)}`,
          ].filter(Boolean).join("\n"),
          "info",
        );

      } else if (sub === "restart") {
        ctx.ui.notify("memory-md: restarting daemon…", "info");
        if (poller) { clearInterval(poller); poller = undefined; }
        killDaemon();
        memDir = resolveMemDir(ctx.cwd);
        mkdirSync(memDir, { recursive: true });
        uiCtx.setStatus("memory-md", "☰ memory: starting…   ");
        daemonChild = spawnDaemon(memDir);
        startPolling();

      } else if (sub === "snapshot") {
        const result = await pi.exec(
          "bash",
          ["-c", `MEMORY_MD_DIR='${memDir.replace(/'/g, "'\\''")}' memory-md snapshot`],
          { timeout: 15_000 },
        );
        ctx.ui.notify(
          result.code === 0
            ? `Snapshot created:\n${result.stdout.trim()}`
            : `Error: ${result.stderr || result.stdout}`,
          result.code === 0 ? "info" : "error",
        );

      } else if (sub === "logs") {
        const logPath = getLogPath(memDir);
        if (!existsSync(logPath)) {
          ctx.ui.notify("(no log file yet)", "info");
          return;
        }
        try {
          const lines = readFileSync(logPath, "utf-8").trimEnd().split("\n");
          ctx.ui.notify(lines.slice(-50).join("\n"), "info");
        } catch {
          ctx.ui.notify("(could not read log)", "warning");
        }

      } else {
        ctx.ui.notify(
          `memory: unknown sub-command "${sub}". Use: status | restart | snapshot | logs`,
          "warning",
        );
      }
    },
  });
}
