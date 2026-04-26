/**
 * widget.ts — Live "● Subagents" widget rendered above the editor.
 *
 * Shows running/queued agents with animated spinner.
 * Errors linger for one turn; all other completed agents are immediately removed.
 */

import type { AgentActivity, AgentRecord } from "./types.ts";
import type { AgentManager } from "./agent-manager.ts";

const SPINNER = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];

const TOOL_LABELS: Record<string, string> = {
  read: "reading",
  bash: "running",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding",
  ls: "listing",
};

export function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export class AgentWidget {
  private uiCtx: any = undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  /** Maps agent id → turns-since-finished (linger for errors). */
  private finishedAge = new Map<string, number>();

  constructor(private manager: AgentManager) {}

  setUICtx(ui: any): void { this.uiCtx = ui; }

  onTurnStart(): void {
    for (const [id, age] of this.finishedAge) this.finishedAge.set(id, age + 1);
    this.update();
  }

  markFinished(id: string): void {
    if (!this.finishedAge.has(id)) this.finishedAge.set(id, 0);
  }

  ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.frame++; this.update(); }, 80);
  }

  update(): void {
    if (!this.uiCtx) return;
    const records = this.manager.listRecords();
    const running = records.filter((r) => r.status === "running");
    const queued  = records.filter((r) => r.status === "queued");
    const finished = records.filter(
      (r) => r.status !== "running" && r.status !== "queued"
        && r.completedAt != null && this.shouldShow(r),
    );

    const hasActive   = running.length > 0 || queued.length > 0;
    const hasFinished = finished.length > 0;

    if (!hasActive && !hasFinished) {
      this.uiCtx.setWidget("subagents", undefined);
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      for (const [id] of this.finishedAge) {
        if (!records.some((r) => r.id === id)) this.finishedAge.delete(id);
      }
      return;
    }

    const lines: string[] = ["\u25cf Subagents"];
    const allItems = [...finished, ...running, ...queued];
    allItems.forEach((r, i) => {
      const isLast = i === allItems.length - 1;
      const branch = isLast ? "\u2514\u2500" : "\u251c\u2500";
      const activity = this.manager.getActivity(r.id);
      lines.push(`${branch} ${this.renderRecord(r, activity)}`);
      if (r.status === "running" && activity) {
        const indent = isLast ? "   " : "\u2502  ";
        lines.push(`${indent}  \u23bf  ${this.describeActivity(activity)}`);
      }
    });

    this.uiCtx.setWidget("subagents", lines, { placement: "aboveEditor" });
  }

  private shouldShow(r: AgentRecord): boolean {
    if (r.status !== "error" && r.status !== "aborted") return false;
    return (this.finishedAge.get(r.id) ?? 0) < 1;
  }

  private renderRecord(r: AgentRecord, activity: AgentActivity | undefined): string {
    const elapsed = formatMs(Date.now() - r.startedAt);
    if (r.status === "running") {
      const spin  = SPINNER[this.frame % SPINNER.length];
      const turns = activity ? `\u27f3${activity.turnCount}` : "";
      const tools = activity?.toolUses ? `${activity.toolUses} tools` : "";
      const stats = [turns, tools, elapsed].filter(Boolean).join(" \u00b7 ");
      return `${spin} ${r.type}  ${r.description}  \u00b7  ${stats}`;
    }
    if (r.status === "queued") return `\u25e6 ${r.type}  ${r.description}  \u00b7  queued`;
    const duration = r.completedAt ? formatMs(r.completedAt - r.startedAt) : elapsed;
    const turns    = activity ? `\u27f3${activity.turnCount}` : "";
    const tools    = r.toolUses ? `${r.toolUses} tools` : "";
    const stats    = [turns, tools, duration].filter(Boolean).join(" \u00b7 ");
    if (r.status === "completed") return `\u2713 ${r.type}  ${r.description}  \u00b7  ${stats}`;
    if (r.status === "stopped")   return `\u25a0 ${r.type}  ${r.description}  \u00b7  stopped`;
    if (r.status === "aborted")   return `\u2717 ${r.type}  ${r.description}  \u00b7  aborted`;
    if (r.status === "error")     return `\u2717 ${r.type}  ${r.description}  \u00b7  error`;
    return `? ${r.type}  ${r.description}`;
  }

  private describeActivity(activity: AgentActivity): string {
    if (activity.activeToolNames.size > 0) {
      const toolCounts = new Map<string, number>();
      for (const entry of activity.activeToolNames) {
        const toolName = entry.includes(":") ? entry.split(":").pop()! : entry;
        const label = TOOL_LABELS[toolName] ?? toolName;
        toolCounts.set(label, (toolCounts.get(label) ?? 0) + 1);
      }
      const parts = [...toolCounts.entries()].map(([label, count]) =>
        count > 1 ? `${label} \u00d7${count}` : label,
      );
      return parts.join(", ") + "\u2026";
    }
    if (activity.lastText.trim()) {
      const line = activity.lastText.trim().split("\n")[0] ?? "";
      return line.length > 60 ? line.slice(0, 60) + "\u2026" : line || "thinking\u2026";
    }
    return "thinking\u2026";
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.uiCtx?.setWidget("subagents", undefined);
  }
}
