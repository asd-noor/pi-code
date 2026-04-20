/**
 * agent-runner.ts — Core execution engine.
 *
 * Creates an isolated AgentSession per subagent invocation,
 * builds a system prompt from the agent config, tracks turns,
 * and enforces soft/hard max-turn limits.
 */

import { execFileSync } from "node:child_process";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";
import type { AgentActivity, AgentConfig, ThinkingLevel } from "./types.ts";
import { buildSubagentAgendaInstruction } from "../agenda/instruction.ts";

// ---- Tool factories ----

const TOOL_FACTORIES: Record<string, (cwd: string) => any> = {
  read:  (cwd) => createReadTool(cwd),
  bash:  (cwd) => createBashTool(cwd),
  edit:  (cwd) => createEditTool(cwd),
  write: (cwd) => createWriteTool(cwd),
  grep:  (cwd) => createGrepTool(cwd),
  find:  (cwd) => createFindTool(cwd),
  ls:    (cwd) => createLsTool(cwd),
};

export const ALL_BUILTIN_TOOL_NAMES = Object.keys(TOOL_FACTORIES);

/** Tool names registered by this extension that subagents must NOT inherit. */
const EXCLUDED_TOOL_NAMES = new Set(["Agent", "get_subagent_result", "steer_subagent"]);

// ---- Settings ----

let graceTurns = 5;
export function getGraceTurns(): number { return graceTurns; }
export function setGraceTurns(n: number): void { graceTurns = Math.max(1, n); }

let defaultMaxTurns: number | undefined;
export function getDefaultMaxTurns(): number | undefined { return defaultMaxTurns; }
export function setDefaultMaxTurns(n: number | undefined): void {
  defaultMaxTurns = (n == null || n === 0) ? undefined : Math.max(1, n);
}

// ---- Result type ----

export interface SpawnResult {
  text: string;
  session: any;
  status: "completed" | "aborted" | "error";
  error?: string;
}

// ---- Env detection ----

function detectEnv(cwd: string): { isGit: boolean; branch: string; platform: string } {
  let isGit = false;
  let branch = "";
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd, stdio: "pipe", timeout: 5000,
    }).toString().trim();
    isGit = out === "true";
  } catch { /* not a git repo */ }

  if (isGit) {
    try {
      branch = execFileSync("git", ["branch", "--show-current"], {
        cwd, stdio: "pipe", timeout: 5000,
      }).toString().trim();
    } catch { branch = "unknown"; }
  }
  return { isGit, branch, platform: process.platform };
}

// ---- System prompt builder ----

const SUBAGENT_BRIDGE = `<sub_agent_context>
You are operating as a sub-agent invoked to handle a specific task.
- Use the read tool instead of cat/head/tail
- Use the edit tool instead of sed/awk
- Use the write tool instead of echo/heredoc
- Use the find tool instead of bash find/ls for file search
- Use the grep tool instead of bash grep/rg for content search
- Make independent tool calls in parallel
- Use absolute file paths
- Do not use emojis
- Be concise but complete
</sub_agent_context>`;

const GENERIC_BASE = `# Role
You are a general coding agent for complex, multi-step tasks.
You have access to read, write, edit files, and execute commands.
Do what has been asked; nothing more, nothing less.`;

function buildSystemPrompt(
  config: AgentConfig,
  cwd: string,
  parentSystemPrompt?: string,
): string {
  const env = detectEnv(cwd);
  const envBlock = [
    "# Environment",
    `Working directory: ${cwd}`,
    env.isGit
      ? `Git repository: yes\nBranch: ${env.branch}`
      : "Not a git repository",
    `Platform: ${env.platform}`,
  ].join("\n");

  if (config.promptMode === "append") {
    const base = parentSystemPrompt || GENERIC_BASE;
    const custom = config.systemPrompt?.trim()
      ? `\n\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`
      : "";
    return `${envBlock}\n\n<inherited_system_prompt>\n${base}\n</inherited_system_prompt>\n\n${SUBAGENT_BRIDGE}${custom}`;
  }

  // "replace" mode — env header + config's full system prompt
  return [
    "You are a pi coding agent sub-agent.",
    "You have been invoked to handle a specific task autonomously.",
    "",
    envBlock,
    "",
    config.systemPrompt,
  ].join("\n");
}

// ---- Parent context builder ----

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text ?? "")
    .join("\n");
}

