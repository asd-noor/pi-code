# subagents

Spawn autonomous sub-agents for parallel and delegated work. Each sub-agent runs in its own isolated session with its own tools, model, system prompt, and turn budget.

## LLM tools

| Tool | Description |
|---|---|
| `Subagent` | Launch a sub-agent (foreground or background) |
| `MultiSubagent` | Launch multiple independent sub-agents concurrently in one call |
| `get_subagent_result` | Check status and retrieve results from a background agent |
| `steer_subagent` | Inject a steering message into a running agent mid-run |

### `Subagent` parameters

| Parameter | Type | Description |
|---|---|---|
| `prompt` | string | Task for the agent |
| `description` | string | Short label shown in the UI (3–5 words) |
| `subagent_type` | string | Agent type name (case-insensitive) |
| `model` | string? | Model override — `"provider/modelId"` or fuzzy (`"haiku"`, `"sonnet"`) |
| `thinking` | string? | Thinking level: `off` `minimal` `low` `medium` `high` `xhigh` |
| `max_turns` | number? | Turn limit for this run |
| `run_in_background` | boolean? | Return immediately, notify on completion |
| `resume` | string? | Agent ID to resume from |
| `isolated` | boolean? | Strip extension/MCP tools — built-in tools only |
| `inherit_context` | boolean? | Prepend parent conversation history to prompt |
| `agenda_id` | number? | ID of a `not_started` agenda to assign — subagent will start, execute, evaluate, and complete it |

### `MultiSubagent` parameters

| Parameter | Type | Description |
|---|---|---|
| `tasks` | array | Array of task objects — each accepts the same fields as `Subagent` |
| `run_in_background` | boolean? | Start all agents in background; returns agent IDs immediately |
| `concurrency` | number? | Max agents running simultaneously (default: all tasks at once) |

## Commands

| Command | Description |
|---|---|
| `/subagents` | Open interactive management menu |
| `/delegate` | Delegate a task directly to a named subagent. Usage: `/delegate <agent> [task]` |

## Management menu

```
/subagents
├── Subagents (N) — N active     view running/completed agents
├── Subagent types (N)           browse, edit, disable, delete agent .md files
├── Create new subagent          guided wizard to write a new .md file
└── Settings
    ├── Max concurrency          max parallel background agents (default: 4)
    ├── Default max turns        global turn cap (default: unlimited)
    └── Grace turns              extra turns after soft limit (default: 5)
```

## Agent definitions

Agents are defined as `.md` files with YAML frontmatter. On first install, the bundled defaults are seeded to `~/.pi/agent/agents/` (never overwritten once present).

**Discovery order** (higher priority wins):
1. Project: `.pi/agents/<name>.md`
2. Global: `~/.pi/agent/agents/<name>.md`

### Bundled agents

| Name | Model | Mode | Description |
|---|---|---|---|
| `worker` | inherits parent | append | Implements features, fixes bugs, refactors code, edits files, and handles any multi-step coding task |
| `Explore` | grok-code-fast-1 | replace | Fast codebase exploration agent (read-only) |
| `Research` | claude-haiku-4.5 | replace | Performs comprehensive research on topics, libraries, and APIs using web sources and documentation, with memory integration |
| `memory-compact` | claude-haiku-4.5 | replace | Compacts markdown memory files by snapshotting, summarizing noisy sections into concise bullets, and recreating cleaner memory files |

**`tools` values:**

`tools:` is a **unified allowlist** for all tools — both built-ins and extension tools.

| Value | Effect |
|---|---|
| omitted | All 7 built-in tools active; extension tools controlled by `extensions:` |
| `read, bash, write` | Only those built-ins; extension tools controlled by `extensions:` |
| `read, bash, write, ptc, parallel` | Those built-ins + `ptc` and `parallel` explicitly allowed, regardless of `extensions:` |
| `none` | No built-in tools; extension tools still controlled by `extensions:` |

Non-builtin names (e.g. `ptc`, `parallel`, `agenda_start`) are treated as **explicit extension tool allows** — they are included as long as the extension loaded (i.e. not blocked by `extensions: false` or `isolated: true`).

### Frontmatter reference

```yaml
---
description: One-line description shown in UI
display_name: Display Name
tools: read, bash, grep, find, ls    # or "none" for no built-in tools
extensions: memory-md, agenda        # true (default) | false | csv of extension names
model: anthropic/claude-sonnet-4-5   # omit to inherit parent model
thinking: low                        # off | minimal | low | medium | high | xhigh
max_turns: 30                        # omit for unlimited
prompt_mode: replace                 # replace = body is full prompt | append = appended to parent
isolated: false                      # true strips ALL extension/MCP tools
enabled: true
---

System prompt body here...
```

**`extensions` values:**

| Value | Effect |
|---|---|
| omitted / `true` | All extension tools active (default) |
| `false` | No extension tools — also suppresses `before_agent_start` injections from extensions |
| `memory-md, agenda` | Only tools from the named extensions are active |
| `!memory-md` | All extensions except `memory-md` |
| `!memory-md, !agenda` | All extensions except those listed |

## Widget

While agents are running, a live widget appears **above the editor**:

```
● Subagents
├─ ⠸ general-purpose  refactor auth  ·  ⟳3  ·  12 tools  ·  8.4s
│    ⎿  editing…
└─ ◦ Explore  find deprecated  ·  queued
```

A status bar indicator shows `N running subagents` while agents are active.

## Turn limits

1. At `max_turns`, a steer message is injected: *"You have reached your turn limit. Wrap up immediately."*
2. If the agent doesn't finish within an additional **5 grace turns** (configurable), it is forcefully aborted.

Aborted agents have status `aborted` and return their last assistant text as a partial result.

## Concurrency

Background agents are subject to a concurrency limit (default: **4**). Excess agents queue and start automatically as slots free. Foreground agents always bypass the queue.

## Session viewer

Every agent session is recorded in memory — turns, tool calls with input/result summaries, and assistant text. Open via `/subagents → Subagents → <agent> → View session`. Auto-refreshes every 300ms while running.

## Skill

The `subagents` skill is auto-registered and guides the LLM on when to delegate, how to run parallel work, and how to use resume and steer.

## Custom agent injection

On every `before_agent_start` event the extension scans the agent registry and injects a live `## Custom Agents` section into the system prompt listing all user-defined agents (global + project) with their descriptions. This:

- Ensures the LLM always has an up-to-date view of what specialized agents are available.
- Instructs it to prefer custom agents over the generic defaults, without making it a hard requirement.
- Automatically disappears when no custom agents are installed (nothing is injected).
