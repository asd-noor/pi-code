# agenda

Structured task tracking with acceptance guards and Ralph-loop completion enforcement. Agendas are stored in a per-project SQLite database.

## Concepts

**Agenda** — a unit of work with a title, description, a list of tasks, an acceptance guard, and an optional discoveries log.

**Discovery** — an append-only knowledge artifact attached to an agenda, recording what was found during work: code searches, web research, library lookups, and expected or unexpected findings. Discoveries do not affect the revision counter and are outside the Ralph loop.

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
| `agenda_create` | Create agenda with title, description, acceptance guard, optional tasks, and optional pre-filled discoveries |
| `agenda_list` | List agendas (excludes completed by default; use `all: true` to include) |
| `agenda_get` | Get one agenda with tasks and latest evaluation |
| `agenda_update` | Update metadata or append tasks |
| `agenda_start` | `not_started → in_progress` |
| `agenda_pause` | `in_progress → paused` |
| `agenda_resume` | `paused → in_progress` |
| `agenda_task_start` | Mark task as `in_progress` (agenda must be `in_progress`) |
| `agenda_task_done` | Mark task as `completed` |
| `agenda_task_reopen` | `completed → in_progress` (reopen a task) |
| `agenda_evaluate` | Record acceptance guard evaluation with summary, evidence, and `pass`/`fail` verdict (agenda must be `in_progress`) |
| `agenda_complete` | Complete agenda (requires latest eval = `pass` at current revision; unfinished tasks are allowed if the acceptance guard passes) |
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
| `Enter` | Focus selected in-progress agenda in the widget |
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

## Discoveries

Discoveries are an append-only knowledge log attached to an agenda. They capture what the agent finds during work — search results, API findings, unexpected behaviours, confirmed assumptions — and serve as a bridge to the memory store after the agenda completes.

### Fields

| Field | Values | Notes |
|---|---|---|
| `category` | `code` \| `web` \| `library` \| `finding` | Type of search or finding |
| `title` | string | Short, scannable summary |
| `detail` | string | Full body — can be long-form prose |
| `outcome` | `expected` \| `unexpected` \| `neutral` | Default: `neutral` |
| `source` | string | Optional — URL, file path, tool name, or query |

### Lifecycle gating

| Operation | Allowed states |
|---|---|
| Pre-fill via `agenda_create` `discoveries` param | `not_started` (creation moment) |
| `agenda_discovery_add` | `in_progress` only |
| `agenda_discovery_delete` | any except `completed` |
| `agenda_discovery_get` / `agenda_discovery_list` | any (read-only) |

Discoveries do **not** bump the agenda revision and have no effect on the Ralph loop.

### Discovery tools

| Tool | Description |
|---|---|
| `agenda_discovery_add` | Add a discovery to an `in_progress` agenda |
| `agenda_discovery_get` | Get full detail of a single discovery |
| `agenda_discovery_list` | List all discoveries (compact); optional `category` filter |
| `agenda_discovery_delete` | Delete a discovery (agenda must not be `completed`) |

### Memory integration

After `agenda_complete`, distill discoveries into the memory store:

| Category | Target memory file |
|---|---|
| `code` | `architecture.md` — codebase patterns, module relationships, constraints |
| `library` | `architecture.md` or `setup.md` — API findings, version constraints |
| `web` | `notes.md` — research findings, external references |
| `finding` (unexpected) | `decisions.md` or `notes.md` — gotchas, surprises, lessons learned |
| `finding` (expected) | Skip unless it contains durable reference value |

Use `agenda_discovery_get` to fetch the full `detail` body before writing to memory if the list view is too brief.

## Instruction injection

The agenda extension injects workflow rules, state transitions, and tool usage guidance into the LLM system prompt via the `before_agent_start` event. Primary agents receive the full `AGENDA_INSTRUCTION`; subagents assigned an agenda ID receive a targeted instruction via `buildSubagentAgendaInstruction(id)`.
