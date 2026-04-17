import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { getTasks, openDb } from "./db.ts";
import type { AgendaRow, TaskRow } from "./types.ts";

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

  const titlePrefix = `  ${dim("Title:")} `;
  const maxTitle    = Math.max(10, width - 10);
  const title       = agenda.title.length > maxTitle ? `${agenda.title.slice(0, maxTitle - 1)}…` : agenda.title;
  lines.push(truncateToWidth(`${titlePrefix}${ac(theme.bold(title))}`, width));

  const maxGuard = Math.max(10, width - 10);
  const guard    =
    agenda.acceptance_guard.length > maxGuard
      ? `${agenda.acceptance_guard.slice(0, maxGuard - 1)}…`
      : agenda.acceptance_guard;
  lines.push(truncateToWidth(`  ${dim("Guard:")} ${muted(guard)}`, width));

  for (const task of tasks) {
    const maxTask = Math.max(10, width - 12);
    const short   = task.note.length > maxTask ? `${task.note.slice(0, maxTask - 1)}…` : task.note;

    let icon: string;
    let text: string;
    switch (task.state) {
      case "completed":
        icon = ok("✓");
        text = muted(short);
        break;
      case "in_progress":
        icon = warn("→");
        text = short;
        break;
      default:
        icon = dim("○");
        text = dim(short);
    }

    lines.push(truncateToWidth(`      ${icon} ${dim(`[${task.task_order}]`)} ${text}`, width));
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
    ctx.ui.setWidget("agenda-widget", (_tui, theme) => ({
      render: (w: number) => buildInProgressAgendaWidgetLines(agenda, tasks, theme, w),
      invalidate: () => {},
    }));
  } finally {
    handle.db.close();
  }
}
