import type { AgendaRow, EvaluationRow, TaskRow, TaskState } from "./types.ts";

export function formatTaskState(state: TaskState): string {
  switch (state) {
    case "completed":  return "[x]";
    case "in_progress": return "[→]";
    default:           return "[ ]";
  }
}

export function formatAgenda(agenda: AgendaRow, tasks: TaskRow[], evaluation: EvaluationRow | null): string {
  const lines: string[] = [
    `Agenda #${agenda.id} [${agenda.state}]`,
    `  Title           : ${agenda.title}`,
    `  Description     : ${agenda.description || "-"}`,
    `  Acceptance guard: ${agenda.acceptance_guard}`,
    `  Revision        : ${agenda.revision}`,
    `  Created         : ${agenda.created_at}`,
    `  Updated         : ${agenda.updated_at}`,
    `  Tasks (${tasks.length}):`,
  ];

  for (const t of tasks) {
    lines.push(`    ${formatTaskState(t.state)} #${t.task_order}: ${t.note}`);
  }

  if (evaluation) {
    lines.push(`  Latest evaluation: ${evaluation.verdict} @ revision ${evaluation.revision} (${evaluation.created_at})`);
  } else {
    lines.push("  Latest evaluation: none");
  }

  return lines.join("\n");
}

export function formatList(rows: AgendaRow[]): string {
  if (rows.length === 0) return "no agendas found";
  const header = "ID  STATE         TITLE";
  const lines = rows.map((row) => `${String(row.id).padEnd(3)} ${row.state.padEnd(13)} ${row.title}`);
  return [header, ...lines].join("\n");
}
