# pi-code

A curated pi package bundling custom extensions, skills, and system instructions for an enhanced coding experience.

## System Instructions

| Instruction | Description |
|---|---|
| [system-prompt](./docs/system-prompt.md) | Package-wide runtime policy: skill routing, library versions, clarification, change safety |
| [ptc](./docs/ptc.md) | Programmatic Tool Calling — always-on preference for scripts over multi-hop tool calls |
| code-map | Code intelligence tool preferences — injected by the code-map extension |

## Extensions

| Extension | Description |
|---|---|
| [agenda](./docs/agenda.md) | Structured task tracking with acceptance guards and Ralph-loop completion |
| [subagents](./docs/subagents.md) | Spawn autonomous sub-agents for parallel and delegated work |
| [code-map](./docs/code-map.md) | LSP-backed code intelligence: outline, symbol, diagnostics, impact |
| [memory-md](./docs/memory-md.md) | Persistent markdown-backed memory store with hybrid FTS + vector search |

## Skills

| Skill | Description |
|---|---|
| [subagents](./docs/subagents.md) | Delegate parallel or autonomous work to sub-agents |
| [doc-library](./docs/doc-library.md) | Look up latest library docs and API references via Context7 |
| [web-scout](./docs/web-scout.md) | Real-time web research, content extraction, and site mapping via Tavily |

## Dependencies

| Package | Purpose |
|---|---|
| [pi-mcporter](https://github.com/mavam/pi-mcporter) | MCP bridge — required by `doc-library` and `web-scout` skills |
| [pi-ask-tool-extension](https://github.com/devkade/pi-ask-tool) | `ask` tool — tabbed questioning and inline note editing for interactive clarification |

## Installation

```bash
pi install /path/to/pi-code        # global
pi install -l /path/to/pi-code     # project-local
```

## Requirements

- Pi coding agent (latest)
- Node.js 22+ (for `node:sqlite` used by agenda)
- Bun (for spawning the code-map daemon)
- `memory-md` binary in PATH (for memory extension)
- `mcporter` binary in PATH (for `pi-mcporter` — required by doc-library and web-scout skills)
- MCP servers configured for `pi-mcporter` (for doc-library and web-scout skills)
- `pi-ask-tool-extension` bundled (provides the `ask` tool used throughout the system prompt for interactive clarification)
