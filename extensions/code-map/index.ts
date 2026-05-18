/**
 * code-map extension for pi.
 *
 * Spawns a per-project LSP daemon on session start, exposes four LLM tools
 * (outline, symbol, diagnostics, impact), and shows daemon status in the footer.
 *
 * Config: ~/.pi/agent/code-map.json
 * Cache:  ~/.pi/cache/pi-code-projects/<sha256[:16] of project root>/
 */

import { existsSync, readFileSync, writeFileSync, openSync, closeSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getProjectDir, ensureDir, getLspDir, getTreeSitterDir } from "./paths.ts";
import { registerTools } from "./tools.ts";
import { getConfig, getDaemonSocketPath, getProjectTempDir, getExtensionTempDir, createLogger } from "../_config/index.ts";

const EXTENSION_DIR  = dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT  = join(EXTENSION_DIR, "daemon", "runner.ts");

const DEFAULT_FILE_LIMIT = 200;

function getFileLimit(): number {
  const limit = getConfig().codeMap?.fileLimit;
  return typeof limit === "number" && limit > 0 ? limit : DEFAULT_FILE_LIMIT;
}

// ── Logger ────────────────────────────────────────────────────────────────────

let debug: (...args: unknown[]) => void = () => {};

// ── Daemon status ─────────────────────────────────────────────────────────────

function readStatus(rootPath: string): string {
  try { 
    const statusPath = join(getProjectTempDir(rootPath), "code-map", "daemon.status");
    return readFileSync(statusPath, "utf-8").trim(); 
  }
  catch { return "stopped"; }
}

function readLogTail(rootPath: string, lines = 50): string {
  const logFile = join(getProjectTempDir(rootPath), "code-map", "logfile.log");
  if (!existsSync(logFile)) return "(no log file)";
  try {
    const content = readFileSync(logFile, "utf-8");
    const all     = content.trimEnd().split("\n");
    return all.slice(-lines).join("\n");
  } catch { return "(could not read log)"; }
}

const STATUS_LABEL: Record<string, string> = {
  starting: "| code-map: starting…",
  indexing: "| code-map: indexing…",
  ready:    "| code-map: ready",
  error:    "| code-map: error",
  stopped:  "| code-map: stopped",
};

// ── Project root resolution ───────────────────────────────────────────────────

