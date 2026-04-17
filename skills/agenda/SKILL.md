---
name: agenda
description: Use agenda_* tools to manage agenda-based execution with an agenda-level acceptance guard and Ralph-loop completion enforcement.
---

# agenda-manager

Use this skill for multi-step work tracked as an **agenda** (collection of short task notes).

## Model

- **Agenda** has states: `not_started` → `in_progress` ↔ `paused` → `completed`
- **Task** has states: `not_started` | `in_progress` | `completed`
- Acceptance guard exists at **agenda level**

## Hard rules

1. Task state can be changed **only when the parent agenda is `in_progress`**.
2. Task transitions are strict:
   - `not_started -> in_progress`
   - `in_progress -> completed`
   - `reopen` means `completed -> in_progress`
   - Any other transition is rejected with a hard error.
3. Agenda transitions are strict:
   - `agenda_start`: `not_started -> in_progress`
   - `agenda_pause`: `in_progress -> paused`
   - `agenda_resume`: `paused -> in_progress`
   - `agenda_complete`: `in_progress -> completed`
   - `completed` is terminal (no reopen)
   - invalid or repeated transitions are hard errors.
4. `agenda_complete` requires:
   - agenda state is `in_progress`
   - agenda has at least 1 task
   - latest `agenda_evaluate` verdict is `pass`
   - latest evaluation matches current agenda revision (not stale)
5. Agenda can be completed even if some tasks remain undone, as long as guard evaluation passes.

## Workflow

1. Create agenda (`agenda_create`) with `acceptanceGuard` and short task notes.
2. Start agenda (`agenda_start`).
3. Pause/resume as needed (`agenda_pause`, `agenda_resume`).
4. Move task states as work progresses (`agenda_task_start`, `agenda_task_done`, `agenda_task_reopen`).
5. Evaluate acceptance guard (`agenda_evaluate`) with summary + evidence + verdict.
6. Complete agenda (`agenda_complete`) once guard passes.

## Tool quick reference

- `agenda_create`
- `agenda_list`
- `agenda_get`
- `agenda_update`
- `agenda_start`
- `agenda_pause`
- `agenda_resume`
- `agenda_task_start`
- `agenda_task_done`
- `agenda_task_reopen`
- `agenda_evaluate`
- `agenda_complete`
- `agenda_search`
- `agenda_delete`
