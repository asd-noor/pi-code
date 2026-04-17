---
name: subagents
description: Launch and manage autonomous sub-agents with the Agent, get_subagent_result, and steer_subagent tools. Use when delegating complex tasks to specialized agents, running parallel work in the background, or resuming/steering an in-progress agent.
---

# subagents

Use this skill when you need to delegate tasks to specialized sub-agents.

## Tools

- **`Agent`** — Launch a subagent (foreground or background).
- **`get_subagent_result`** — Check status / retrieve result from a background agent by ID.
- **`steer_subagent`** — Inject a message into a running agent's conversation mid-run.

## Available agent types

Default agents (always available):
- `general-purpose` — Full tools, all built-in tools, inherits parent model
- `Explore` — Read-only codebase search, runs on haiku
- `Plan` — Read-only architecture planning, runs on haiku

Custom agents: defined in `.pi/agents/<name>.md` (project) or `~/.pi/agent/agents/<name>.md` (global).

## When to use each agent

| Task | Agent |
|---|---|
| Searching files / understanding code | `Explore` |
| Designing a plan before coding | `Plan` |
| Editing files, writing code, running commands | `general-purpose` |
| Specialized task (review, test writing, etc.) | custom agent |

## Patterns

### Foreground (blocking)
```
Agent(prompt="...", description="refactor auth", subagent_type="general-purpose")
```

### Background (parallel)
```
Agent(prompt="...", description="search logs", subagent_type="Explore", run_in_background=true)
Agent(prompt="...", description="design plan",  subagent_type="Plan",    run_in_background=true)
# You will be notified when each completes. Then retrieve with:
get_subagent_result(agent_id="<id>")
```

### Steering a running agent
```
steer_subagent(agent_id="<id>", message="Focus on the auth module only.")
```

### Resume a previous agent
```
Agent(prompt="Now also update the tests.", resume="<id>", subagent_type="general-purpose", description="update tests")
```

## Guidelines

- Run independent work in parallel with `run_in_background: true`.
- Foreground agents block the parent — use only when you need the result immediately.
- Use `Explore` or `Plan` (haiku, read-only) for cheaper exploration before committing to edits.
- Provide a clear, self-contained `prompt` — subagents start with a fresh context window.
- Use `inherit_context: true` only when the agent genuinely needs the parent chat history.
- Use `model` param to override (e.g. `"haiku"`, `"sonnet"`, `"anthropic/claude-opus-4-5"`).
- Use `thinking: "high"` for complex reasoning tasks.
- Use `isolated: true` to restrict the agent to built-in tools only (no MCP/extensions).

## /subagents command

Run `/subagents` for the interactive management menu:
- View and abort running agents
- Browse, edit, disable, or delete agent types
- Create new custom agents
- Adjust concurrency and turn limits
