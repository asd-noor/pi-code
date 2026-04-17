# agenda

Structured task tracking with acceptance guards and Ralph-loop completion enforcement. Agendas are stored in a per-project SQLite database.

## Concepts

**Agenda** — a unit of work with a title, description, a list of tasks, and an acceptance guard.

**Acceptance guard** — a plain-text completion criterion defined at agenda creation (e.g. *"All API endpoints return correct status codes"*). The LLM must evaluate itself against this guard before an agenda can be completed.

**Ralph loop** — completion is gated: the LLM must call `agenda_evaluate` with a `pass` verdict on the current revision before `agenda_complete` will succeed. Any subsequent change bumps the revision and makes the evaluation stale, forcing re-evaluation.

## State machines

```
Agenda:  not_started → in_progress ↔ paused → completed  (terminal)
Task:    not_started → in_progress → completed
                                  ↑ (reopen)
```

All transitions are strict — invalid or repeated transitions throw hard errors.

## LLM tools

| Tool | Description |
|---|---|
| `agenda_create` | Create agenda with title, description, acceptance guard, and optional tasks |
| `agenda_list` | List agendas (excludes completed by default; use `all: true` to include) |
| `agenda_get` | Get one agenda with tasks and latest evaluation |
| `agenda_update` | Update metadata or append tasks |
| `agenda_start` | `not_started → in_progress` |
| `agenda_pause` | `in_progress → paused` |
| `agenda_resume` | `paused → in_progress` |
| `agenda_task_start` | Mark task as `in_progress` (agenda must be `in_progress`) |
| `agenda_task_done` | Mark task as `completed` |
| `agenda_task_reopen` | `completed → in_progress` (reopen a task) |
| `agenda_evaluate` | Record acceptance guard evaluation with summary, evidence, and `pass`/`fail` verdict |
| `agenda_complete` | Complete agenda (requires latest eval = `pass` at current revision) |
| `agenda_search` | Search agendas by title, description, or acceptance guard |
| `agenda_delete` | Delete agenda (blocked while `in_progress`) |

## Commands

| Command | Description |
|---|---|
| `/agenda-browser` | Open interactive TUI browser |

## Interactive browser

The browser opens a full-screen overlay with keyboard navigation:

| Key | Action |
|---|---|
| `↑` / `↓` or `j` / `k` | Move selection |
| `s` | Cycle state filter (`all` → `not_started` → `in_progress` → `paused` → `completed`) |
| `u` | Toggle unfinished-only filter |
| `t` | Toggle task list for selected agenda |
| `r` | Refresh data |
| `Esc` / `q` | Close |

## Widget

While any agenda is `in_progress`, a widget appears **above the editor** showing the most recently updated in-progress agenda with its task states:

```
── ✦ In-progress agenda #3 ────────────────────────────────
  Title: Refactor auth module
  Guard: All endpoints tested with correct status codes
      → [1] Update JWT validation
      ✓ [2] Add refresh token endpoint
      ○ [3] Write integration tests
──────────────────────────────────────────────────────────
```

The widget refreshes after every `agenda_*` tool call.

## Storage

SQLite database at `~/.pi/cache/<encoded-project-path>/agenda.sqlite` — one database per project directory.

Use the `project` parameter in any tool to target a different project directory (default: `.`).

## Skill

The `agenda` skill is auto-registered and instructs the LLM on workflow rules, state transitions, and tool usage.
