/**
 * session-viewer.ts — Scrollable overlay that shows a sub-agent's session log.
 *
 * Displays completed + in-progress turns with their tool calls and assistant text.
 * Auto-refreshes while the agent is running.  Closes with q / Escape.
 *
 * Usage (inside a ctx.ui.custom overlay call):
 *
 *   const viewer = new SessionViewer(record, () => manager.getActivity(record.id), theme);
 *   viewer.onClose = () => done(undefined);
 *   return {
 *     render:      (w) => viewer.render(w),
 *     invalidate:  ()  => viewer.invalidate(),
 *     handleInput: (d) => { viewer.handleInput(d); tui.requestRender(); },
 *   };
 */

import { matchesKey, Key, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { AgentRecord, AgentActivity, TurnEntry } from "./types.ts";
import { formatMs } from "./widget.ts";

// ── Background helper ─────────────────────────────────────────────────────────

/**
 * Apply a persistent background colour to an array of rendered lines.
 *
 * Problem: theme.bg() wraps text as "\e[Xm…\e[0m", but lines already contain
 * inner \e[0m resets from fg colours which cancel the background mid-line.
 *
 * Solution:
 *  1. Probe theme.bg() with a known sentinel to extract just the opening
 *     escape sequence (e.g. "\e[48;2;30;30;46m").
 *  2. Pad every line to full width (so the bg fills the row edge-to-edge).
 *  3. Re-inject the bg sequence after every \e[0m inside the line so it
 *     stays active despite inner colour resets.
 */
function applyBgToLines(lines: string[], width: number, t: any, color: string): string[] {
  // Use a private-use sentinel that won't appear in normal ANSI output.
  const SENTINEL = "\uE000";
  const probe    = t.bg(color, SENTINEL);
  const idx      = probe.indexOf(SENTINEL);
  // Couldn't extract — return lines unchanged.
  if (idx <= 0) return lines;

  const bgOpen  = probe.slice(0, idx);           // e.g. "\e[48;2;30;30;46m"
  const bgReset = `\x1b[0m${bgOpen}`;           // full-reset then re-apply bg

  return lines.map((line) => {
    // Pad to full width so the background fills the row.
    const vw  = visibleWidth(line);
    const pad = " ".repeat(Math.max(0, width - vw));
    // Re-apply bg after every SGR reset inside the line.
    const content = (line + pad).replace(/\x1b\[0m/g, bgReset);
    return `${bgOpen}${content}\x1b[0m`;
  });
}

// ── Status decorations ────────────────────────────────────────────────────────

const STATUS_ICON: Record<string, string> = {
  running:   "⟳",
  queued:    "◦",
  completed: "✓",
  error:     "✗",
  aborted:   "✗",
  stopped:   "■",
};

const STATUS_COLOR: Record<string, string> = {
  running:   "accent",
  queued:    "muted",
  completed: "success",
  error:     "error",
  aborted:   "error",
  stopped:   "muted",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Repeat a single-column character exactly `n` times (ANSI-safe). */
function repeat(ch: string, n: number): string {
  return ch.repeat(Math.max(0, n));
}

// ── Main component ────────────────────────────────────────────────────────────

export class SessionViewer {
  public onClose?: () => void;

  private scrollOffset = 0;
  private theme: any;

  constructor(
    private record: AgentRecord,
    private getActivity: () => AgentActivity | undefined,
    theme: any,
  ) {
    this.theme = theme;
  }

  // Called by TUI on theme change — we don't cache, so nothing to do.
  invalidate(): void {}

  // ── Render ──────────────────────────────────────────────────────────────────

  render(width: number): string[] {
    const t = this.theme;
    const activity = this.getActivity();
    const rec = this.record;
    const isLive = rec.status === "running" || rec.status === "queued";

    // ── Header (always visible) ──────────────────────────────────────────────
    const icon  = STATUS_ICON[rec.status]  ?? "?";
    const color = STATUS_COLOR[rec.status] ?? "muted";
    const title = `${icon}  ${rec.type}  ·  ${rec.description}`;

    const statsArr: string[] = [];
    const turnCount = activity?.turnCount ?? rec.turnCount ?? 0;
    const toolUses  = activity?.toolUses  ?? rec.toolUses  ?? 0;
    statsArr.push(`${turnCount} turn${turnCount !== 1 ? "s" : ""}`);
    statsArr.push(`${toolUses} tool${toolUses !== 1 ? "s" : ""}`);
    const elapsed = rec.completedAt
      ? formatMs(rec.completedAt - rec.startedAt)
      : formatMs(Date.now() - rec.startedAt);
    statsArr.push(elapsed);

    const headerLines: string[] = [
      truncateToWidth(t.fg(color, title), width),
      truncateToWidth(t.fg("muted", statsArr.join("  ·  ")), width),
      t.fg("border", repeat("─", width)),
    ];

    // ── Footer (always visible) ──────────────────────────────────────────────
    const footerLines: string[] = [
      t.fg("border", repeat("─", width)),
      truncateToWidth(
        t.fg("dim", "↑↓ / PgUp PgDn  scroll    Home End  jump    q / Esc  close"),
        width,
      ),
    ];

    // ── Content ──────────────────────────────────────────────────────────────
    const contentLines = this.buildContent(width, activity, isLive);

    // Compute visible viewport.
    // Match the overlay's maxHeight: "95%".
    const termRows     = (process.stdout.rows || 24);
    const overlayRows  = Math.floor(termRows * 0.95);
    const contentH     = Math.max(5, overlayRows - headerLines.length - footerLines.length);

    // Clamp scroll so we never scroll past the last line.
    const maxScroll = Math.max(0, contentLines.length - contentH);
    if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;

    const visible = contentLines.slice(this.scrollOffset, this.scrollOffset + contentH);
    // Pad to fill the viewport (keeps footer pinned).
    while (visible.length < contentH) visible.push("");

    return applyBgToLines(
      [...headerLines, ...visible, ...footerLines],
      width,
      this.theme,
      "customMessageBg",
    );
  }

  // ── Build scrollable content lines ──────────────────────────────────────────

  private buildContent(width: number, activity: AgentActivity | undefined, isLive: boolean): string[] {
    const t = this.theme;
    const log: TurnEntry[]      = activity?.log          ?? [];
    const current: TurnEntry | undefined = isLive ? activity?.currentTurn : undefined;

    const allTurns = current ? [...log, current] : log;

    if (allTurns.length === 0) {
      return [
        "",
        truncateToWidth(t.fg("dim", "  (no turns yet — agent hasn't started or sent a message)"), width),
        "",
      ];
    }

    const lines: string[] = [];

    for (const turn of allTurns) {
      const inProgress = turn.completedAt === undefined;

      // Turn header
      const turnIcon   = inProgress ? t.fg("accent", "▶") : t.fg("muted", "·");
      const turnLabel  = inProgress
        ? t.fg("accent", `Turn ${turn.turnNumber}`)
        : t.fg("dim",    `Turn ${turn.turnNumber}`);
      const turnAge = turn.completedAt
        ? t.fg("dim", `  ${formatMs(turn.completedAt - turn.startedAt)}`)
        : t.fg("dim", `  ${formatMs(Date.now() - turn.startedAt)}…`);
      lines.push(truncateToWidth(`${turnIcon} ${turnLabel}${turnAge}`, width));

      // Tool calls
      for (const tc of turn.toolCalls) {
        const done     = tc.completedAt !== undefined;
        const tcIcon   = done ? t.fg("success", "  ✓") : t.fg("warning", "  ▶");
        const tcName   = t.fg("text", tc.name);
        const tcInput  = tc.inputSummary ? t.fg("dim", `  ${tc.inputSummary}`) : "";
        const tcDur    = done && tc.completedAt
          ? t.fg("dim", `  (${formatMs(tc.completedAt - tc.startedAt)})`)
          : "";

        lines.push(truncateToWidth(`${tcIcon} ${tcName}${tcInput}${tcDur}`, width));

        if (done && tc.resultSummary) {
          lines.push(truncateToWidth(`       ${t.fg("dim", tc.resultSummary)}`, width));
        }
      }

      // Thinking block (dimmed, prefixed with ⟨thinking⟩)
      const thinking = turn.thinking?.trim();
      if (thinking) {
        const thinkWidth = Math.max(10, width - 6);
        lines.push(`    ${t.fg("dim", "⟨thinking⟩")}`);
        const wrappedThinking = wrapTextWithAnsi(thinking, thinkWidth);
        for (const line of wrappedThinking) {
          lines.push(`      ${t.fg("dim", line)}`);
        }
        lines.push("");
      }

      // Assistant text
      const text = turn.text.trim();
      if (text) {
        const textWidth = Math.max(10, width - 4);
        const wrapped   = wrapTextWithAnsi(text, textWidth);
        for (const line of wrapped) {
          lines.push(`    ${line}`);
        }
      }

      // Separator between turns
      lines.push("");
    }

    return lines;
  }

  // ── Keyboard handling ────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
      this.onClose?.();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (matchesKey(data, Key.down)) {
      this.scrollOffset++;
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 10);
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset = Math.max(0, this.scrollOffset + 10);
    } else if (matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
    } else if (matchesKey(data, Key.end)) {
      this.scrollOffset = Number.MAX_SAFE_INTEGER; // clamped on next render
    }
  }
}
