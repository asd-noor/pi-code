# system-prompt extension

Package-wide runtime policy injected into the system prompt on every turn via `before_agent_start`.

## What it covers

Individual extensions own their own domain-specific instructions (ptc rules, code-map tool preferences). This extension covers everything that applies across the whole package.

| Section | Purpose |
|---|---|
| Clarification first | Prefer `ask` over silent assumptions in interactive mode; state defaults explicitly in non-interactive mode |
| Skill routing | Deterministic pass before every non-trivial action to select the right skill |
| Hard triggers | Named skills that must activate for specific task types |
| Library versions | Use `doc-library` to confirm latest API before writing code; flag outdated pins |
| Change safety | Minimal targeted changes; understand context before editing |
| Response style | Concise, path-explicit, no filler |

## Hard triggers

These skills activate unconditionally when the condition is met:

| Condition | Skill |
|---|---|
| Parallel or autonomous work | `subagents` |
| Library API references, code examples, tool docs | `doc-library` |
| Real-time web data, news, research | `web-scout` |

## Library version policy

When any third-party library is involved in planning or implementation:

1. Use `doc-library` to confirm the latest stable version and API — never assume from training data.
2. If the project pins an older version, flag it and ask the user whether to upgrade before proceeding.

## File

`extensions/pi-code-prompt.ts`