function buildParentContext(ctx: any): string {
  const entries: any[] = ctx.sessionManager?.getBranch?.() ?? [];
  if (!entries.length) return "";

  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const { role, content } = entry.message;
    if (role === "user") {
      const text = typeof content === "string" ? content : extractText(content);
      if (text.trim()) parts.push(`[User]: ${text.trim()}`);
    } else if (role === "assistant") {
      const text = extractText(content);
      if (text.trim()) parts.push(`[Assistant]: ${text.trim()}`);
    }
  }
  if (!parts.length) return "";

  return [
    "# Parent Conversation Context",
    "The following is the conversation from the parent session that spawned you.",
    "Use it to understand what has been discussed and decided so far.",
    "",
    parts.join("\n\n"),
    "",
    "---",
    "# Your Task (below)",
    "",
  ].join("\n");
}

// ---- Tool list builder ----

function buildTools(config: AgentConfig, cwd: string): any[] {
  const names = config.builtinToolNames?.length
    ? config.builtinToolNames
    : ALL_BUILTIN_TOOL_NAMES;
  return names
    .filter((n) => n in TOOL_FACTORIES)
    .map((n) => TOOL_FACTORIES[n](cwd));
}

// ---- Tool input / result summarisers (exported for session-viewer) ----

export function summarizeInput(toolName: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  switch (toolName) {
    case "bash":  return String(input.command ?? "").replace(/\s+/g, " ").slice(0, 100);
    case "read":  return String(input.path ?? "");
    case "edit":  return String(input.path ?? "");
    case "write": return String(input.path ?? "");
    case "grep":  return [input.pattern, input.path].filter(Boolean).join(" in ").slice(0, 100);
    case "find":  return String(input.path ?? "");
    case "ls":    return String(input.path ?? "");
    default: { try { return JSON.stringify(input).slice(0, 100); } catch { return ""; } }
  }
}

export function summarizeResult(result: any): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result.split("\n")[0].trim().slice(0, 120);
  if (Array.isArray(result)) {
    for (const c of result) {
      if (c?.type === "text" && c.text) return String(c.text).split("\n")[0].trim().slice(0, 120);
    }
    return "";
  }
  if (typeof result === "object" && result.content) return summarizeResult(result.content);
  try { return JSON.stringify(result).slice(0, 120); } catch { return ""; }
}

// ---- Last assistant text extractor ----

function extractLastAssistantText(session: any): string {
  const messages: any[] = session.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(Array.isArray(msg.content) ? msg.content : []);
    if (text.trim()) return text.trim();
  }
  return "";
}

// ---- Core runner ----

export interface SpawnOptions {
  model?: any;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  activity: AgentActivity;
  onSessionCreated?: (session: any) => void;
  agendaId?: number;
}

/**
 * Spawn a subagent: create isolated session, send prompt, collect result.
 */
