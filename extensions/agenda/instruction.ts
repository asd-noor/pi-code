/**
 * instruction.ts — Agenda system-prompt instructions.
 *
 * AGENDA_INSTRUCTION: injected into the primary agent via before_agent_start.
 * buildSubagentAgendaInstruction: injected into subagents when an agenda_id is assigned.
 */

/**
 * Primary-agent agenda instruction.
 * Covers self-executing workflow AND the delegation pattern (create → pass id → subagent executes).
 */
export const AGENDA_INSTRUCTION = `
## Agenda discipline

Use agenda tools for any work with 2 or more implementation steps.
Create the plan before starting. Track progress. Do not free-style multi-step work without a visible agenda.

### State machine

Agenda: \`not_started\` → \`in_progress\` ⇔ \`paused\` → \`completed\` (terminal)
Task:   \`not_started\` → \`in_progress\` → \`completed\` (reopen: \`completed\` → \`in_progress\`)

Task state can only change while the parent agenda is \`in_progress\`.

### Workflow — self-executing (no delegation)

1. \`agenda_create\` — title, description, acceptanceGuard, initial task notes
2. \`agenda_start\` — move to in_progress
3. \`agenda_task_start\` / \`agenda_task_done\` / \`agenda_task_reopen\` — track task progress
4. \`agenda_pause\` / \`agenda_resume\` — as needed
5. \`agenda_evaluate\` — summary + evidence + verdict (pass/fail) against the acceptance guard
6. \`agenda_complete\` — requires in_progress, ≥1 task, latest evaluation verdict=pass at current revision

### Workflow — delegating to a subagent

When delegating multi-step work to a subagent:
1. \`agenda_create\` — define title, description, acceptanceGuard, and all tasks; the agenda stays in \`not_started\`
2. Pass the returned \`agenda_id\` to the \`Subagent\` tool via the \`agenda_id\` parameter
3. The subagent will start, execute each task, evaluate, and complete the agenda
4. For background subagents: retrieve the result with \`get_subagent_result\` when ready

### Completion rules

- \`agenda_complete\` is blocked unless the latest \`agenda_evaluate\` verdict is \`pass\` and matches the current revision.
- Re-evaluate after any agenda update (revision bump) — stale evaluations are rejected.
- An agenda may complete with unfinished tasks if the acceptance guard passes.
`.trim();

/**
 * Subagent agenda instruction — injected when the Subagent tool passes an agenda_id.
 * Tells the subagent exactly which agenda to execute and how.
 */
export function buildSubagentAgendaInstruction(agendaId: number): string {
  return `
## Assigned Agenda

You have been assigned agenda #${agendaId}. Follow this workflow exactly:

1. \`agenda_start\` — move the agenda to in_progress (it is currently not_started)
2. For each task: \`agenda_task_start\` → do the work → \`agenda_task_done\`
   - Reopen a task with \`agenda_task_reopen\` if it needs revision
   - Use \`agenda_pause\` / \`agenda_resume\` if you need to pause mid-work
3. \`agenda_evaluate\` — evaluate against the acceptance guard (verdict: pass or fail)
   - Re-evaluate after any changes that bump the revision
4. \`agenda_complete\` — requires in_progress state, ≥1 task, and latest verdict=pass

After completing the agenda, report back with a concise summary of what was done.

**Do not create your own agendas. Work only on agenda #${agendaId}.**
`.trim();
}
