/**
 * types.ts — Core type definitions for the subagents extension.
 */

export type SubagentType = string;
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Unified configuration for a subagent type loaded from an .md file. */
export interface AgentConfig {
  name: string;
  displayName?: string;
  description: string;
  /** Built-in tool names to give the agent. Omit/empty = all built-in tools. */
  builtinToolNames?: string[];
  /** true = all extensions, string[] = only listed, string[] with !-prefix = all except listed, false = none */
  extensions: true | string[] | false;
  /** Derived from extensions field: names to exclude (populated when all items start with !) */
  extensionsExclude?: string[];
  model?: string;
  thinking?: ThinkingLevel;
  /** Max agentic turns (undefined = unlimited). */
  maxTurns?: number;
  systemPrompt: string;
  promptMode: "replace" | "append";
  inheritContext?: boolean;
  runInBackground?: boolean;
  isolated?: boolean;
  enabled?: boolean;
  source?: "project" | "global";
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
  session?: any;
  abortController?: AbortController;
  promise?: Promise<void>;
  pendingSteers?: string[];
  resultConsumed?: boolean;
}

/** Single tool call captured in a turn log. */
export interface ToolCallEntry {
  id: string;
  name: string;
  inputSummary: string;
  resultSummary?: string;
  startedAt: number;
  completedAt?: number;
}

/** One agent-loop iteration. */
export interface TurnEntry {
  turnNumber: number;
  startedAt: number;
  completedAt?: number;
  text: string;
  thinking: string;
  toolCalls: ToolCallEntry[];
}

/** Live activity state for a running agent (widget + session viewer). */
export interface AgentActivity {
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  activeToolNames: Set<string>;
  lastText: string;
  log: TurnEntry[];
  currentTurn: TurnEntry | undefined;
}
