import type { AgendaRow, DiscoveryRow, EvaluationRow, TaskRow, TaskState } from "./types.ts";

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
    lines.push(`    ${formatTaskState(t.state)} #${t.task_order}: [NOTE: ${t.note}]`);
  }

  if (evaluation) {
    lines.push(`  Latest evaluation: ${evaluation.verdict} @ revision ${evaluation.revision} (${evaluation.created_at})`);
  } else {
    lines.push("  Latest evaluation: none");
  }

  return lines.join("\n");
}

export function formatDiscovery(row: DiscoveryRow): string {
  const lines: string[] = [
    `Discovery #${row.id} [${row.category}]`,
    `  Agenda   : ${row.agenda_id}`,
    `  Title    : ${row.title}`,
    `  Outcome  : ${row.outcome}`,
  ];
  if (row.source) lines.push(`  Source   : ${row.source}`);
  if (row.detail) lines.push(`  Detail   :\n${row.detail}`);
  lines.push(`  Created  : ${row.created_at}`);
  return lines.join("\n");
}

export function formatDiscoveryList(rows: DiscoveryRow[]): string {
  if (rows.length === 0) return "no discoveries found";
  const header = "ID   CAT       OUTCOME     TITLE";
  const lines = rows.map((r) => {
    const src = r.source ? `  [${r.source}]` : "";
    return `${String(r.id).padEnd(4)} ${r.category.padEnd(9)} ${r.outcome.padEnd(11)} ${r.title}${src}`;
  });
  return [header, ...lines].join("\n");
}

export function formatList(rows: AgendaRow[]): string {
  if (rows.length === 0) return "no agendas found";
  const header = "ID  STATE         TITLE";
  const lines = rows.map((row) => `${String(row.id).padEnd(3)} ${row.state.padEnd(13)} ${row.title}`);
  return [header, ...lines].join("\n");
}

export function formatAgendaDetailed(agenda: AgendaRow, tasks: TaskRow[], evaluation: EvaluationRow | null): string {
  const lines: string[] = [];

  // ANSI color codes
  const cyan    = "\x1b[36m";
  const yellow  = "\x1b[33m";
  const green   = "\x1b[32m";
  const red     = "\x1b[31m";
  const gray    = "\x1b[90m";
  const bold    = "\x1b[1m";
  const reset   = "\x1b[0m";
  const sep     = `${gray}---${reset}`;

  // Header
  lines.push(`${cyan}${bold}Agenda #${agenda.id}${reset} ${gray}[${agenda.state}]${reset}`);
  lines.push("");

  // Title
  lines.push(`${bold}${agenda.title}${reset}`);
  lines.push(sep);

  // Description
  lines.push(`${yellow}Description:${reset}`);
  lines.push(agenda.description || "(none)");
  lines.push(sep);

  // Acceptance Guard
  lines.push(`${yellow}Acceptance Guard:${reset}`);
  lines.push(agenda.acceptance_guard);
  lines.push(sep);

  // Tasks
  lines.push(`${yellow}Tasks (${tasks.length}):${reset}`);
  if (tasks.length === 0) {
    lines.push("(no tasks)");
  } else {
    for (const t of tasks) {
      const stateIcon = formatTaskState(t.state);
      lines.push(`${stateIcon} #${t.task_order}: ${t.note}`);
    }
  }
  lines.push(sep);

  // Latest Evaluation
  lines.push(`${yellow}Latest Evaluation:${reset}`);
  if (evaluation) {
    const verdictColor = evaluation.verdict === "pass" ? green : red;
    const verdictIcon = evaluation.verdict === "pass" ? "✓" : "✗";
    lines.push(`Verdict: ${verdictColor}${evaluation.verdict.toUpperCase()} ${verdictIcon}${reset}`);
    lines.push(`Revision: ${evaluation.revision}`);
    lines.push(`Summary:`);
    lines.push(`  ${evaluation.evaluation_summary}`);
  } else {
    lines.push("(none)");
  }
  lines.push(sep);

  // Metadata
  lines.push(`${yellow}Metadata:${reset}`);
  lines.push(`Revision: ${agenda.revision}`);
  lines.push(`Created:  ${agenda.created_at}`);
  lines.push(`Updated:  ${agenda.updated_at}`);

  return lines.join("\n");
}