async function resolveProjectRoot(cwd: string, exec: ExtensionAPI["exec"]): Promise<string> {
  try {
    const result = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 3000 });
    if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
  } catch {}
  return cwd;
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let projectRoot:  string | undefined;
  let daemonChild:  ChildProcess | undefined;
  let poller:       ReturnType<typeof setInterval> | undefined;
  let uiCtx:        any;
  let ownsDaemon    = false; // true only if this session spawned the daemon

  // ── Tools (rootPath closure) ──────────────────────────────────────────────

  registerTools(pi, () => projectRoot);

  // ── System instruction ───────────────────────────────────────────────────────────

  pi.on("before_agent_start", async (event) => {
    if (getConfig().codeMap?.enabled === false) return {};
    return {
    systemPrompt: event.systemPrompt + `

## Code intelligence (code-map) — always use, never skip

code-map is indexed and ready. For TypeScript, JavaScript, Python, and Go these tools are **mandatory** — do not use \`read\`, \`grep\`, \`ffgrep\`, or \`bash\` to understand code structure when a code-map tool applies.

| Task | Tool | Do NOT use |
|------|------|------------|
| Understand a file before editing | \`code_map_outline\` | \`read\` + scanning |
| Find a symbol definition | \`code_map_symbol\` + \`source:true\` | \`ffgrep\`, \`grep\` |
| Check type errors / warnings | \`code_map_diagnostics\` (severity:1) | \`bash tsc\` / \`bash go build\` |
| Before changing any function or type | \`code_map_impact\` — always | \`ffgrep\` for callers |

All tools require a \`language\` parameter: typescript | javascript | python | go.
For other languages fall back to \`ptc\` with a tree-sitter or AST library.`,
    };
  });


  // ── Footer helpers ────────────────────────────────────────────────────────

  function setFooterStatus(status: string): void {
    if (!uiCtx) return;
    uiCtx.setStatus("code-map", STATUS_LABEL[status] ?? `| code-map: ${status}`);
  }

  function clearFooterStatus(): void {
    if (!uiCtx) return;
    uiCtx.setStatus("code-map", undefined);
  }

  function startPolling(): void {
    if (poller || !projectRoot) return;
    poller = setInterval(() => {
      if (!projectRoot) return;
      // If the status file claims ready but the socket is gone, the daemon
      // died unexpectedly (e.g. killed by an old session_shutdown racing with
      // this session's start).  Show "stopped" so the footer is accurate.
      const raw    = readStatus(projectRoot);
      const sock   = getDaemonSocketPath("code-map", projectRoot);
      const status = (raw === "ready" || raw === "indexing" || raw === "starting")
        && !existsSync(sock) ? "stopped" : raw;
      setFooterStatus(status);
    }, 2000);
  }

  // ── Daemon spawn ──────────────────────────────────────────────────────────

  function spawnDaemon(root: string, fileLimit: number): ChildProcess {
    const cacheDir = ensureDir(getProjectDir(root));
    const tempDir  = getProjectTempDir(root);
    const extDir   = join(tempDir, "code-map");
    mkdirSync(extDir, { recursive: true });
    const logPath  = join(extDir, "logfile.log");
    const logFd    = openSync(logPath, "a");

    const child = spawn(
      "node",
      [DAEMON_SCRIPT, root, "--auto-install", `--file-limit=${fileLimit}`],
      { stdio: ["ignore", logFd, logFd], detached: false },
    );
    closeSync(logFd);
    child.on("error", (err) => {
      debug(`daemon spawn error: ${err.message}`);
    });
    return child;
  }

  function killDaemon(): void {
    if (!daemonChild) return;
    try { daemonChild.kill("SIGTERM"); } catch (_) {}
    daemonChild = undefined;
  }

  /** Kill any orphaned daemon left by a previous process (reads PID file). */
  function killOrphan(): void {
    if (!projectRoot) return;
    const pidPath = join(getProjectTempDir(projectRoot), "code-map", "daemon.pid");
    try {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (pid > 0) process.kill(pid, "SIGTERM");
    } catch (_) { /* no pid file or process already gone */ }
  }

  // ── Events ────────────────────────────────────────────────────────────────

  pi.on("session_start", async (event: any, ctx) => {
    getExtensionTempDir("code-map", ctx.cwd);
    uiCtx = ctx.ui;

    // Initialize logger
    const logger = createLogger("code-map", ctx.cwd);
    logger.truncate();
    debug = logger.log;

    // Resolve project root
    projectRoot = await resolveProjectRoot(ctx.cwd, pi.exec.bind(pi));
    debug(`project root: ${projectRoot}`);

    if (getConfig().codeMap?.enabled === false) {
      debug("code-map disabled in config");
      return;
    }

    // ── Client-only guard (subagents only) ────────────────────────────────────
    // Subagent sessions connect to the running daemon; they must not spawn or
    // kill it.  The only reliable signal is the explicit flag passed from
    // agent-runner.ts via bindExtensions({ subagentMode: true }).
    //
    // The old "socket-exists" fallback has been intentionally removed: on pi
    // restart both the old and new sessions exist briefly.  The fallback caused
    // the new (primary) session to enter client-only mode just as the old
    // session's session_shutdown killed the daemon, leaving the primary session
    // permanently stuck with no daemon and no recovery path.
    if (event?.subagentMode) {
      ownsDaemon = false;
      debug("subagent mode: client-only");
      setFooterStatus(readStatus(projectRoot));
      startPolling();
      return;
    }

    // ── Primary session: manage daemon lifecycle ─────────────────────────────
    // Kill our own child (if any) and any orphaned daemon left by a crashed
    // previous process (PID file) before spawning a fresh one.
    debug("primary session: managing daemon lifecycle");
    killDaemon();
    killOrphan();
    if (poller) { clearInterval(poller); poller = undefined; }

    ownsDaemon = true;

    // Set initial footer status — always "starting"; never trust stale status file
    setFooterStatus("starting");

    // Reset the status file so the poller doesn't read a stale "ready" from the
    // previous session and stop prematurely before the new daemon is actually up.
    try { 
      const statusPath = join(getProjectTempDir(projectRoot), "code-map", "daemon.status");
      writeFileSync(statusPath, "starting", "utf-8"); 
    } catch {}

    // Spawn daemon async (fire and forget — don't block session start)
    debug(`spawning daemon with file limit ${getFileLimit()}`);
    daemonChild = spawnDaemon(projectRoot, getFileLimit());

    // Start polling status → footer
    startPolling();
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    // Keep uiCtx fresh so footer updates work during tool calls
    uiCtx = ctx.ui;
  });

  pi.on("session_shutdown", async () => {
    debug("session_shutdown");
    if (poller) { clearInterval(poller); poller = undefined; }
    if (ownsDaemon) {
      debug("killing owned daemon");
      killDaemon();
    }
    ownsDaemon = false;
    clearFooterStatus();
    projectRoot = undefined;
    uiCtx       = undefined;
  });

  // ── /code-map command ─────────────────────────────────────────────────────

  pi.registerCommand("code-map", {
    description: "code-map daemon management: status | restart | logs",
    getArgumentCompletions: (prefix: string) => {
      const subs = ["status", "restart", "logs"];
      const matches = subs
        .filter((s) => s.startsWith(prefix.toLowerCase()))
        .map((s) => ({ value: s, label: s }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      uiCtx = ctx.ui;
      const sub = (args ?? "").trim().toLowerCase();

      if (!projectRoot) {
        ctx.ui.notify("code-map: no active project", "warning");
        return;
      }

      if (sub === "status" || sub === "") {
        const sockPath = getDaemonSocketPath("code-map", projectRoot);
        const alive    = existsSync(sockPath);
        const status   = alive ? readStatus(projectRoot) : "stopped (socket missing)";
        ctx.ui.notify(
          [
            `Status:     ${status}`,
            `Project:    ${projectRoot}`,
            `Socket:     ${sockPath}${alive ? "" : " (missing)"}`,
            `File limit: ${getFileLimit()}`,
          ].join("\n"),
          alive ? "info" : "warning",
        );

      } else if (sub === "restart") {
        ctx.ui.notify("code-map: restarting daemon…", "info");
        if (poller) { clearInterval(poller); poller = undefined; }
        killDaemon();
        setFooterStatus("starting");
        daemonChild = spawnDaemon(projectRoot, getFileLimit());
        startPolling();

      } else if (sub === "logs") {
        const tail = readLogTail(projectRoot);
        ctx.ui.notify(tail, "info");

      } else {
        ctx.ui.notify(`code-map: unknown sub-command "${sub}". Use: status | restart | logs`, "warning");
      }
    },
  });

  // ── /code-map-clean command ───────────────────────────────────────────────

  pi.registerCommand("code-map-clean", {
    description: "Clean code-map artifacts: lsp-binaries | tree-sitter-binaries | (no arg = current project)",
    getArgumentCompletions: (prefix: string) => {
      const subs = ["lsp-binaries", "tree-sitter-binaries"];
      const matches = subs
        .filter((s) => s.startsWith(prefix.toLowerCase()))
        .map((s) => ({ value: s, label: s }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      uiCtx = ctx.ui;
      const sub = (args ?? "").trim().toLowerCase();
      if (sub === "") {
        // ── Current project cache ─────────────────────────────────────────
        if (!projectRoot) {
          ctx.ui.notify("code-map: no active project", "warning");
          return;
        }
        const projectCacheDir = getProjectDir(projectRoot);
        if (!existsSync(projectCacheDir)) {
          ctx.ui.notify("code-map: project cache is already empty", "info");
          return;
        }
        const ok = await ctx.ui.confirm(
          "Clean project cache?",
          `Delete ${projectCacheDir}\n\nRemoves the index and daemon state for this project. The index will be rebuilt on next session start.`,
        );
        if (!ok) return;
        if (poller) { clearInterval(poller); poller = undefined; }
        killDaemon();
        clearFooterStatus();
        let deleteError: unknown;
        try {
          rmSync(projectCacheDir, { recursive: true, force: true });
        } catch (err) {
          deleteError = err;
          ctx.ui.notify(`code-map: cache deletion failed — ${err}`, "error");
        } finally {
          try {
            setFooterStatus("starting");
            daemonChild = spawnDaemon(projectRoot, getFileLimit());
            ownsDaemon = true;
            startPolling();
            if (!deleteError) {
              ctx.ui.notify("Project cache cleared — daemon restarting…", "info");
            }
          } catch (err) {
            ctx.ui.notify(`code-map: daemon restart failed — ${err}`, "error");
          }
        }

      } else if (sub === "lsp-binaries") {
        // ── LSP binaries ─────────────────────────────────────────────────
        const lspDir = getLspDir();
        if (!existsSync(lspDir)) {
          ctx.ui.notify("code-map: LSP binaries directory does not exist", "info");
          return;
        }
        const ok = await ctx.ui.confirm(
          "Remove LSP binaries?",
          `Delete ${lspDir}\n\nLanguage servers will be re-downloaded on next use.`,
        );
        if (!ok) return;
        if (poller) { clearInterval(poller); poller = undefined; }
        killDaemon();
        clearFooterStatus();
        try {
          rmSync(lspDir, { recursive: true, force: true });
        } catch (err) {
          ctx.ui.notify(`code-map: LSP binary deletion failed — ${err}`, "error");
        } finally {
          // Restart in tree-sitter-only mode; LSP servers will be re-downloaded on next install
          if (projectRoot) {
            try {
              setFooterStatus("starting");
              daemonChild = spawnDaemon(projectRoot, getFileLimit());
              ownsDaemon = true;
              startPolling();
              ctx.ui.notify("LSP binaries removed — daemon restarting in tree-sitter-only mode.", "info");
            } catch (err) {
              ctx.ui.notify(`code-map: daemon restart failed — ${err}`, "error");
            }
          } else {
            ctx.ui.notify("LSP binaries removed.", "info");
          }
        }

      } else if (sub === "tree-sitter-binaries") {
        // ── tree-sitter binaries ─────────────────────────────────────────
        const tsDir = getTreeSitterDir();
        if (!existsSync(tsDir)) {
          ctx.ui.notify("code-map: tree-sitter directory does not exist", "info");
          return;
        }
        const ok = await ctx.ui.confirm(
          "Remove tree-sitter binaries?",
          `Delete ${tsDir}\n\nGrammar packages will be re-installed on next use.`,
        );
        if (!ok) return;
        if (poller) { clearInterval(poller); poller = undefined; }
        killDaemon();
        clearFooterStatus();
        try {
          rmSync(tsDir, { recursive: true, force: true });
        } catch (err) {
          ctx.ui.notify(`code-map: tree-sitter deletion failed — ${err}`, "error");
        } finally {
          // Restart in LSP-only mode; grammars will be re-installed on next use
          if (projectRoot) {
            try {
              setFooterStatus("starting");
              daemonChild = spawnDaemon(projectRoot, getFileLimit());
              ownsDaemon = true;
              startPolling();
              ctx.ui.notify("tree-sitter binaries removed — daemon restarting in LSP-only mode.", "info");
            } catch (err) {
              ctx.ui.notify(`code-map: daemon restart failed — ${err}`, "error");
            }
          } else {
            ctx.ui.notify("tree-sitter binaries removed.", "info");
          }
        }

      } else {
        ctx.ui.notify(
          `code-map-clean: unknown argument "${sub}". Use: lsp-binaries | tree-sitter-binaries | (empty for current project)`,
          "warning",
        );
      }
    },
  });
}
