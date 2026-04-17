/**
 * memory-md extension for pi.
 *
 * Manages the memory-md daemon lifecycle and exposes memory tools to the LLM.
 * The memory-md binary is used as-is — this extension only wraps it.
 *
 * Dir resolution (first match wins):
 *   1. MEMORY_MD_DIR env var (if already set in the environment)
 *   2. <current-directory>/.pi-memory (project-local default)
 *
 * Binary:  memory-md (must be in PATH)
 * Socket:  ~/.cache/memory-md/<sha256[:16] of MEMORY_MD_DIR>/channel.sock
 */

import { existsSync, openSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerTools } from "./tools.ts";

// ── Dir resolution ────────────────────────────────────────────────────────────

function resolveMemDir(cwd: string): string {
  return process.env.MEMORY_MD_DIR?.trim() || join(cwd, ".pi-memory");
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

type DaemonStatus = "starting" | "indexing" | "ready" | "stopped";

function getDaemonStatus(memDir: string): DaemonStatus {
  if (!existsSync(getSocketPath(memDir))) return "stopped";
  try {
    const r = spawnSync("memory-md", ["status"], {
      env: { ...process.env, MEMORY_MD_DIR: memDir },
      timeout: 2000,
      encoding: "utf8",
    });
    const out: string = r.stdout ?? "";
    if (out.includes("indexing: active")) return "indexing";
    if (out.includes("running")) return "ready";
  } catch {}
  return "stopped";
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

  const STATUS_LABEL: Record<DaemonStatus, (d: string) => string> = {
    starting: (d) => `☰ memory: starting… (${d})   `,
    indexing: (d) => `☰ memory: indexing… (${d})   `,
    ready:    (d) => `☰ memory: ready (${d})   `,
    stopped:  (d) => `☰ memory: stopped (${d})   `,
  };

  function updateFooter(): void {
    if (!uiCtx || !memDir) return;
    const status = getDaemonStatus(memDir);
    const shortDir = memDir.replace(homedir(), "~");
    uiCtx.setStatus("memory-md", STATUS_LABEL[status](shortDir));
  }

  function clearFooter(): void {
    uiCtx?.setStatus("memory-md", undefined);
  }

  function startPolling(): void {
    if (poller) return;
    poller = setInterval(updateFooter, 2000);
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


  // ── System prompt injection ──────────────────────────────────────────────

  const MEMORY_INSTRUCTION = `
## Memory discipline

The memory-md daemon is running. Memory files are the shared living context for all agents
and sessions — treat them as the authoritative record for this project.

**Never recall from training data.** Always query memory tools. If a search returns nothing,
state that explicitly and proceed fresh.

### Recall (before any work)

1. \`memory_search\` with terms relevant to the task
2. \`memory_get\` the exact path for any result worth reading in full
3. Apply what you find immediately — recalled decisions and constraints are binding

### Store (mandatory — do this or you are failing your job)

**After every response where you made a decision, chose an approach, discovered a constraint or pattern, or corrected prior information — you must persist it before replying.**

Hard triggers that require a memory write:
- You chose one approach over another
- You discovered how something works in this codebase
- You corrected a wrong assumption
- You completed a task that changed the project state

Before writing:
1. \`memory_search\` to check if a matching section already exists
2. Exists → \`memory_update\` (child sections are preserved)
3. Doesn't exist → \`memory_create_file\` if the file is new, then \`memory_new\`
4. After any write → \`memory_validate_file\` to check for duplicate paths, skipped heading levels, and multiple title headings

**Store:** decisions, constraints, architectural choices, discovered patterns, corrected assumptions.
**Do not store:** transient thoughts, step-by-step logs, anything irrelevant across sessions.

### File structure

One file per topic domain (e.g. \`project.md\`, \`architecture.md\`, \`decisions.md\`).
The filename (without \`.md\`) is always the first path segment — never derived from heading text.
\`#\` is a decorative title only — ignored for path derivation.
\`##\` and deeper headings become path segments (slugified: lowercase, spaces → \`-\`, non-alphanumeric stripped).
Example: \`auth.md\` + \`## API Keys\` → path \`auth/api-keys\`; \`### Rotation Policy\` → \`auth/api-keys/rotation-policy\`.
Body: concise and factual — reference material, not narrative.

### Flush (required before every reply)

Before writing your final response, run \`memory_search\` for anything decided or discovered that is not yet persisted. If anything is missing, store it first, then reply. Skipping this step is an error.
`.trim();

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: event.systemPrompt + "\n\n" + MEMORY_INSTRUCTION,
  }));

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  let isInteractive = false;

  pi.on("session_start", async (_event, ctx) => {
    // Always resolve memDir — tools must work in subagent sessions too.
    memDir = resolveMemDir(ctx.cwd);
    mkdirSync(memDir, { recursive: true });

    if (!ctx.hasUI) return;
    isInteractive = true;
    uiCtx = ctx.ui;

    killDaemon();
    if (poller) { clearInterval(poller); poller = undefined; }

    const shortDir = memDir.replace(homedir(), "~");
    // Always show starting — stale socket from a prior session can fool isDaemonRunning
    uiCtx.setStatus("memory-md", `☰ memory: starting… (${shortDir})   `);
    daemonChild = spawnDaemon(memDir);
    startPolling();
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    if (ctx.hasUI) uiCtx = ctx.ui;
  });

  pi.on("session_shutdown", async () => {
    if (!isInteractive) return;
    isInteractive = false;
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
        const status     = getDaemonStatus(memDir);
        const source     = process.env.MEMORY_MD_DIR ? "$MEMORY_MD_DIR" : "~/.pi/memory";
        const breadcrumb = readCacheDirBreadcrumb(memDir);
        const cacheDir   = getCacheDir(memDir);
        ctx.ui.notify(
          [
            `Status:    ${status}`,
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
