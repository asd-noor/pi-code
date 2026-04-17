# pi-code

**Version 1.6.2**

A curated pi package bundling custom extensions, skills, and system instructions for an enhanced coding experience with the Pi coding agent.

## Overview

`pi-code` provides a complete toolkit for advanced coding workflows, combining structured task management, code intelligence, persistent memory, parallel execution, skill-based delegation, and programmatic tool calling. It integrates with MCP servers for library documentation and web research.

## System Instructions

Package-wide runtime policies are injected into the system prompt on every turn:

| Instruction | Description |
|---|---|
| [pi-code-prompt](./docs/system-prompt.md) | Package-wide runtime policy: skill routing, library versions, clarification-first, change safety, tool selection |
| [ptc](./docs/ptc.md) | Programmatic Tool Calling — always-on preference for scripts over multi-hop tool calls |
| code-map | Code intelligence tool preferences — injected by the code-map extension |
| agenda | Structured task management instructions — injected when agenda is active |

## Extensions

All extensions are automatically loaded from `./extensions/`:

| Extension | Description | Type |
|---|---|---|
| [agenda](./docs/agenda.md) | Structured task tracking with acceptance guards and Ralph-loop completion | Directory |
| [code-map](./docs/code-map.md) | LSP-backed code intelligence: outline, symbol, diagnostics, impact | Directory |
| [memory-md](./docs/memory-md.md) | Persistent markdown-backed memory store with hybrid FTS + vector search | Directory |
| [subagents](./docs/subagents.md) | Spawn autonomous sub-agents for parallel and delegated work | Directory |
| [parallel](./docs/parallel.md) | Fan out multiple independent operations (read/bash/write/edit/ptc) in one call | Standalone |
| [pi-code-prompt](./docs/system-prompt.md) | Package-wide runtime policy injection | Standalone |
| [ptc](./docs/ptc.md) | Programmatic Tool Calling — run Python/bash scripts in a single call with MCP access | Standalone |

## Skills

Skills provide specialized capabilities for specific task types:

| Skill | Description | Location |
|---|---|---|
| [doc-library](./docs/doc-library.md) | Look up latest library docs and API references via Context7 (MCP) | `./skills/doc-library/` |
| [web-scout](./docs/web-scout.md) | Real-time web research, content extraction, and site mapping via Tavily (MCP) | `./skills/web-scout/` |

### Hard Triggers

These skills activate automatically when their condition is met:

| Condition | Skill |
|---|---|
| Task requires library API references, code examples, or tool docs | `doc-library` |
| Task requires real-time web data, news, or research | `web-scout` |
| Parallel or autonomous work | `subagents` |

## Prompts

Pre-configured prompt templates for common workflows:

| Prompt | Description | Location |
|---|---|
| [memory-init](./prompts/memory-init.md) | Initialize memory by analyzing project structure and storing key information | `./prompts/memory-init.md` |

Usage:
```bash
pi -f memory-init  # Initialize memory for the current project
```

## Documentation

Comprehensive documentation for each component:

- **Extensions**
  - [agenda.md](./docs/agenda.md) — Structured task tracking with acceptance guards
  - [code-map.md](./docs/code-map.md) — LSP-backed code intelligence tools
  - [memory-md.md](./docs/memory-md.md) — Persistent memory system
  - [subagents.md](./docs/subagents.md) — Autonomous sub-agent delegation
  - [system-prompt.md](./docs/system-prompt.md) — Package-wide runtime policy
  - [ptc.md](./docs/ptc.md) — Programmatic Tool Calling guide

- **Skills**
  - [doc-library.md](./docs/doc-library.md) — Library documentation lookup
  - [web-scout.md](./docs/web-scout.md) — Web research and content extraction

## Dependencies

### Bundled Dependencies

These are included automatically when you install `pi-code`:

