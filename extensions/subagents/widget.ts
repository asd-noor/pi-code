/**
 * widget.ts — Live "● Agents" widget rendered above the editor.
 *
 * Shows running agents with animated spinner, stats, and activity.
 * Completed agents linger for one turn before disappearing.
 * Uses only the stable setWidget / setStatus ctx.ui APIs — no custom TUI components.
 */

import type { AgentActivity, AgentRecord } from "./types.ts";
import type { AgentManager } from "./agent-manager.ts";

// Braille spinner frames
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const TOOL_LABELS: Record<string, string> = {
  read: "reading",
  bash: "running",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding",
  ls: "listing",
};

/** How many turns a finished agent stays visible (errors linger longer). */
const LINGER_TURNS_SUCCESS = 0;
const LINGER_TURNS_ERROR = 1;

export class AgentWidget {
  private uiCtx: any = undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  /** Maps agent id → turns-since-finished (for linger logic). */
  private finishedAge = new Map<string, number>();

  constructor(private manager: AgentManager) {}

  /** Capture the ui context from the first tool_execution_start. */
  setUICtx(ui: any): void {
    this.uiCtx = ui;
  }

  /** Call on every new turn so finished agents age out. */
  onTurnStart(): void {
    for (const [id, age] of this.finishedAge) {
      this.finishedAge.set(id, age + 1);
    }
    this.update();
  }

  /** Mark an agent as newly finished (starts linger clock). */
  markFinished(id: string): void {
    if (!this.finishedAge.has(id)) {
      this.finishedAge.set(id, 0);
    }
  }

  /** Ensure the animation timer is running. */
  ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.frame++;
      this.update();
    }, 80);
  }

  /** Render and push the widget. Call directly to force a refresh. */
  update(): void {
    if (!this.uiCtx) return;

    const records = this.manager.listRecords();
    const running = records.filter((r) => r.status === "running");
    const queued = records.filter((r) => r.status === "queued");
    const finished = records.filter(
      (r) => r.status !== "running" && r.status !== "queued" && r.completedAt != null
        && this.shouldShow(r),
    );

    const hasActive = running.length > 0 || queued.length > 0;
    const hasFinished = finished.length > 0;

    // Nothing to show — clear widget and stop timer
    if (!hasActive && !hasFinished) {
      this.uiCtx.setWidget("subagents", undefined);
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      // Prune stale linger entries
      for (const [id] of this.finishedAge) {
        if (!records.some((r) => r.id === id)) this.finishedAge.delete(id);
      }
      return;
    }

    // Build widget lines (plain strings — no theme, just ASCII)
    const lines: string[] = ["● Subagents"];
    const allItems = [...finished, ...running, ...queued];

    allItems.forEach((r, i) => {
      const isLast = i === allItems.length - 1;
      const branch = isLast ? "└─" : "├─";
      const activity = this.manager.getActivity(r.id);
      lines.push(`${branch} ${this.renderRecord(r, activity)}`);
      if ((r.status === "running") && activity) {
        const indent = isLast ? "   " : "│  ";
        lines.push(`${indent}  ⎿  ${this.describeActivity(activity)}`);
      }
    });

    this.uiCtx.setWidget("subagents", lines, { placement: "aboveEditor" });
  }

  private shouldShow(r: AgentRecord): boolean {
    if (r.status !== "error" && r.status !== "aborted") return false;
    const age = this.finishedAge.get(r.id) ?? 0;
    return age < LINGER_TURNS_ERROR;
  }

  private renderRecord(r: AgentRecord, activity: AgentActivity | undefined): string {
    const displayName = r.type;
    const elapsed = formatMs(Date.now() - r.startedAt);

    if (r.status === "running") {
      const spin = SPINNER[this.frame % SPINNER.length];
      const turns = activity ? `⟳${activity.turnCount}` : "";
      const tools = activity?.toolUses ? `${activity.toolUses} tools` : "";
      const stats = [turns, tools, elapsed].filter(Boolean).join(" · ");
      return `${spin} ${displayName}  ${r.description}  ·  ${stats}`;
    }

    if (r.status === "queued") {
      return `◦ ${displayName}  ${r.description}  ·  queued`;
    }

    // Finished
    const duration = r.completedAt ? formatMs(r.completedAt - r.startedAt) : elapsed;
    const turns = activity ? `⟳${activity.turnCount}` : "";
    const tools = r.toolUses ? `${r.toolUses} tools` : "";
    const stats = [turns, tools, duration].filter(Boolean).join(" · ");

    if (r.status === "completed") return `✓ ${displayName}  ${r.description}  ·  ${stats}`;
    if (r.status === "stopped")   return `■ ${displayName}  ${r.description}  ·  stopped`;
    if (r.status === "aborted")   return `✗ ${displayName}  ${r.description}  ·  aborted`;
    if (r.status === "error")     return `✗ ${displayName}  ${r.description}  ·  error`;
    return `? ${displayName}  ${r.description}`;
  }

  private describeActivity(activity: AgentActivity): string {
    if (activity.activeToolNames.size > 0) {
      const toolCounts = new Map<string, number>();
      for (const entry of activity.activeToolNames) {
        // entries are "toolCallId:toolName"
        const toolName = entry.includes(":") ? entry.split(":").pop()! : entry;
        const label = TOOL_LABELS[toolName] ?? toolName;
        toolCounts.set(label, (toolCounts.get(label) ?? 0) + 1);
      }
      const parts = [...toolCounts.entries()].map(([label, count]) =>
        count > 1 ? `${label} ×${count}` : label,
      );
      return parts.join(", ") + "…";
    }
    if (activity.lastText.trim()) {
      const line = activity.lastText.trim().split("\n")[0] ?? "";
      return line.length > 60 ? line.slice(0, 60) + "…" : line || "thinking…";
    }
    return "thinking…";
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.uiCtx?.setWidget("subagents", undefined);
  }
}

function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Compact token formatter. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k tok`;
  return `${n} tok`;
}

export { formatMs };
