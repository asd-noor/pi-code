import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { getTasks, openDb } from "./db.ts";
import type { AgendaRow, TaskRow } from "./types.ts";

function wrapText(text: string, maxWidth: number): string[] {
  if (!text || maxWidth <= 0) return [""];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if (currentLine.length + word.length + 1 <= maxWidth) {
      currentLine += (currentLine ? " " : "") + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines.length > 0 ? lines : [""];
}

export function buildInProgressAgendaWidgetLines(agenda: AgendaRow, tasks: TaskRow[], theme: any, width: number): string[] {
  const b    = (s: string) => theme.fg("borderMuted", s);
  const ac   = (s: string) => theme.fg("accent", s);
  const dim  = (s: string) => theme.fg("dim", s);
  const muted = (s: string) => theme.fg("muted", s);
  const ok   = (s: string) => theme.fg("success", s);
  const warn = (s: string) => theme.fg("warning", s);

  const lines: string[] = [];

  const label    = ` ✦ In-progress agenda #${agenda.id} `;
  const padRight = Math.max(0, width - label.length - 3);
  lines.push(truncateToWidth(b("── ") + ac(label) + b(" " + "─".repeat(padRight)), width));

  // Title with multiline support
  const titlePrefix = `  ${dim("Title:")} `;
  const maxTitleWidth = Math.max(10, width - titlePrefix.length - 2);
  const titleLines = wrapText(agenda.title, maxTitleWidth);
  for (let i = 0; i < titleLines.length; i++) {
    const line = titleLines[i]!;
    if (i === 0) {
      lines.push(truncateToWidth(`${titlePrefix}${ac(theme.bold(line))}`, width));
    } else {
      lines.push(truncateToWidth(`${" ".repeat(titlePrefix.length)}${ac(theme.bold(line))}`, width));
    }
  }

  // Guard with multiline support (no truncation)
  const guardPrefix = `  ${dim("Guard:")} `;
  const maxGuardWidth = Math.max(10, width - guardPrefix.length - 2);
  const guardLines = wrapText(agenda.acceptance_guard, maxGuardWidth);
  for (let i = 0; i < guardLines.length; i++) {
    const line = guardLines[i]!;
    if (i === 0) {
      lines.push(truncateToWidth(`${guardPrefix}${muted(line)}`, width));
    } else {
      lines.push(truncateToWidth(`${" ".repeat(guardPrefix.length)}${muted(line)}`, width));
    }
  }

  // Scroll window: max 5 items centered on active task
  const MAX_ITEMS = 5;
  let activeTaskIdx = tasks.findIndex(t => t.state === "in_progress");
  if (activeTaskIdx === -1) activeTaskIdx = 0;

  let startIdx = 0;
  let endIdx = tasks.length;

  if (tasks.length > MAX_ITEMS) {
    // Center on active task
    startIdx = Math.max(0, activeTaskIdx - Math.floor(MAX_ITEMS / 2));
    endIdx = Math.min(tasks.length, startIdx + MAX_ITEMS);
    
    // Adjust if we're near the end
    if (endIdx - startIdx < MAX_ITEMS) {
      startIdx = Math.max(0, endIdx - MAX_ITEMS);
    }
  }

  const visibleTasks = tasks.slice(startIdx, endIdx);
  
  // Show scroll indicator if needed
  if (startIdx > 0) {
    lines.push(truncateToWidth(`      ${dim("↑ " + String(startIdx) + " more above")}`, width));
  }

  for (const task of visibleTasks) {
    const maxTaskWidth = Math.max(10, width - 12);

    let icon: string;
    let colorFn: (s: string) => string;
    switch (task.state) {
      case "completed":
        icon = ok("✓");
        colorFn = muted;
        break;
      case "in_progress":
        icon = warn("→");
        colorFn = (s: string) => s;
        break;
      default:
        icon = dim("○");
        colorFn = dim;
    }

    const noteLines = wrapText(task.note, maxTaskWidth);
    for (let i = 0; i < noteLines.length; i++) {
      const line = noteLines[i]!;
      if (i === 0) {
        lines.push(truncateToWidth(`      ${icon} ${dim(`[${task.task_order}]`)} ${colorFn(line)}`, width));
      } else {
        lines.push(truncateToWidth(`            ${colorFn(line)}`, width));
      }
    }
  }

  if (endIdx < tasks.length) {
    lines.push(truncateToWidth(`      ${dim("↓ " + String(tasks.length - endIdx) + " more below")}`, width));
  }

  lines.push(truncateToWidth(b("─".repeat(Math.max(4, width))), width));

  return lines;
}

export function refreshAgendaWidget(ctx: ExtensionContext, focusedAgendaId?: number): void {
  const handle = openDb(undefined, ctx.cwd);
  try {
    const agenda = focusedAgendaId != null
      ? handle.db
          .prepare(
            `SELECT id, title, description, acceptance_guard, state, revision, created_at, updated_at
             FROM agendas
             WHERE id = ? AND state = 'in_progress'`,
          )
          .get(focusedAgendaId) as AgendaRow | undefined
      : handle.db
          .prepare(
            `SELECT id, title, description, acceptance_guard, state, revision, created_at, updated_at
             FROM agendas
             WHERE state = 'in_progress'
             ORDER BY updated_at DESC, id DESC
             LIMIT 1`,
          )
          .get() as AgendaRow | undefined;

    if (!agenda) {
      ctx.ui.setWidget("agenda-widget", undefined);
      return;
    }

    const tasks = getTasks(handle.db, agenda.id);
    const width = (process.stdout.columns || 120) - 2;
    ctx.ui.setWidget("agenda-widget", buildInProgressAgendaWidgetLines(agenda, tasks, ctx.ui.theme, width));
  } finally {
    handle.db.close();
  }
}