export async function spawnAndRun(
  ctx: any,
  agentConfig: AgentConfig,
  prompt: string,
  options: SpawnOptions,
): Promise<SpawnResult> {
  const cwd = ctx.cwd as string;
  const { model, isolated, inheritContext, thinkingLevel, signal, activity } = options;

  const noExtensions = isolated || agentConfig.extensions === false;
  // Do not forward the parent system prompt: it already contains the package-level
  // SYSTEM_INSTRUCTION injected by before_agent_start. Passing it here would embed
  // it inside <inherited_system_prompt>, and before_agent_start would then append it
  // a second time for this subagent session. Let before_agent_start inject it once.
  let systemPrompt = buildSystemPrompt(agentConfig, cwd);
  if (options.agendaId != null) {
    systemPrompt += "\n\n" + buildSubagentAgendaInstruction(options.agendaId);
  }
  const tools = buildTools(agentConfig, cwd);

  const loader = new DefaultResourceLoader({
    cwd,
    noExtensions,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt,
  });
  await loader.reload();

  const resolvedModel = model ?? ctx.model;
  const resolvedThinking = thinkingLevel ?? agentConfig.thinking;

  const sessionOpts: any = {
    cwd,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.create(),
    modelRegistry: ctx.modelRegistry,
    model: resolvedModel,
    tools,
    resourceLoader: loader,
  };
  if (resolvedThinking) sessionOpts.thinkingLevel = resolvedThinking;

  const { session } = await createAgentSession(sessionOpts);

  // If extensions enabled, bind them then filter out our own Agent tools
  if (!noExtensions) {
    await session.bindExtensions({});
    const builtinNames = new Set(tools.map((t: any) => t.name));
    const active = session.getActiveToolNames().filter((name: string) => {
      if (EXCLUDED_TOOL_NAMES.has(name)) return false;
      if (Array.isArray(agentConfig.extensions)) {
        return builtinNames.has(name) || agentConfig.extensions.some((ext) => name.includes(ext));
      }
      return true;
    });
    session.setActiveToolsByName(active);
  }

  options.onSessionCreated?.(session);

  // Turn limit tracking
  const effectiveMaxTurns = options.maxTurns ?? agentConfig.maxTurns ?? defaultMaxTurns;
  let softLimitFired = false;
  let hardAborted = false;

  const unsub = session.subscribe((event: any) => {
    if (event.type === "turn_end") {
      activity.turnCount++;
      // Commit the current turn to the log
      if (activity.currentTurn) {
        activity.currentTurn.turnNumber = activity.turnCount;
        activity.currentTurn.completedAt = Date.now();
        activity.log.push(activity.currentTurn);
        activity.currentTurn = undefined;
      }
      if (effectiveMaxTurns != null) {
        if (!softLimitFired && activity.turnCount >= effectiveMaxTurns) {
          softLimitFired = true;
          session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
        } else if (softLimitFired && activity.turnCount >= effectiveMaxTurns + graceTurns) {
          hardAborted = true;
          session.abort();
        }
      }
    }
    if (event.type === "message_start") {
      activity.lastText = "";
      // Start a new turn if none is active
      if (!activity.currentTurn) {
        activity.currentTurn = {
          turnNumber: activity.turnCount + 1,
          startedAt: Date.now(),
          text: "",
          thinking: "",
          toolCalls: [],
        };
      }
    }
    if (event.type === "message_update") {
      const ae = event.assistantMessageEvent;
      if (ae?.type === "text_delta") {
        activity.lastText += ae.delta;
        if (activity.currentTurn) activity.currentTurn.text += ae.delta;
      }
      // Extract thinking blocks from the live message snapshot
      if (activity.currentTurn && Array.isArray(event.message?.content)) {
        const thinkingText = (event.message.content as any[])
          .filter((b: any) => b.type === "thinking" && b.thinking)
          .map((b: any) => b.thinking)
          .join("\n");
        if (thinkingText) activity.currentTurn.thinking = thinkingText;
      }
    }
    if (event.type === "tool_execution_start") {
      activity.activeToolNames.add(`${event.toolCallId}:${event.toolName}`);
      if (activity.currentTurn) {
        activity.currentTurn.toolCalls.push({
          id: event.toolCallId,
          name: event.toolName,
          inputSummary: summarizeInput(event.toolName, event.input ?? event.toolInput ?? event.params),
          startedAt: Date.now(),
        });
      }
    }
    if (event.type === "tool_execution_end") {
      activity.toolUses++;
      activity.activeToolNames.delete(`${event.toolCallId}:${event.toolName}`);
      if (activity.currentTurn) {
        const tc = activity.currentTurn.toolCalls.find((t) => t.id === event.toolCallId);
        if (tc) {
          tc.resultSummary = summarizeResult(event.result ?? event.output ?? event.toolResult);
          tc.completedAt = Date.now();
        }
      }
    }
  });

  let abortListener: (() => void) | undefined;
  if (signal) {
    abortListener = () => session.abort();
    signal.addEventListener("abort", abortListener, { once: true });
  }

  const effectivePrompt = inheritContext
    ? buildParentContext(ctx) + prompt
    : prompt;

  let caughtError: any;
  try {
    await session.prompt(effectivePrompt);
  } catch (err) {
    caughtError = err;
  } finally {
    unsub();
    if (abortListener && signal) signal.removeEventListener("abort", abortListener);
  }

  if (caughtError) {
    return {
      text: "",
      session,
      status: "error",
      error: caughtError?.message ?? String(caughtError),
    };
  }

  return {
    text: extractLastAssistantText(session),
    session,
    status: hardAborted ? "aborted" : "completed",
  };
}

/** Resume an existing session with a new prompt. */
export async function resumeSession(session: any, prompt: string): Promise<string> {
  await session.prompt(prompt);
  return extractLastAssistantText(session);
}

/** Steer a running session mid-run. */
export async function steerSession(session: any, message: string): Promise<void> {
  await session.steer(message);
}