| Package | Purpose |
|---|---|
| [pi-mcporter](https://github.com/mavam/pi-mcporter) | MCP bridge — enables `doc-library` and `web-scout` skills via `mcporter` binary |
| [pi-ask-tool-extension](https://github.com/devkade/pi-ask-tool) | Interactive clarification tool with tabbed questioning |

### Peer Dependencies

Required by the Pi runtime (automatically satisfied if you have Pi installed):

- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-ai`
- `@mariozechner/pi-agent-core`
- `@sinclair/typebox`

## Installation

### Global Installation

```bash
pi install /path/to/pi-code
```

The package will be available in all projects.

### Project-Local Installation

```bash
pi install -l /path/to/pi-code
```

The package will only be active in the current project directory.

## Requirements

### Core Requirements

- **Pi coding agent** (latest version)
- **Node.js 22+** (for `node:sqlite` used by the agenda extension)
- **Bun** (for spawning the code-map daemon)

### Binary Requirements

The following binaries must be in your `PATH`:

| Binary | Purpose | Required For |
|---|---|---|
| `memory-md` | Memory daemon for persistent storage | memory-md extension |
| `mcporter` | MCP bridge for tool access | doc-library and web-scout skills |

### MCP Configuration

For `doc-library` and `web-scout` skills to work, you need:

1. **Context7 MCP server** configured in your Pi MCP settings (for `doc-library`)
2. **Tavily MCP server** configured in your Pi MCP settings (for `web-scout`)

See the [doc-library](./docs/doc-library.md) and [web-scout](./docs/web-scout.md) documentation for setup instructions.

## Features

### Structured Task Management (agenda)

- Create agendas with acceptance guards
- Track tasks with state transitions (not_started → in_progress → completed)
- Ralph-loop evaluation: test against acceptance criteria before completion
- Interactive browser for agenda management
- SQLite-backed persistence

### Code Intelligence (code-map)

- LSP-powered analysis across the entire workspace
- Tools: `code_map_outline`, `code_map_symbol`, `code_map_diagnostics`, `code_map_impact`
- Background indexing with instant reverse-reference lookups
- Understand code structure before editing

### Persistent Memory (memory-md)

- Markdown-based memory storage with hybrid FTS + vector search
- Hierarchical sections with path-based organization
- Shared context across all agents and sessions
- Validation and structural integrity checks
- File-watching daemon with auto-reindexing

### Parallel Execution (parallel)

- Fan out 2+ independent operations in one call
- Supports: read, bash, write, edit, ptc (scripts)
- All operations run concurrently via Promise.all
- Mutation-safe edit queue for same-file writes

### Programmatic Tool Calling (ptc)

- Run Python or bash scripts in a single tool call
- PEP 723 inline dependency management for Python
- Direct MCP access via `mcporter` binary from within scripts
- Direct code-map daemon access via Unix socket
- Replace multi-hop tool calls with consolidated scripts

### Sub-Agent Delegation (subagents)

- Spawn autonomous sub-agents for complex tasks
- Run in foreground (sequential) or background (parallel)
- Inherit context from parent or start fresh
- Agenda integration for structured sub-tasks
- Model and thinking-level overrides

### Library Documentation (doc-library skill)

- Query latest library docs and code examples via Context7
- Automatic library ID resolution
- Never hallucinate APIs — always look them up
- Hard trigger: activates for any library/API/tool documentation request

### Web Research (web-scout skill)

- Real-time web search via Tavily
- Content extraction from URLs
- Website structure mapping
- Comprehensive research mode
- Hard trigger: activates for news, current events, real-time data

## Usage Examples

### Initialize Memory

```bash
pi -f memory-init
```

### Use a Skill Directly

```bash
pi "Look up the latest FastAPI documentation for WebSocket routing"
# → Activates doc-library skill automatically

pi "Research the latest developments in Rust async runtimes"
# → Activates web-scout skill automatically
```

### Create an Agenda

Start a conversation and use agenda tools:

```bash
pi "Create an agenda for refactoring the auth module"
```

The agent will use `agenda_create`, track tasks, and evaluate against acceptance criteria.

### Parallel Operations

The `parallel` extension is always available:

```bash
pi "Read package.json and tsconfig.json, then analyze both"
# → Uses parallel tool to read both files concurrently
```

## Project Structure

```
pi-code/
├── extensions/          # All extensions (auto-loaded)
│   ├── agenda/         # Task tracking
│   ├── code-map/       # Code intelligence
│   ├── memory-md/      # Persistent memory
│   ├── subagents/      # Sub-agent delegation
│   ├── parallel.ts     # Parallel execution
│   ├── pi-code-prompt.ts  # Runtime policy
│   └── ptc.ts          # Programmatic tool calling
├── skills/             # Specialized skills
│   ├── doc-library/    # Library documentation lookup
│   └── web-scout/      # Web research
├── prompts/            # Prompt templates
│   └── memory-init.md  # Memory initialization
├── docs/               # Documentation
│   ├── agenda.md
│   ├── code-map.md
│   ├── doc-library.md
│   ├── memory-md.md
│   ├── ptc.md
│   ├── subagents.md
│   ├── system-prompt.md
│   └── web-scout.md
├── package.json        # Package metadata
└── README.md           # This file
```

## Contributing

This is a personal pi package. If you want to use it as a base for your own configuration:

1. Fork or clone this repository
2. Modify extensions, skills, and prompts to suit your workflow
3. Update `package.json` with your own name and version
4. Install locally with `pi install -l /path/to/your-pi-code`

## License

GPL-3.0-only

---

**Note**: This package requires Pi coding agent and several external binaries (`memory-md`, `mcporter`, `bun`). See Requirements section for full setup instructions.
