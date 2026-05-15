/**
 * memory pi extension entry point.
 *
 * Manages the memory daemon lifecycle and exposes memory tools to the LLM.
 * Replaces the memory-md Go binary wrapper with a native TypeScript implementation.
 *
 * Dir resolution (first match wins):
 *   1. PI_MEMORY env var
 *   2. <projectRoot>/.pi/<memory.dirname>  (dirname from pi-code.json, default "memory")
 */

import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, renameSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { registerTools } from "./tools.ts";
import { getLogPath, getStatusPath, getSocketPath } from "./paths.ts";
import { getProjectRoot, getConfig, getProjectCacheDir } from "../_config/index.ts";

// ── Workflow log helpers ──────────────────────────────────────────────────────

interface WorkflowConfig { enabled: boolean; model: string; }

function loadWorkflowConfig(): WorkflowConfig | null {
  const wl = getConfig().memory?.workflow;
  if (!wl?.enabled || !wl?.model) return null;
  return { enabled: true, model: wl.model };
}

/**
 * Append a timestamped entry to workflow.md, writing directly to the file
 * (bypassing the daemon) so the watcher picks up one atomic change.
 */
async function appendWorkflowEntry(
  memDir: string,
  title: string,
  body: string,
  ts: Date,
): Promise<void> {
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateStr     = `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())}`;
  const displayTime = `${pad(ts.getHours())}:${pad(ts.getMinutes())}`;
  const filePath    = join(memDir, "workflow.md");

  if (!existsSync(filePath)) {
    mkdirSync(memDir, { recursive: true });
    writeFileSync(filePath, "# Workflow\n\nAuto-generated activity log — do not edit manually.\n");
  }

  const content = readFileSync(filePath, "utf-8");
  const parts: string[] = [];

  if (!content.includes(`## ${dateStr}`)) parts.push(`\n## ${dateStr}\n`);
  parts.push(`\n### ${displayTime}\n`);
  parts.push(`\n**${title}**\n`);
  if (body.trim()) parts.push(`\n${body.trim()}\n`);

  appendFileSync(filePath, parts.join(""));
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
    systemPrompt: "You are a concise technical log writer. Respond only with the requested log entry — no preamble.",
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

  const messages: any[] = (session as any).messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const text = blocks
      .filter((b: any) => b.type === "text" && b.text)
      .map((b: any) => b.text as string)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const RUNNER_SCRIPT = join(EXTENSION_DIR, "daemon", "runner.ts");

// ── Dir resolution ────────────────────────────────────────────────────────────

function resolveMemDir(cwd: string): string {
  if (process.env.PI_MEMORY?.trim()) return process.env.PI_MEMORY.trim();
  const dirname_ = getConfig().memory?.dirname ?? "memory";
  return join(getProjectRoot(cwd), ".pi", dirname_);
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let memDir:      string | undefined;
  let projectRoot: string | undefined;
  let daemonChild: ChildProcess | undefined;
  let poller:      ReturnType<typeof setInterval> | undefined;
  let uiCtx:       { setStatus: (key: string, label: string | undefined) => void; notify: (msg: string, level: string) => void } | undefined;
  let isInteractive = false;

  // Pass projectRoot to all tools (per the naming-fix note in the spec)
  registerTools(pi, () => projectRoot);

  // ── System prompt injection ───────────────────────────────────────────────

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
2. Exists → \`memory_update\` (replaces only the immediate body; child sections are preserved)
3. Missing → \`memory_create_file\` if the file is new, then \`memory_new\`
4. \`memory_new\` / \`memory_update\` already validate after writing — read the validation output
5. If validation fails: \`read\` the .md file, fix with \`edit\` tool, then \`memory_validate_file\`

**Store:** decisions, constraints, architectural choices, discovered patterns, corrected assumptions.
**Do not store:** transient thoughts, step-by-step logs, anything irrelevant across sessions.

### File structure

#### Canonical files (use these by default)

| File | Purpose |
|------|--------|
| \`architecture.md\` | Project architecture, tech stack, codebase reference, constraints. |
| \`project.md\` | Categorised natural language description of the project, its goals, and scope. |
| \`setup.md\` | Development setup, dependencies, configuration. |
| \`decisions.md\` | Decisions made during the project — rationale and alternatives considered. |
| \`notes.md\` | Arbitrary notes — challenges faced, lessons learned, future considerations. |
| \`workflow.md\` | **Read-only.** Auto-generated activity log. Do not write to this file manually. |

#### File format rules

- Filename (without \`.md\`) is always the first path segment
- \`#\` is a decorative title only — ignored for path derivation
- Only ATX headings are recognized; \`##\` and deeper become path segments (slugified)
- Example: \`architecture.md\` + \`## Tech Stack\` → path \`architecture/tech-stack\`
- Body: concise and factual — reference material, not narrative

---

> ⚠️ **Before writing your reply:** Have you stored everything discovered or decided this turn?
> If not — do it now, then reply.
`.trim();

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: event.systemPrompt + "\n\n" + MEMORY_INSTRUCTION,
  }));

  // ── Status helpers ────────────────────────────────────────────────────────

  function readStatus(): string {
    if (!projectRoot) return "stopped";
    try { return readFileSync(getStatusPath(projectRoot), "utf8").trim(); }
    catch { return "stopped"; }
  }

  function updateFooter(): void {
    if (!uiCtx || !memDir) return;
    const status = readStatus();
    const short  = memDir.replace(homedir(), "~");
    const labels: Record<string, string> = {
      starting: `☰ memory: starting… (${short})   `,
      indexing: `☰ memory: indexing… (${short})   `,
      ready:    `☰ memory: ready (${short})   `,
      stopped:  `☰ memory: stopped (${short})   `,
      error:    `☰ memory: error (${short})   `,
    };
    uiCtx.setStatus("memory-md", labels[status] ?? labels["stopped"]);
  }

  // ── Daemon lifecycle ──────────────────────────────────────────────────────

  function spawnDaemon(dir: string, root: string): ChildProcess {
    // getLogPath calls getProjectCacheDir which creates the directory
    const logFd = openSync(getLogPath(root), "a");
    const child = spawn(
      process.execPath,
      ["--import", "jiti/register", RUNNER_SCRIPT, dir, root],
      {
        env:   { ...process.env, PI_MEMORY: dir },
        stdio: ["ignore", logFd, logFd],
        detached: false,
      },
    );
    child.on("error", (err) =>
      process.stderr.write(`[memory] daemon spawn error: ${err.message}\n`),
    );
    return child;
  }

  function killDaemon(): void {
    if (!daemonChild) return;
    try { daemonChild.kill("SIGTERM"); } catch (_) {}
    daemonChild = undefined;
  }

  // ── Lifecycle events ──────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    projectRoot = getProjectRoot(ctx.cwd);
    memDir      = resolveMemDir(ctx.cwd);
    mkdirSync(memDir, { recursive: true });
    process.env.PI_MEMORY = memDir;

    if (!ctx.hasUI) return;
    isInteractive = true;
    uiCtx = ctx.ui as typeof uiCtx;

    killDaemon();
    if (poller) { clearInterval(poller); poller = undefined; }

    const short = memDir.replace(homedir(), "~");
    uiCtx!.setStatus("memory-md", `☰ memory: starting… (${short})   `);
    daemonChild = spawnDaemon(memDir, projectRoot);
    poller = setInterval(updateFooter, 2000);
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    if (ctx.hasUI) uiCtx = ctx.ui as typeof uiCtx;
  });

  // ── agent_end: workflow log ─────────────────────────────────────────

  pi.on("agent_end", (event, ctx) => {
    if (!memDir || !projectRoot) return;

    const config = loadWorkflowConfig();
    if (!config) return;

    const msgs = (event as any).messages ?? [];
    // Skip aborted / errored turns
    const wasAborted = msgs.some(
      (m: any) => m.stopReason === "aborted" || m.stopReason === "error",
    );
    if (wasAborted) return;

    // Fire-and-forget — must not block the hook
    void (async () => {
      const toolCalls: Array<{ name: string; inputSummary: string }> = [];
      let lastAssistantText = "";

      for (const msg of msgs) {
        if (msg.role !== "assistant") continue;
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        for (const block of blocks) {
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
        const lines = raw.trim().split("\n");
        const title = lines[0].trim();
        const body  = lines.slice(1).join("\n").trim();
        if (!title) return;
        await appendWorkflowEntry(memDir!, title, body, new Date());
      } catch (err) {
        try {
          appendFileSync(
            getLogPath(projectRoot!),
            `[workflow] error: ${(err as any)?.message ?? err}\n`,
          );
        } catch { /* ignore */ }
        void pi.exec(
          "osascript",
          ["-e", `display notification "workflow log error — run /memory logs" with title "pi — memory"`],
          { timeout: 3000 },
        ).catch(() => {});
      }
    })();
  });

  pi.on("session_shutdown", async () => {
    if (!isInteractive) return;
    isInteractive = false;
    if (poller) { clearInterval(poller); poller = undefined; }
    killDaemon();
    uiCtx?.setStatus("memory-md", undefined);
    memDir      = undefined;
    projectRoot = undefined;
    uiCtx       = undefined;
    delete process.env.PI_MEMORY;
  });

  // ── /memory command ───────────────────────────────────────────────────────

  pi.registerCommand("memory", {
    description: "memory management: status | restart | snapshot [--move] | logs",
    getArgumentCompletions: (prefix: string) => {
      const parts = prefix.trimStart().split(/\s+/);
      // First token — complete sub-command
      if (parts.length <= 1) {
        const subs = ["status", "restart", "snapshot", "logs"];
        const p = parts[0].toLowerCase();
        const matches = subs.filter((s) => s.startsWith(p)).map((s) => ({ value: s, label: s }));
        return matches.length > 0 ? matches : null;
      }
      // Second token after "snapshot" — offer --move
      if (parts[0].toLowerCase() === "snapshot" && parts.length === 2) {
        const p = parts[1].toLowerCase();
        if ("--move".startsWith(p)) return [{ value: "--move", label: "--move" }];
      }
      return null;
    },
    handler: async (args, ctx) => {
      uiCtx = ctx.ui as typeof uiCtx;
      const sub = ((args ?? "").trim().split(/\s+/)[0] ?? "").toLowerCase();

      if (!memDir || !projectRoot) {
        ctx.ui.notify("memory: not initialised", "warning");
        return;
      }

      if (sub === "status" || sub === "") {
        const status = readStatus();
        const sockPath = getSocketPath(projectRoot);
        ctx.ui.notify(
          [
            `Status:  ${status}`,
            `Dir:     ${memDir}`,
            `Cache:   ${getProjectCacheDir(projectRoot)}`,
            `Socket:  ${sockPath}${existsSync(sockPath) ? "" : " (missing)"}`,
          ].join("\n"),
          "info",
        );

      } else if (sub === "restart") {
        ctx.ui.notify("memory: restarting…", "info");
        if (poller) { clearInterval(poller); poller = undefined; }
        killDaemon();
        memDir = resolveMemDir(ctx.cwd);
        projectRoot = getProjectRoot(ctx.cwd);
        mkdirSync(memDir, { recursive: true });
        uiCtx!.setStatus("memory-md", `☰ memory: starting…   `);
        daemonChild = spawnDaemon(memDir, projectRoot);
        poller = setInterval(updateFooter, 2000);

      } else if (sub === "snapshot") {
        const parts = (args ?? "").trim().split(/\s+/);
        const move  = parts.includes("--move");
        try {
          const ts   = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
          const dest = join(memDir, `snapshot-${ts}`);
          mkdirSync(dest, { recursive: true });
          const affected: string[] = [];
          for (const f of readdirSync(memDir)) {
            if (!f.endsWith(".md")) continue;
            const src = join(memDir, f);
            const dst = join(dest, f);
            if (move) renameSync(src, dst);
            else copyFileSync(src, dst);
            affected.push(f);
          }
          const action = move ? "moved" : "copied";
          ctx.ui.notify(`Snapshot created (${action}):\n${dest}\n${affected.join(", ")}`, "info");
        } catch (err) {
          ctx.ui.notify(`Snapshot failed: ${(err as Error).message}`, "error");
        }

      } else if (sub === "logs") {
        const logPath = getLogPath(projectRoot);
        if (!existsSync(logPath)) { ctx.ui.notify("(no log file yet)", "info"); return; }
        try {
          const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
          ctx.ui.notify(lines.slice(-50).join("\n"), "info");
        } catch { ctx.ui.notify("(could not read log)", "warning"); }

      } else {
        ctx.ui.notify(`memory: unknown sub-command: ${sub}`, "warning");
      }
    },
  });
}
