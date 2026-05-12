/**
 * memory-md extension for pi.
 *
 * Manages the memory-md daemon lifecycle and exposes memory tools to the LLM.
 * The memory-md binary is used as-is — this extension only wraps it.
 *
 * Dir resolution (first match wins):
 *   1. MEMORY_MD_DIR env var (if already set in the environment)
 *   2. <git-root>/.pi-memory (if cwd is inside a git repository)
 *   3. <current-directory>/.pi-memory (project-local default)
 *
 * Binary:  memory-md (must be in PATH)
 * Socket:  ~/.cache/memory-md/<sha256[:16] of MEMORY_MD_DIR>/channel.sock
 */

import { existsSync, openSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { registerTools, run, runWithInput, type ExecFn } from "./tools.ts";

// ── Dir resolution ────────────────────────────────────────────────────────────

function resolveMemDir(cwd: string): string {
  if (process.env.MEMORY_MD_DIR?.trim()) return process.env.MEMORY_MD_DIR.trim();
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8" });
  if (result.status === 0) return join(result.stdout.trim(), ".pi-memory");
  return join(cwd, ".pi-memory");
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

// ── Workflow log helpers ─────────────────────────────────────────────────────

interface WorkflowLogConfig {
  enabled: boolean;
  model: string; // "provider/modelId"
}

function loadWorkflowLogConfig(): WorkflowLogConfig | null {
  try {
    const configPath = join(homedir(), ".pi", "agent", "pi-code.json");
    if (!existsSync(configPath)) return null;
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const wl = raw?.workflowLog;
    if (!wl?.enabled || !wl?.model) return null;
    return { enabled: true, model: wl.model };
  } catch {
    return null;
  }
}

async function appendWorkflowEntry(memDir: string, title: string, body: string, ts: Date, execFn: ExecFn): Promise<void> {
  const pad = (n: number) => String(n).padStart(2, "0");
  const hh = pad(ts.getHours()); const mm = pad(ts.getMinutes()); const ss = pad(ts.getSeconds());
  const dateStr    = `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())}`;  // local "2026-05-12"
  const timeSlug   = `${hh}-${mm}-${ss}`;                                                    // local "14-23-05"
  const displayTime = `${hh}:${mm}`;                                                         // local "14:23"

  // 1. Ensure workflow.md file exists
  try {
    await run(memDir, ["create-file", "workflow", "Workflow"], execFn);
  } catch (err: any) {
    if (!err.message?.includes("already exists")) throw err;
  }

  // 2. Ensure ## YYYY-MM-DD date section exists
  try {
    await runWithInput(memDir, ["new", `workflow/${dateStr}`, "--heading", dateStr], "");
  } catch (err: any) {
    if (!err.message?.includes("already exists")) throw err;
  }

  // 3. Create ### HH:MM — title entry
  await runWithInput(
    memDir,
    ["new", `workflow/${dateStr}/${timeSlug}`, "--heading", `${displayTime} \u2014 ${title}`],
    body,
  );
}

async function callModelForSummary(
  modelStr: string,
  prompt: string,
  ctx: any,
  cwd: string,
): Promise<string> {
  const [provider, ...rest] = modelStr.split("/");
  const modelId = rest.join("/");
  const model = ctx.modelRegistry?.find(provider, modelId) ?? ctx.model;
  if (!model) return "";

  const agentDirPath = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: agentDirPath,
    settingsManager: SettingsManager.create(cwd, agentDirPath),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "You are a concise technical log writer. Respond only with the requested log entry \u2014 no preamble.",
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir: agentDirPath,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.create(cwd, agentDirPath),
    modelRegistry: ctx.modelRegistry,
    model,
    resourceLoader: loader,
  });

  await (session as any).bindExtensions({});

  await session.prompt(prompt);

  // Extract last assistant text
  const messages: any[] = (session as any).messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    const text = content
      .filter((b: any) => b.type === "text" && b.text)
      .map((b: any) => b.text as string)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
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

> **RUN BEFORE EVERY REPLY — mandatory checklist:**
> 1. Did I discover, decide, or correct anything this turn? **YES → \`memory_search\` then write now.** NO → skip.
> 2. Did I write to memory? **YES → ensure validation happened now.** If you used \`memory_new\` / \`memory_update\`, read their validation output. Otherwise run \`memory_validate_file\`. NO → skip.
> 3. Run \`memory_search\` one more time to confirm nothing was missed.
>
> Skipping this = failing your job.

memory-md is a persistent, markdown-backed memory store. The markdown files are the source of
truth; the daemon indexes them for fast lookup and search. Treat memory files as the authoritative
shared context for this project.

Memory writes mutate the markdown files first. The daemon watcher updates the index afterward, so
very recent writes may take a brief moment to appear in search results.

**Never recall from training data.** Always query memory tools. If a search returns nothing,
state that explicitly and proceed fresh.

### Recall (before any work)

1. \`memory_search\` with terms relevant to the task
2. \`memory_get\` the exact path for any result worth reading in full
3. Apply what you find immediately — recalled decisions and constraints are binding

### Store — hard triggers

You **MUST** call a memory write tool if **ANY** of these are true this turn:

- [ ] You chose one approach over another
- [ ] You discovered how something works in this codebase
- [ ] You corrected a wrong assumption
- [ ] You completed a task that changed the project state

**How to store:**
1. \`memory_search\` — check if a matching section already exists
2. Exists → \`memory_update\` (replaces only the immediate body — the text between the section heading and its first child heading; child sections are preserved unchanged and must NOT be included in the body parameter)
3. Missing → \`memory_create_file\` if the file is new, then \`memory_new\`
4. \`memory_create_file\` requires a file name and human title, with an optional description for the file-level preamble
5. \`memory_new\` / \`memory_update\` already validate after writing and may surface validation errors; these do not roll back the write
6. For other write paths — especially direct \`edit\` or manual recovery — run \`memory_validate_file\` explicitly
7. If validation fails or update doesn't work: \`read\` the .md file directly, fix with \`edit\` tool, then validate again

**Structural corruption recovery:**
- If \`memory_update\` succeeds but content looks wrong: file structure is corrupted (duplicate sections, malformed headings)
- Memory directory: \`$MEMORY_MD_DIR\` (if set) or \`.pi-memory/\` (default)
- Fix: \`read $MEMORY_MD_DIR/<file>.md\` (or \`.pi-memory/<file>.md\` when using the default local dir), identify structural issues, use \`edit\` tool to fix, then \`memory_validate_file\`
- The daemon watches files and auto-reindexes after direct edits — this is a supported recovery path

**Store:** decisions, constraints, architectural choices, discovered patterns, corrected assumptions.
**Do not store:** transient thoughts, step-by-step logs, anything irrelevant across sessions.

### File structure

#### Canonical files (use these by default)

| File | Purpose |
|------|---------|
| \`architecture.md\` | Project architecture, tech stack, codebase reference, constraints. |
| \`project.md\` | Categorised natural language description of the project, its goals, and scope. Technical jargons go to architecture. |
| \`setup.md\` | Development setup, dependencies, configuration. |
| \`decisions.md\` | Decisions made during the project — rationale and alternatives considered. |
| \`notes.md\` | Arbitrary notes — challenges faced, lessons learned, future considerations. |
| \`workflow.md\` | **Read-only.** Auto-generated activity log — timestamped entries written after every agent loop. Use \`memory_search\` or \`memory_get\` to recall past work. Do not write to this file manually. |

Always prefer a canonical file over creating a new one. Create additional files only when the content clearly does not belong in any canonical file and the new topic domain is substantial enough to warrant its own file.

#### File format rules

- Filename (without \`.md\`) is always the first path segment — never derived from heading text
- \`#\` is a decorative title only — ignored for path derivation
- Only ATX headings are recognized for structure (for example, \`## Heading\`); setext headings are treated as body text
- \`##\` and deeper headings become path segments (slugified: lowercase, spaces → \`-\`, all non-alphanumeric characters except \`-\` stripped)
- Example: \`architecture.md\` + \`## Tech Stack\` → path \`architecture/tech-stack\`; \`### Frontend\` → \`architecture/tech-stack/frontend\`
- Body: concise and factual — reference material, not narrative

---

> ⚠️ **Before writing your reply:** Have you stored everything discovered or decided this turn?
> If not — do it now, then reply.
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
    // Expose to child processes (bash tool, subagents like memory-compact).
    process.env.MEMORY_MD_DIR = memDir;

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
    delete process.env.MEMORY_MD_DIR;
  });

  // ── agent_end hook ────────────────────────────────────────────────────────

  pi.on("agent_end", (event, ctx) => {
    if (!memDir) return;

    const config = loadWorkflowLogConfig();
    if (!config) return;

    // Skip aborted/errored sessions — user interrupted, no point logging
    const msgs = (event as any).messages ?? [];
    const wasAborted = msgs.some((m: any) => m.stopReason === "aborted" || m.stopReason === "error");
    if (wasAborted) return;

    // Fire-and-forget — must not block the agent_end hook
    void (async () => {
      // Extract tool calls
      const toolCalls: Array<{ name: string; inputSummary: string }> = [];
      let lastAssistantText = "";

      for (const msg of msgs) {
        if (msg.role !== "assistant") continue;
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
          if (block.type === "toolCall") {
            const inp = block.arguments ?? {};
            let summary = "";
            switch (block.name) {
              case "bash":  summary = String(inp.command ?? "").replace(/\s+/g, " ").slice(0, 100); break;
              case "read":
              case "edit":
              case "write": summary = String(inp.path ?? ""); break;
              case "grep":  summary = [inp.pattern, inp.path].filter(Boolean).join(" in ").slice(0, 100); break;
              default: try { summary = JSON.stringify(inp).slice(0, 100); } catch { summary = ""; }
            }
            toolCalls.push({ name: block.name, inputSummary: summary });
          }
          if (block.type === "text" && block.text?.trim()) {
            lastAssistantText = block.text.trim();
          }
        }
      }

      // Skip pure text conversations
      if (toolCalls.length === 0) return;

      const toolSummary = toolCalls
        .map((t) => `- ${t.name}${t.inputSummary ? `: ${t.inputSummary}` : ""}`)
        .join("\n");

      const summaryPrompt = [
        "Write a workflow log entry for this agent session.",
        "",
        "Tool calls made:",
        toolSummary,
        "",
        lastAssistantText ? `Final response:\n${lastAssistantText.slice(0, 500)}` : "",
        "",
        "Format your response as:",
        "Line 1: one-line action title (no heading markers, no timestamp)",
        "Line 2: blank",
        "Lines 3+: 2-5 bullet points (- prefix) listing specific files changed, commands run, or key findings",
        "",
        "Be factual and specific. Use past tense. No preamble or closing remarks.",
      ].filter(Boolean).join("\n");

      try {
        const cwd = (ctx as any).cwd ?? process.cwd();
        const raw = await callModelForSummary(config.model, summaryPrompt, ctx, cwd);
        if (!raw) return;

        // Parse: first line is title, rest is body
        const lines = raw.trim().split("\n");
        const title = lines[0].trim();
        const body = lines.slice(1).join("\n").trim();
        if (!title) return;

        await appendWorkflowEntry(memDir, title, body, new Date(), pi.exec.bind(pi));
      } catch (err) {
        // Never crash the agent loop — log silently
        process.stderr.write(`[memory-md] workflow log error: ${(err as any)?.message ?? err}\n`);
      }
    })();
  });

  // ── /memory command ───────────────────────────────────────────────────────

  pi.registerCommand("memory", {
    description: "memory-md management: status | restart | snapshot | logs",
    getArgumentCompletions: (prefix: string) => {
      const SUBS = ["status", "restart", "snapshot", "logs"];
      const parts = prefix.split(/\s+/);

      // First token — complete sub-command
      if (parts.length <= 1) {
        const p = parts[0].toLowerCase();
        const matches = SUBS.filter(s => s.startsWith(p)).map(s => ({ value: s, label: s }));
        return matches.length > 0 ? matches : null;
      }

      return null;
    },
    handler: async (args, ctx) => {
      uiCtx = ctx.ui;
      const parts = (args ?? "").trim().split(/\s+/);
      const sub = (parts[0] ?? "").toLowerCase();

      if (!memDir) {
        ctx.ui.notify("memory-md: not initialised yet.", "warning");
        return;
      }

      if (sub === "status" || sub === "") {
        const status     = getDaemonStatus(memDir);
        const source     = process.env.MEMORY_MD_DIR ? "$MEMORY_MD_DIR" : ".pi-memory";
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
