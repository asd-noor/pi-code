import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { getTasks, openDb } from "./db.ts";
import { formatTaskState } from "./format.ts";
import type { AgendaBrowserFilters, AgendaBrowserRow, AgendaRow, TaskRow } from "./types.ts";

let agendaBrowserFilters: AgendaBrowserFilters = {
  state: "all",
  withUnfinishedTasks: false,
};

function queryAgendaBrowserRows(cwd: string, filters: AgendaBrowserFilters): AgendaBrowserRow[] {
  const handle = openDb(undefined, cwd);
  try {
    const agendas =
      filters.state === "all"
        ? (handle.db
            .prepare(
              `SELECT id, title, description, acceptance_guard, state, revision, created_at, updated_at
               FROM agendas ORDER BY updated_at DESC, id DESC`,
            )
            .all() as AgendaRow[])
        : (handle.db
            .prepare(
              `SELECT id, title, description, acceptance_guard, state, revision, created_at, updated_at
               FROM agendas WHERE state = ? ORDER BY updated_at DESC, id DESC`,
            )
            .all(filters.state) as AgendaRow[]);

    const rows: AgendaBrowserRow[] = [];
    for (const agenda of agendas) {
      const countRow = handle.db
        .prepare(
          `SELECT COUNT(*) AS total, SUM(CASE WHEN state <> 'completed' THEN 1 ELSE 0 END) AS unfinished
           FROM tasks WHERE agenda_id = ?`,
        )
        .get(agenda.id) as { total?: number; unfinished?: number };

      const total     = Number(countRow.total || 0);
      const unfinished = Number(countRow.unfinished || 0);
      if (filters.withUnfinishedTasks && agenda.state === "completed") continue;

      rows.push({ agenda, total, unfinished });
    }

    return rows;
  } finally {
    handle.db.close();
  }
}

