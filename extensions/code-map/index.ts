/**
 * code-map extension for pi.
 *
 * Spawns a per-project LSP daemon on session start, exposes four LLM tools
 * (outline, symbol, diagnostics, impact), and shows daemon status in the footer.
 *
 * Config: ~/.pi/agent/code-map.json
 * Cache:  ~/.pi/cache/<encoded-project>/
 */

import { existsSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getProjectDir, ensureDir } from "./paths.ts";
import { registerTools } from "./tools.ts";

const EXTENSION_DIR  = dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT  = join(EXTENSION_DIR, "daemon", "runner.ts");
const CONFIG_PATH    = join(homedir(), ".pi", "agent", "code-map.json");

// ── Config ────────────────────────────────────────────────────────────────────

interface CodeMapConfig {
  /** Max files for initial indexing. Watcher covers all dirs regardless. Default: 200. */
  fileLimit: number;
}

const DEFAULT_CONFIG: CodeMapConfig = { fileLimit: 200 };

function loadConfig(): CodeMapConfig {
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<CodeMapConfig>;
    return {
      fileLimit: typeof raw.fileLimit === "number" && raw.fileLimit > 0
        ? raw.fileLimit
        : DEFAULT_CONFIG.fileLimit,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ── Daemon status ─────────────────────────────────────────────────────────────

function readStatus(projectDir: string): string {
  try { return readFileSync(join(projectDir, "codemap-daemon.status"), "utf-8").trim(); }
  catch { return "stopped"; }
}

function readLogTail(projectDir: string, lines = 50): string {
  const logFile = join(projectDir, "codemap-daemon.log");
  if (!existsSync(logFile)) return "(no log file)";
  try {
    const content = readFileSync(logFile, "utf-8");
    const all     = content.trimEnd().split("\n");
    return all.slice(-lines).join("\n");
  } catch { return "(could not read log)"; }
}

const STATUS_LABEL: Record<string, string> = {
  starting: "⬡ code-map: starting…   ",
  indexing: "⬡ code-map: indexing…   ",
  ready:    "⬡ code-map: ready   ",
  error:    "⬡ code-map: error   ",
  stopped:  "⬡ code-map: stopped   ",
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
  let projectDir:   string | undefined;
  let daemonChild:  ChildProcess | undefined;
  let poller:       ReturnType<typeof setInterval> | undefined;
  let uiCtx:        any;

  // ── Tools (rootPath closure) ──────────────────────────────────────────────

  registerTools(pi, () => projectRoot);

  // ── System instruction ───────────────────────────────────────────────────────────

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: event.systemPrompt + `

## Code intelligence (code-map)

Prefer code-map tools over grep / read / bash for structural understanding:
- Before editing a file → \`code_map_outline\`
- Finding a definition → \`code_map_symbol\` (add \`source:true\` to skip a separate read call)
- Checking for type errors → \`code_map_diagnostics\` with \`severity:1\` — scope to a \`file\` to reduce noise; omit \`file\` for full project diagnostics after cross-file changes or refactoring
- Before refactoring → \`code_map_impact\` to find all callers first

Natively indexed languages: TypeScript (\`.ts\`, \`.tsx\`), JavaScript (\`.js\`, \`.jsx\`, \`.mjs\`, \`.cjs\`), Python (\`.py\`), Go (\`.go\`), Zig (\`.zig\`), Lua (\`.lua\`).

All tools require a \`language\` parameter (one of: typescript, javascript, python, go, zig, lua). Passing an unsupported language returns a descriptive error. Fall back in order:
1. \`ptc\` with a Python uv script (PEP 723) — use language-specific AST libraries (e.g. \`tree_sitter\`, \`libcst\`) for structured parsing
2. \`ptc\` with a bash script using \`find\`, \`grep\`, \`awk\` — pattern-match function/class signatures directly`,
  }));


  // ── Footer helpers ────────────────────────────────────────────────────────

  function setFooterStatus(status: string): void {
    if (!uiCtx) return;
    uiCtx.setStatus("code-map", STATUS_LABEL[status] ?? `⬡ code-map: ${status}`);
  }

  function clearFooterStatus(): void {
    if (!uiCtx) return;
    uiCtx.setStatus("code-map", undefined);
  }

  function startPolling(): void {
    if (poller || !projectDir) return;
    poller = setInterval(() => {
      if (!projectDir) return;
      const status = readStatus(projectDir);
      setFooterStatus(status);
    }, 2000);
  }

  // ── Daemon spawn ──────────────────────────────────────────────────────────

  function spawnDaemon(root: string, config: CodeMapConfig): ChildProcess {
    const dir     = ensureDir(getProjectDir(root));
    const logPath = join(dir, "codemap-daemon.log");
    const logFd   = openSync(logPath, "a");

    const child = spawn(
      "bun",
      ["run", DAEMON_SCRIPT, root, "--auto-install", `--file-limit=${config.fileLimit}`],
      { stdio: ["ignore", logFd, logFd], detached: false },
    );
    child.on("error", (err) => {
      process.stderr.write(`[code-map] daemon spawn error: ${err.message}\n`);
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
    uiCtx = ctx.ui;

    // Resolve project root
    projectRoot = await resolveProjectRoot(ctx.cwd, pi.exec.bind(pi));
    projectDir  = getProjectDir(projectRoot);

    // Kill any leftover daemon from previous session
    killDaemon();
    if (poller) { clearInterval(poller); poller = undefined; }

    // Load config
    const config = loadConfig();

    // Set initial footer status — always "starting"; never trust stale status file
    setFooterStatus("starting");

    // Reset the status file so the poller doesn't read a stale "ready" from the
    // previous session and stop prematurely before the new daemon is actually up.
    try { writeFileSync(join(projectDir, "codemap-daemon.status"), "starting", "utf-8"); } catch {}

    // Spawn daemon async (fire and forget — don't block session start)
    daemonChild = spawnDaemon(projectRoot, config);

    // Start polling status → footer
    startPolling();
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    // Keep uiCtx fresh so footer updates work during tool calls
    uiCtx = ctx.ui;
  });

  pi.on("session_shutdown", async () => {
    if (poller) { clearInterval(poller); poller = undefined; }
    killDaemon();
    clearFooterStatus();
    projectRoot = undefined;
    projectDir  = undefined;
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

      if (!projectRoot || !projectDir) {
        ctx.ui.notify("code-map: no active project", "warning");
        return;
      }

      if (sub === "status" || sub === "") {
        const status = readStatus(projectDir);
        const cfg    = loadConfig();
        ctx.ui.notify(
          [
            `Status:     ${status}`,
            `Project:    ${projectRoot}`,
            `Socket:     ${join(projectDir, "codemap-daemon.sock")}`,
            `File limit: ${cfg.fileLimit}`,
          ].join("\n"),
          "info",
        );

      } else if (sub === "restart") {
        ctx.ui.notify("code-map: restarting daemon…", "info");
        if (poller) { clearInterval(poller); poller = undefined; }
        killDaemon();
        const config = loadConfig();
        setFooterStatus("starting");
        daemonChild = spawnDaemon(projectRoot, config);
        startPolling();

      } else if (sub === "logs") {
        const tail = readLogTail(projectDir);
        ctx.ui.notify(tail, "info");

      } else {
        ctx.ui.notify(`code-map: unknown sub-command "${sub}". Use: status | restart | logs`, "warning");
      }
    },
  });
}
