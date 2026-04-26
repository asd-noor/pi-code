/**
 * session-viewer.ts — Scrollable overlay showing a subagent's session log.
 *
 * Displays completed + in-progress turns with tool calls and assistant text.
 * Auto-refreshes while the agent is running. Close with q / Escape.
 */

import { matchesKey, Key, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { AgentRecord, AgentActivity, TurnEntry } from "./types.ts";
import { formatMs } from "./widget.ts";

// ---- Background helper ----

function applyBgToLines(lines: string[], width: number, t: any, color: string): string[] {
  const SENTINEL = "\uE000";
  const probe = t.bg(color, SENTINEL);
  const idx = probe.indexOf(SENTINEL);
  if (idx <= 0) return lines;
  const bgOpen  = probe.slice(0, idx);
  const bgReset = `\x1b[0m${bgOpen}`;
  return lines.map((line) => {
    const vw  = visibleWidth(line);
    const pad = " ".repeat(Math.max(0, width - vw));
    const content = (line + pad).replace(/\x1b\[0m/g, bgReset);
    return `${bgOpen}${content}\x1b[0m`;
  });
}

// ---- Status decorations ----

const STATUS_ICON: Record<string, string> = {
  running:   "\u27f3",
  queued:    "\u25e6",
  completed: "\u2713",
  error:     "\u2717",
  aborted:   "\u2717",
  stopped:   "\u25a0",
};

const STATUS_COLOR: Record<string, string> = {
  running:   "accent",
  queued:    "muted",
  completed: "success",
  error:     "error",
  aborted:   "error",
  stopped:   "muted",
};

// ---- Main component ----

export class SessionViewer {
  public onClose?: () => void;
  private scrollOffset = 0;

  constructor(
    private record: AgentRecord,
    private getActivity: () => AgentActivity | undefined,
    private theme: any,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const t        = this.theme;
    const activity = this.getActivity();
    const rec      = this.record;
    const isLive   = rec.status === "running" || rec.status === "queued";

    // Header
    const icon  = STATUS_ICON[rec.status]  ?? "?";
    const color = STATUS_COLOR[rec.status] ?? "muted";
    const title = `${icon}  ${rec.type}  \u00b7  ${rec.description}`;
    const statsArr = [
      `${activity?.turnCount ?? rec.turnCount ?? 0} turns`,
      `${activity?.toolUses ?? rec.toolUses ?? 0} tools`,
      rec.completedAt ? formatMs(rec.completedAt - rec.startedAt) : formatMs(Date.now() - rec.startedAt),
    ];
    const headerLines = [
      truncateToWidth(t.fg(color, title), width),
      truncateToWidth(t.fg("muted", statsArr.join("  \u00b7  ")), width),
      t.fg("border", "\u2500".repeat(width)),
    ];

    // Footer
    const footerLines = [
      t.fg("border", "\u2500".repeat(width)),
      truncateToWidth(t.fg("dim", "\u2191\u2193 / PgUp PgDn  scroll    Home End  jump    q / Esc  close"), width),
    ];

    // Content
    const contentLines = this.buildContent(width, activity, isLive);
    const termRows   = (process.stdout.rows || 24);
    const overlayRows = Math.floor(termRows * 0.95);
    const contentH   = Math.max(5, overlayRows - headerLines.length - footerLines.length);

    const maxScroll = Math.max(0, contentLines.length - contentH);
    if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;

    const visible = contentLines.slice(this.scrollOffset, this.scrollOffset + contentH);
    while (visible.length < contentH) visible.push("");

    return applyBgToLines(
      [...headerLines, ...visible, ...footerLines],
      width,
      this.theme,
      "customMessageBg",
    );
  }

  private buildContent(width: number, activity: AgentActivity | undefined, isLive: boolean): string[] {
    const t       = this.theme;
    const log     = activity?.log ?? [];
    const current = isLive ? activity?.currentTurn : undefined;
    const allTurns = current ? [...log, current] : log;

    if (allTurns.length === 0) {
      return ["", truncateToWidth(t.fg("dim", "  (no turns yet)"), width), ""];
    }

    const lines: string[] = [];
    for (const turn of allTurns) {
      const inProgress = turn.completedAt === undefined;
      const turnIcon   = inProgress ? t.fg("accent", "\u25b6") : t.fg("muted", "\u00b7");
      const turnLabel  = inProgress ? t.fg("accent", `Turn ${turn.turnNumber}`) : t.fg("dim", `Turn ${turn.turnNumber}`);
      const turnAge    = turn.completedAt
        ? t.fg("dim", `  ${formatMs(turn.completedAt - turn.startedAt)}`)
        : t.fg("dim", `  ${formatMs(Date.now() - turn.startedAt)}\u2026`);
      lines.push(truncateToWidth(`${turnIcon} ${turnLabel}${turnAge}`, width));

      for (const tc of turn.toolCalls) {
        const done    = tc.completedAt !== undefined;
        const tcIcon  = done ? t.fg("success", "  \u2713") : t.fg("warning", "  \u25b6");
        const tcInput = tc.inputSummary ? t.fg("dim", `  ${tc.inputSummary}`) : "";
        const tcDur   = done && tc.completedAt
          ? t.fg("dim", `  (${formatMs(tc.completedAt - tc.startedAt)})`)
          : "";
        lines.push(truncateToWidth(`${tcIcon} ${t.fg("text", tc.name)}${tcInput}${tcDur}`, width));
        if (done && tc.resultSummary) {
          lines.push(truncateToWidth(`       ${t.fg("dim", tc.resultSummary)}`, width));
        }
      }

      const thinking = turn.thinking?.trim();
      if (thinking) {
        const thinkWidth = Math.max(10, width - 6);
        lines.push(truncateToWidth(`    ${t.fg("dim", "\u27e8thinking\u27e9")}`, width));
        for (const line of wrapTextWithAnsi(thinking, thinkWidth)) {
          lines.push(truncateToWidth(`      ${t.fg("dim", line)}`, width));
        }
        lines.push("");
      }

      const text = turn.text
        .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "")
        .replace(/<function_response>[\s\S]*?<\/function_response>/g, "")
        .replace(/<\/?(?:function_calls|function_response|invoke|parameter)[^>]*>/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (text) {
        const textWidth = Math.max(10, width - 4);
        for (const line of wrapTextWithAnsi(text, textWidth)) {
          lines.push(truncateToWidth(`    ${line}`, width));
        }
      }
      lines.push("");
    }
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
      this.onClose?.();
      return;
    }
    if (matchesKey(data, Key.up))       this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    else if (matchesKey(data, Key.down)) this.scrollOffset++;
    else if (matchesKey(data, Key.pageUp))   this.scrollOffset = Math.max(0, this.scrollOffset - 10);
    else if (matchesKey(data, Key.pageDown)) this.scrollOffset += 10;
    else if (matchesKey(data, Key.home))     this.scrollOffset = 0;
    else if (matchesKey(data, Key.end))      this.scrollOffset = Number.MAX_SAFE_INTEGER;
  }
}
