/**
 * types.ts — Core type definitions for the subagents extension.
 */

/** Agent type name (built-in or user-defined). */
export type SubagentType = string;

/** Thinking levels supported by Claude models. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Isolation mode for agent file system access. */
export type IsolationMode = "worktree";

/** Unified configuration for a subagent type (default or custom). */
export interface AgentConfig {
  name: string;
  displayName?: string;
  description: string;
  /** Built-in tool names to give the agent. Omit = all built-in tools. */
  builtinToolNames?: string[];
  /** true = inherit all extension tools, string[] = only listed, false = none */
  extensions: true | string[] | false;
  model?: string;
  thinking?: ThinkingLevel;
  /** Max agentic turns (undefined = unlimited). */
  maxTurns?: number;
  systemPrompt: string;
  promptMode: "replace" | "append";
  /** Fork parent conversation into agent by default. */
  inheritContext?: boolean;
  /** Run in background by default. */
  runInBackground?: boolean;
  /** No extension/MCP tools by default. */
  isolated?: boolean;
  /** Embedded default (not user-defined). */
  isDefault?: boolean;
  /** false = hidden from registry. */
  enabled?: boolean;
  /** Where this config was loaded from. */
  source?: "default" | "project" | "global";
}

/** Live state of a spawned agent. */
export interface AgentRecord {
  id: string;
  type: SubagentType;
  description: string;
  status: "queued" | "running" | "completed" | "aborted" | "stopped" | "error";
  result?: string;
  error?: string;
  toolUses: number;
  turnCount: number;
  startedAt: number;
  completedAt?: number;
  /** Active session — used for resume and steer. */
  session?: any;
  abortController?: AbortController;
  promise?: Promise<void>;
  /** Steers queued before session was ready. */
  pendingSteers?: string[];
  /** Set when caller already consumed the result — suppresses completion nudge. */
  resultConsumed?: boolean;
}

/** Single tool call captured in a turn log. */
export interface ToolCallEntry {
  /** Matches toolCallId from session events. */
  id: string;
  name: string;
  inputSummary: string;
  /** Undefined while still running. */
  resultSummary?: string;
  startedAt: number;
  completedAt?: number;
}

/** One agent-loop iteration (think → tool calls → think → turn_end). */
export interface TurnEntry {
  turnNumber: number;
  startedAt: number;
  /** Undefined while still in progress. */
  completedAt?: number;
  /** Accumulated assistant text for this turn. */
  text: string;
  toolCalls: ToolCallEntry[];
}

/** Live activity state for a running agent (used by widget + session viewer). */
export interface AgentActivity {
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  activeToolNames: Set<string>;
  lastText: string;
  /** Completed turns. */
  log: TurnEntry[];
  /** Turn currently executing (undefined between turns or before first turn). */
  currentTurn: TurnEntry | undefined;
}
