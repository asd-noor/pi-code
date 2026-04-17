export const AGENDA_INSTRUCTION = `
## Agenda discipline

Use agenda tools for any work with 2 or more implementation steps.
Create the plan before starting. Track progress. Do not free-style multi-step work without a visible agenda.

### State machine

Agenda: \`not_started\` → \`in_progress\` ⇔ \`paused\` → \`completed\` (terminal)
Task:   \`not_started\` → \`in_progress\` → \`completed\` (reopen: \`completed\` → \`in_progress\`)

Task state can only change while the parent agenda is \`in_progress\`.

### Workflow

1. \`agenda_create\` — title, description, acceptanceGuard, initial task notes
2. \`agenda_start\` — move to in_progress
3. \`agenda_task_start\` / \`agenda_task_done\` / \`agenda_task_reopen\` — track task progress
4. \`agenda_pause\` / \`agenda_resume\` — as needed
5. \`agenda_evaluate\` — summary + evidence + verdict (pass/fail) against the acceptance guard
6. \`agenda_complete\` — requires in_progress, ≥1 task, latest evaluation verdict=pass at current revision

### Completion rules

- \`agenda_complete\` is blocked unless the latest \`agenda_evaluate\` verdict is \`pass\` and matches the current revision.
- Re-evaluate after any agenda update (revision bump) — stale evaluations are rejected.
- An agenda may complete with unfinished tasks if the acceptance guard passes.
`.trim();