export async function openAgendaBrowserInteractive(ctx: ExtensionContext): Promise<number | undefined> {
  if (!ctx.hasUI) {
    throw new Error("/agenda-browser requires interactive UI mode (not available in print/json mode)");
  }

  const stateOrder: Array<AgendaBrowserFilters["state"]> = ["all", "not_started", "in_progress", "paused", "completed"];

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    // ── colour helpers ────────────────────────────────────────────────────────
    const b   = (s: string) => theme.fg("borderMuted", s);
    const ba  = (s: string) => theme.fg("borderAccent", s);
    const ac  = (s: string) => theme.fg("accent", s);
    const dim = (s: string) => theme.fg("dim", s);
    const mut = (s: string) => theme.fg("muted", s);
    const ok  = (s: string) => theme.fg("success", s);
    const err = (s: string) => theme.fg("error", s);
    const wrn = (s: string) => theme.fg("warning", s);

    const stateColor = (state: string) => {
      switch (state) {
        case "completed":   return ok;
        case "in_progress": return wrn;
        case "paused":      return mut;
        default:            return dim;
      }
    };

    // ── state ─────────────────────────────────────────────────────────────────
    let filters: AgendaBrowserFilters   = { ...agendaBrowserFilters };
    let rows: AgendaBrowserRow[]        = [];
    let selected                        = 0;
    let showTasks                       = false;
    let selectedTasks: TaskRow[]        = [];
    let selectedTasksAgendaId: number | undefined;
    let selectedTasksError: string | undefined;
    let selectedAgendaId: number | undefined;
    let contentLines: string[]          = [];

    // ── task reload ───────────────────────────────────────────────────────────
    const reloadSelectedTasks = (force = false) => {
      if (!showTasks) {
        selectedTasks          = [];
        selectedTasksAgendaId  = undefined;
        selectedTasksError     = undefined;
        return;
      }
      const current = rows[selected];
      if (!current) {
        selectedTasks          = [];
        selectedTasksAgendaId  = undefined;
        selectedTasksError     = undefined;
        return;
      }
      if (!force && selectedTasksAgendaId === current.agenda.id) return;

      const handle = openDb(undefined, ctx.cwd);
      try {
        selectedTasks         = getTasks(handle.db, current.agenda.id);
        selectedTasksAgendaId = current.agenda.id;
        selectedTasksError    = undefined;
      } catch (error) {
        selectedTasks         = [];
        selectedTasksAgendaId = current.agenda.id;
        selectedTasksError    = error instanceof Error ? error.message : String(error);
      } finally {
        handle.db.close();
      }
    };

    // ── data reload ───────────────────────────────────────────────────────────
    const reload = () => {
      try {
        rows = queryAgendaBrowserRows(ctx.cwd, filters);
        if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
        errorMessage = undefined;
      } catch (error) {
        rows         = [];
        selected     = 0;
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      reloadSelectedTasks(true);
    };

    // ── build content lines ───────────────────────────────────────────────────
    const buildLines = () => {
      const lines: string[] = [];

    lines.push(dim("↑/↓ j/k move · t tasks · s state · u unfinished · r refresh · enter focus · esc/q close"));

      const stateTag = stateColor(filters.state)(`state=${filters.state}`);
      const unfinTag = filters.withUnfinishedTasks ? wrn("unfinished=yes") : dim("unfinished=no");
      const tasksTag = showTasks ? ac("tasks=yes") : dim("tasks=no");
      lines.push(`${stateTag}  ${unfinTag}  ${tasksTag}`);

      if (errorMessage) {
        lines.push(err(`error: ${errorMessage}`));
      } else if (rows.length === 0) {
        lines.push(dim("no agendas match current filters"));
      } else {
        lines.push("");
        const start = Math.max(0, selected - 8);
        const end   = Math.min(rows.length, start + 16);

        for (let i = start; i < end; i++) {
          const row       = rows[i]!;
          const completed = row.total - row.unfinished;
          const isSel     = i === selected;
          const prefix    = isSel ? ac("▶") : dim("·");
          const sc        = stateColor(row.agenda.state);
          const badge     = sc(`[${row.agenda.state}]`);
          const idStr     = dim(`#${row.agenda.id}`);
          const titleStr  = isSel ? theme.bold(ac(row.agenda.title)) : row.agenda.title;
          lines.push(`${prefix} ${idStr} ${badge} ${titleStr}`);
          lines.push(dim(`     tasks ${completed}/${row.total} · rev ${row.agenda.revision}`));
        }

        const current = rows[selected];
        if (current) {
          lines.push("");
          lines.push("§DIVIDER§Selected");

          lines.push(`  ${dim("guard: ")}${mut(current.agenda.acceptance_guard)}`);
          if (current.agenda.description) {
            lines.push(dim(`  desc:  ${current.agenda.description}`));
          }

          if (showTasks) {
            lines.push("§DIVIDER§Tasks");
            if (selectedTasksError) {
              lines.push(err(`  error: ${selectedTasksError}`));
            } else if (selectedTasks.length === 0) {
              lines.push(dim("  (no tasks)"));
            } else {
              for (const task of selectedTasks) {
                lines.push(`  ${formatTaskState(task.state)} ${dim(`[${task.task_order}]`)} ${task.note}`);
              }
            }
          }
        }
      }

      contentLines = lines;
    };

    // ── bordered render ───────────────────────────────────────────────────────
    const renderBordered = (width: number): string[] => {
      const inner = Math.max(6, width - 2);
      const out: string[] = [];

      const titleLabel = " Agenda Browser ";
      const topFill    = Math.max(0, inner - titleLabel.length - 1);
      out.push(b("┌") + b("─") + ba(titleLabel) + b("─".repeat(topFill)) + b("┐"));

      for (const line of contentLines) {
        if (line.startsWith("§DIVIDER§")) {
          const label = ` ${line.slice(9)} `;
          const fill  = Math.max(0, inner - label.length - 3);
          out.push(b("├") + b("───") + dim(label) + b("─".repeat(fill)) + b("┤"));
        } else {
          const padded = truncateToWidth(` ${line} `, inner, "…", true);
          out.push(b("│") + padded + b("│"));
        }
      }

      out.push(b("└") + b("─".repeat(inner)) + b("┘"));
      return out;
    };

    // ── combined refresh ──────────────────────────────────────────────────────
    const refresh = () => {
      buildLines();
      tui.requestRender();
    };

    const close = (selectCurrent = false) => {
      agendaBrowserFilters = { ...filters };
      if (selectCurrent && rows[selected]?.agenda.state === "in_progress") {
        selectedAgendaId = rows[selected]!.agenda.id;
      }
      done(selectedAgendaId);
    };

    // initial load
    reload();
    buildLines();

    return {
      render:      (width) => renderBordered(width),
      invalidate:  () => {},
      handleInput: (data: string) => {
        if (matchesKey(data, Key.escape) || data === "q" || data === "Q") { close(); return; }
        if (matchesKey(data, Key.return)) { close(true); return; }
        if (matchesKey(data, Key.down) || data === "j") {
          if (rows.length > 0) { selected = Math.min(rows.length - 1, selected + 1); reloadSelectedTasks(true); refresh(); }
          return;
        }
        if (matchesKey(data, Key.up) || data === "k") {
          if (rows.length > 0) { selected = Math.max(0, selected - 1); reloadSelectedTasks(true); refresh(); }
          return;
        }
        if (data === "s" || data === "S") {
          const idx = stateOrder.indexOf(filters.state);
          filters.state = stateOrder[(idx + 1) % stateOrder.length];
          selected = 0; reload(); refresh(); return;
        }
        if (data === "u" || data === "U") {
          filters.withUnfinishedTasks = !filters.withUnfinishedTasks;
          selected = 0; reload(); refresh(); return;
        }
        if (data === "t" || data === "T") {
          showTasks = !showTasks; reloadSelectedTasks(true); refresh(); return;
        }
        if (data === "r" || data === "R") { reload(); refresh(); }
      },
    };
  });
}
