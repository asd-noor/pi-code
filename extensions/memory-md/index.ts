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

import { existsSync, openSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
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

// ── Workflow log helpers ─────────────────────────────────────────────────────

interface WorkflowLogConfig {
  enabled: boolean;
  model: string; // "provider/modelId"
}

function loadMemoryAgentModel(): string | null {
  try {
    const configPath = join(homedir(), ".pi", "agent", "pi-code.json");
    if (!existsSync(configPath)) return null;
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    return raw?.memoryAgent?.model ?? null;
  } catch {
    return null;
  }
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

function appendWorkflowEntry(memDir: string, title: string, body: string, ts: Date): void {
  const filePath = join(memDir, "workflow.md");

  // Create file if missing
  if (!existsSync(filePath)) {
    writeFileSync(filePath, "# Workflow\n", "utf-8");
  }

  const dateStr = ts.toISOString().slice(0, 10); // "2026-05-09"
  const timeStr = ts.toTimeString().slice(0, 5);  // "10:42"
  const dateHeading = `## ${dateStr}`;

  let content = readFileSync(filePath, "utf-8");

  const newEntry = `\n### ${timeStr} \u2014 ${title}\n\n${body}\n`;

  if (content.includes(dateHeading)) {
    // Find where to insert: right before the next ## heading after the date, or at end
    const afterDate = content.indexOf(dateHeading) + dateHeading.length;
    const nextSection = content.indexOf("\n## ", afterDate);
    if (nextSection === -1) {
      content = content.trimEnd() + "\n" + newEntry;
    } else {
      content = content.slice(0, nextSection) + newEntry + content.slice(nextSection);
    }
  } else {
    // Append new date section
    content = content.trimEnd() + `\n\n${dateHeading}\n` + newEntry;
  }

  writeFileSync(filePath, content, "utf-8");
}

async function runMemoryAgentSession(
  modelStr: string,
  systemPrompt: string,
  prompt: string,
  ctx: any,
  cwd: string,
): Promise<string> {
  const [provider, ...rest] = modelStr.split("/");
  const modelId = rest.join("/");
  const model = ctx.modelRegistry?.find(provider, modelId) ?? ctx.model;
  if (!model) throw new Error(`Model not found: ${modelStr}`);

  const agentDirPath = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: agentDirPath,
    settingsManager: SettingsManager.create(cwd, agentDirPath),
    noExtensions: false,   // memory tools must be available
    noSkills: false,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
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

  // Exclude delegation tools to prevent subagent spawning
  const EXCLUDED = new Set(["Subagent", "MultiSubagent", "get_subagent_result", "steer_subagent"]);
  const active = session.getAllTools()
    .map((t: any) => t.name as string)
    .filter((name: string) => !EXCLUDED.has(name));
  session.setActiveToolsByName(active);

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
  return "(no output)";
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

const MEMORY_INIT_PROMPT = `## Memory Initialization

You are initializing the memory system for this project. Your task is to:

1. **Check memory status**: Use \`memory_list\` tool to determine if any \`.md\` files exist
   - If \`memory_list\` returns files → memory already initialized, report status and contents
   - If \`memory_list\` returns empty → proceed with analysis and storage

2. **If initializing (no \`.md\` files found)**:

Analyze the current project directory and extract key information:
   - **Project Overview**: README, package.json, purpose, goals, scope in natural language; technical jargons go to architecture file.
   - **Architecture**: Directory structure, main entry points, key modules/components, tech stack, constraints.
   - **Dependencies**: Notable libraries, external services, APIs.
   - **Configuration**: Environment setup, build process, tooling.
   - **Development Workflow**: How to run, test, build, deploy.

3. **Store memories using the canonical files**:

Always prefer these standard files. Create additional files only when content clearly does not fit any of them:

| File | Purpose |
|------|---------|
| \`architecture.md\` | Project architecture, tech stack, codebase reference, constraints |
| \`project.md\` | Categorised natural language description of the project, its goals, and scope |
| \`setup.md\` | Development setup, dependencies, configuration |
| \`decisions.md\` | Decisions made during the project — rationale and alternatives considered |
| \`workflow.md\` | **Read-only.** Auto-generated activity log — timestamped entries written after every agent loop. Do not create or write to this file. |
| \`notes.md\` | Arbitrary notes — challenges faced, lessons learned, future considerations |

For each file:
   - Use \`memory_create_file\` to create the file (name must not contain \`/\`, must not start with \`.\`, must not include \`.md\`)
   - Use \`memory_new\` to add sections. The path is derived from the **filename + heading nesting**:
     - The filename (without \`.md\`) is always the first path segment
     - \`#\` is a decorative title only — ignored for path derivation
     - \`##\` headings become the second path segment: \`file/heading-slug\`
     - \`###\` headings become the third: \`file/parent-slug/heading-slug\`
     - \`####\` headings become the fourth: \`file/grandparent/parent/heading-slug\`
     - Slugification: lowercase, spaces → \`-\`, all non-alphanumeric characters except \`-\` stripped
     - Example: \`architecture.md\` + \`## Tech Stack\` → \`architecture/tech-stack\`; \`### Frontend\` → \`architecture/tech-stack/frontend\`
   - **Use nesting — don't flatten.** A \`##\` should cover one coherent topic. Sub-topics, categories, or distinct facts belong under \`###\` or \`####\`. Avoid cramming multiple concepts into a single \`##\` body — break them into child sections instead. This keeps each section small, focused, and easy to retrieve.
   - Store factual, concise information suitable for future reference
   - Include paths, commands, and specific details where relevant
   - After writing to a file, run \`memory_validate_file\` to check for duplicate paths, skipped heading levels, and multiple title headings

4. **Report back**:

After initialization, use \`memory_list\` to verify and report:
   - Memory files created
   - Key sections stored per file
   - Total sections indexed
   - Next steps: "Memory initialized and ready for use across sessions"

**Acceptance Guard**: Memory is initialized when ≥3 memory files exist with ≥2 sections each, covering project overview, architecture, and setup.
`;

const MEMORY_CURATE_PROMPT = `## Memory Curation

You are curating the memory store for this project. Your goal is to improve the **structure and retrieval quality** of existing memory without inventing new facts or discarding durable information.

If an argument was provided, curate only that file (e.g. \`architecture\`). Otherwise curate all files.

---

### Step 1 — Discover what exists

\`\`\`
memory_list                   # list all memory files
memory_list <file>            # list all sections in a file
\`\`\`

Skip \`workflow.md\` entirely — it is auto-generated and read-only.

---

### Step 2 — Read and audit each file

For each file (or the specified file), read every section:

\`\`\`
memory_get <file>/<section>
memory_get <file>/<section>/<subsection>
\`\`\`

While reading, flag these problems:

| Problem | Signal |
|---|---------|
| **Flat overload** | A \`##\` body exceeds ~8 lines and covers more than one distinct sub-topic |
| **Missing nesting** | Sibling concepts listed as bullets inside one section that would each benefit from their own \`###\` |
| **Duplicate content** | Two sections that describe the same thing, partially overlapping |
| **Stale fact** | A detail that contradicts what you can observe in the codebase today |
| **Heading level skip** | A \`####\` appearing directly under a \`##\` with no \`###\` in between |
| **Over-compressed** | A section so terse it has lost its durable meaning |

---

### Step 3 — Plan the restructure

Before writing anything, form a plan:

- Which sections need to be **split** (flat overload / missing nesting)?
- Which sections need to be **merged** (duplicates)?
- Which sections need their **body updated** (stale, over-compressed)?
- Which sections can be **left as-is**?

Prefer targeted changes over wholesale rewrites. If a section is fine, skip it.

---

### Step 4 — Apply changes

Work file by file, section by section.

#### Splitting a flat section

If a \`##\` body is overloaded, break sub-topics into \`###\` children:

\`\`\`
# Before: one fat ## section
memory_update <file>/<section>   # replace body with intro only (no child content)
memory_new <file>/<section>/<sub-a>   # first sub-topic
memory_new <file>/<section>/<sub-b>   # second sub-topic
\`\`\`

\`memory_update\` preserves existing child sections — do **not** include child headings in the body you pass.

#### Merging duplicate sections

\`\`\`
memory_get <file>/<dup-a>     # read both
memory_get <file>/<dup-b>
memory_update <file>/<dup-a>  # write merged body into the better-named section
memory_delete <file>/<dup-b>  # remove the redundant one
\`\`\`

#### Updating a stale or over-compressed body

\`\`\`
memory_update <file>/<section>   # replace body only; children preserved automatically
\`\`\`

#### Path and heading rules (reminder)

- Filename (without \`.md\`) is always the first path segment
- \`#\` is decorative — ignored for paths
- \`##\` → second segment, \`###\` → third, \`####\` → fourth
- Slugification: lowercase, spaces → \`-\`, non-alphanumeric except \`-\` stripped
- \`memory_new\` fails if the path already exists — use \`memory_update\` for existing sections
- Never skip heading levels (no \`####\` directly under \`##\`)

---

### Step 5 — Validate

After finishing each file:

\`\`\`
memory_validate_file <name>
\`\`\`

Fix any reported issues (duplicate paths, skipped levels, multiple title headings) before moving on.

---

### Step 6 — Report

When done, report for each file touched:

- Sections split, merged, updated, or deleted
- Validation result
- Any issues that could not be resolved automatically (flag for human review)

---

**Acceptance Guard**: Every curated file passes \`memory_validate_file\` with no errors; no \`##\` section body exceeds ~8 lines of mixed content; no two sections describe the same topic; \`workflow.md\` was not modified.
`;

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

  pi.on("agent_end", async (event, ctx) => {
    if (!memDir) return;

    const config = loadWorkflowLogConfig();
    if (!config) return;

    // Extract tool calls
    const toolCalls: Array<{ name: string; inputSummary: string }> = [];
    let lastAssistantText = "";

    for (const msg of ((event as any).messages ?? [])) {
      if (msg.role !== "assistant") continue;
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (block.type === "tool_use") {
          const inp = block.input ?? {};
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

      appendWorkflowEntry(memDir, title, body, new Date());
    } catch (err) {
      // Never crash the agent loop — log silently
      process.stderr.write(`[memory-md] workflow log error: ${(err as any)?.message ?? err}\n`);
    }
  });

  // ── /memory command ───────────────────────────────────────────────────────

  pi.registerCommand("memory", {
    description: "memory-md management: status | restart | snapshot | logs | init | curate [file]",
    getArgumentCompletions: (prefix: string) => {
      const SUBS = ["status", "restart", "snapshot", "logs", "init", "curate"];
      const parts = prefix.split(/\s+/);

      // First token — complete sub-command
      if (parts.length <= 1) {
        const p = parts[0].toLowerCase();
        const matches = SUBS.filter(s => s.startsWith(p)).map(s => ({ value: s, label: s }));
        return matches.length > 0 ? matches : null;
      }

      // Second token after "curate" — complete memory file names
      if (parts[0].toLowerCase() === "curate" && memDir) {
        const filePrefix = (parts[1] ?? "").toLowerCase();
        try {
          const files = readdirSync(memDir)
            .filter(f => f.endsWith(".md") && !f.startsWith(".") && f !== "workflow.md")
            .map(f => f.replace(/\.md$/, ""))
            .filter(f => f.startsWith(filePrefix))
            .map(f => ({ value: `curate ${f}`, label: f }));
          return files.length > 0 ? files : null;
        } catch {
          return null;
        }
      }

      return null;
    },
    handler: async (args, ctx) => {
      uiCtx = ctx.ui;
      const parts = (args ?? "").trim().split(/\s+/);
      const sub = (parts[0] ?? "").toLowerCase();
      const subArg = parts.slice(1).join(" ").trim();

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

      } else if (sub === "init") {
        const modelStr = loadMemoryAgentModel();
        if (!modelStr) {
          ctx.ui.notify(
            'memory init: no model configured.\nAdd "memoryAgent": { "model": "..." } to ~/.pi/agent/pi-code.json',
            "warning",
          );
          return;
        }
        uiCtx.setStatus("memory-md", "\u2630 memory: running init\u2026   ");
        try {
          const cwd = ctx.cwd ?? process.cwd();
          const result = await runMemoryAgentSession(
            modelStr,
            "You are a memory initialization agent for a coding project. Follow the instructions precisely.",
            MEMORY_INIT_PROMPT,
            ctx,
            cwd,
          );
          ctx.ui.notify(result.slice(0, 3000), "info");
        } catch (err: any) {
          ctx.ui.notify(`memory init error: ${err?.message ?? err}`, "error");
        } finally {
          updateFooter();
        }

      } else if (sub === "curate") {
        const modelStr = loadMemoryAgentModel();
        if (!modelStr) {
          ctx.ui.notify(
            'memory curate: no model configured.\nAdd "memoryAgent": { "model": "..." } to ~/.pi/agent/pi-code.json',
            "warning",
          );
          return;
        }
        const fileArg = subArg ? `\n\nCurate only this file: ${subArg}` : "";
        uiCtx.setStatus("memory-md", "\u2630 memory: running curate\u2026   ");
        try {
          const cwd = ctx.cwd ?? process.cwd();
          const result = await runMemoryAgentSession(
            modelStr,
            "You are a memory curation agent. Follow the instructions precisely.",
            MEMORY_CURATE_PROMPT + fileArg,
            ctx,
            cwd,
          );
          ctx.ui.notify(result.slice(0, 3000), "info");
        } catch (err: any) {
          ctx.ui.notify(`memory curate error: ${err?.message ?? err}`, "error");
        } finally {
          updateFooter();
        }

      } else {
        ctx.ui.notify(
          `memory: unknown sub-command "${sub}". Use: status | restart | snapshot | logs | init | curate [file]`,
          "warning",
        );
      }
    },
  });
}
