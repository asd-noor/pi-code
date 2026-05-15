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

// ── Activity log helpers ──────────────────────────────────────────────────────

interface WorkflowConfig { enabled: boolean; model: string; }

function loadWorkflowConfig(): WorkflowConfig | null {
  const wl = getConfig().memory?.activityLog;
  if (!wl?.enabled || !wl?.model) return null;
  return { enabled: true, model: wl.model };
}

/**
 * Append a timestamped entry to activity_log.md, writing directly to the file
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
  const filePath    = join(memDir, "activity_log.md");

  if (!existsSync(filePath)) {
    mkdirSync(memDir, { recursive: true });
    writeFileSync(filePath, "# Activity Log\n\nAuto-generated activity log — do not edit manually.\n");
  }

  const content = readFileSync(filePath, "utf-8");
  const parts: string[] = [];

  if (!content.includes(`## ${dateStr}`)) parts.push(`\n## ${dateStr}\n`);
  parts.push(`\n### ${title} | ${dateStr} ${displayTime}\n`);
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

/**
 * Run a memory management agent (init / curate / compact) with extensions
 * enabled so memory tools are available. The daemon is NOT re-spawned because
 * session_start guards on ctx.hasUI, which is false for sub-sessions.
 */
async function runMemoryAgent(
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
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
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

function resolveSubcommandModel(sub: "init" | "curate" | "compact"): string | null {
  const cfg = getConfig().memory?.subcommandModel;
  return cfg?.[sub] ?? cfg?.default ?? null;
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
## Reading Memory

Always start with \`memory_search\` — it returns the most relevant sections ranked by relevance and recency.

If you need to browse the exact contents of a file, use \`memory_list\` to get all section paths, then \`memory_get\` on the paths you want.

- \`memory_search(query)\` — find sections by content; use this first
- \`memory_list()\` — list all memory files
- \`memory_list(file)\` — list all section paths within a file, in document order
- \`memory_get(path)\` — retrieve the full content of a single section by exact path

## Writing Memory

Before writing, always \`memory_search\` first to check if a section already exists.

**Create a file** (required before adding any sections to it):
\`memory_create_file(name, title, description?)\`

**Create a new section** (file must exist; fails if path already exists):
\`memory_new(path, body, heading?)\`
\`heading\` is the human-readable label. Defaults to the last path segment if omitted. The timestamp is appended automatically — do not include it.

**Update an existing section** (replaces body only; child sections are preserved):
\`memory_update(path, body)\`

**Delete a section and all its children**:
\`memory_delete(path)\`

**Delete an entire file**:
\`memory_delete_file(name)\`

\`memory_new\` and \`memory_update\` validate automatically — if the file has structural issues after the write, they return an error. Use \`memory_validate_file(name)\` only for explicit checks on files you haven't just written.

## Memory File Format

\`\`\`
# Base file name or descriptive short title
Some description.

## Section Title | YYYY-MM-DD HH:MM

### Subsection Title | YYYY-MM-DD HH:MM
- Note 1
- Note 2

### Subsection Title | YYYY-MM-DD HH:MM
- Note 1

#### Subsubsection Title | YYYY-MM-DD HH:MM
- Note 1

## Section Title | YYYY-MM-DD HH:MM
- Note 1

### Subsection Title | YYYY-MM-DD HH:MM
- Note 1
\`\`\`
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
    const logFd = openSync(getLogPath(root), "w");
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

  // ── agent_end: activity log ─────────────────────────────────────────

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
        "Write an activity log entry for this agent session.",
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
            `[activity-log] error: ${(err as any)?.message ?? err}\n`,
          );
        } catch { /* ignore */ }
        void pi.exec(
          "osascript",
          ["-e", `display notification "activity log error — run /memory logs" with title "pi — memory"`],
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
    description: "memory management: status | restart | snapshot [--move] | logs | init | curate [file] | compact",
    getArgumentCompletions: (prefix: string) => {
      const parts = prefix.trimStart().split(/\s+/);
      if (parts.length <= 1) {
        const subs = ["status", "restart", "snapshot", "logs", "init", "curate", "compact"];
        const p = parts[0].toLowerCase();
        const matches = subs.filter((s) => s.startsWith(p)).map((s) => ({ value: s, label: s }));
        return matches.length > 0 ? matches : null;
      }
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

      } else if (sub === "init") {
        const model = resolveSubcommandModel("init");
        if (!model) { ctx.ui.notify("memory init: no model configured (memory.subcommandModel)", "warning"); return; }
        ctx.ui.notify("memory: initialising…", "info");
        void runMemoryAgent(model, `
Check memory status with memory_list.
If files already exist, report what is there and stop.
Otherwise analyse this project and populate the memory store.

Analyse: README, package files, directory structure, main entry points, key modules, tech stack, dependencies, build/run/test workflow.

Create and populate these files (only those that have content):
- architecture.md — tech stack, modules, entry points, constraints
- project.md — goals, scope, description in natural language
- setup.md — install steps, env vars, build/run/test commands
- decisions.md — any notable decisions already evident in the codebase
- notes.md — gotchas, caveats, anything worth remembering

Do NOT create activity_log.md — it is auto-generated.

Use memory_create_file then memory_new for each section. Use nesting (### under ##) for sub-topics. Keep bodies concise and factual.

After writing each file confirm it is valid. Report files created and sections stored.
`.trim(), ctx, ctx.cwd).then((result) => {
          if (result) ctx.ui.notify(result.slice(0, 800), "info");
        }).catch((err) => ctx.ui.notify(`memory init failed: ${(err as Error).message}`, "error"));

      } else if (sub === "curate") {
        const model = resolveSubcommandModel("curate");
        if (!model) { ctx.ui.notify("memory curate: no model configured (memory.subcommandModel)", "warning"); return; }
        const parts = (args ?? "").trim().split(/\s+/);
        const target = parts[1] ?? "";
        ctx.ui.notify(`memory: curating${target ? ` ${target}` : ""}…`, "info");
        const scope = target ? `the file \`${target}\`` : "all files (skip activity_log.md — it is read-only)";
        void runMemoryAgent(model, `
Curate ${scope} in the memory store. Goal: improve structure and retrieval quality without inventing facts.

1. Use memory_list to discover sections.
2. Read each section with memory_get.
3. Fix these problems:
   - Flat overload: ## body covering multiple sub-topics → split into ### children
   - Duplicate sections → merge into the better-named one
   - Stale or wrong facts → update with memory_update
   - Skipped heading levels → restructure
   - Over-compressed sections that lost their meaning → expand
4. Use memory_update to replace bodies (children are preserved automatically).
   Use memory_new to add child sections. Use memory_delete to remove redundant ones.
5. Prefer targeted changes — skip sections that are already clean.
6. Report sections split, merged, updated, or deleted, and any issues for human review.
`.trim(), ctx, ctx.cwd).then((result) => {
          if (result) ctx.ui.notify(result.slice(0, 800), "info");
        }).catch((err) => ctx.ui.notify(`memory curate failed: ${(err as Error).message}`, "error"));

      } else if (sub === "compact") {
        const model = resolveSubcommandModel("compact");
        if (!model) { ctx.ui.notify("memory compact: no model configured (memory.subcommandModel)", "warning"); return; }
        ctx.ui.notify("memory: compacting…", "info");
        void runMemoryAgent(model, `
Compact the memory store:

1. Run /memory snapshot --move to snapshot and clear the active files.
   Capture the snapshot directory path from the output.
2. List the .md files in the snapshot directory.
3. For each file, read every section and rewrite it as concise factual bullets.
   Remove: repeated wording, status chatter, stale reasoning, excessive narrative.
   Keep: decisions and rationale, architecture facts, constraints, commands, file paths, setup steps.
   Target 3-7 bullets per section body. Remove a section entirely if it has no durable content.
4. Recreate each file in the active memory directory using memory_create_file and memory_new.
5. Report files compacted, sections removed, and any validation issues.

File-specific rules:
- activity_log.md: keep only durable summaries of meaningful work; drop routine logs
- decisions.md: preserve decision, rationale, and key rejected alternatives
- architecture.md: preserve structure, invariants, component relationships, constraints
- setup.md: preserve install steps, env vars, version constraints
- project.md: preserve scope, goals, capabilities
- notes.md: keep only notes with future reuse value
`.trim(), ctx, ctx.cwd).then((result) => {
          if (result) ctx.ui.notify(result.slice(0, 800), "info");
        }).catch((err) => ctx.ui.notify(`memory compact failed: ${(err as Error).message}`, "error"));

      } else {
        ctx.ui.notify(`memory: unknown sub-command: ${sub}`, "warning");
      }
    },
  });
}
