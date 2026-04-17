# project

## Overview

**pi-code** (v1.5.0) is a curated pi package that bundles custom extensions, skills, and system-prompt instructions for an enhanced AI coding experience on top of `@mariozechner/pi-coding-agent`.

- License: GPL-3.0-only
- Package keyword: `pi-package`
- Entry point for pi: `pi` key in `package.json` declares extensions, skills, prompts arrays
- Repo root: `/Users/noor/Builds/pi-code`
- Installed pi SDK: `@mariozechner/pi-coding-agent` v0.67.6
## Tech Stack

- Runtime: Node.js 22+ (for `node:sqlite` used by agenda extension), Bun (for spawning code-map daemon)
- Language: TypeScript — no tsconfig.json; extensions run via Bun directly
- Package manager: npm (package-lock.json present)
- Bundled deps: `pi-mcporter` (MCP bridge), `pi-ask-tool-extension` (ask/clarification tool)
- Peer deps: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`, `@sinclair/typebox`

- Runtime: Bun (extensions run as TypeScript directly via `bun run`)
- Language: TypeScript (no compilation step — loaded live by pi)
- DB: SQLite via Bun's built-in `bun:sqlite` (used by agenda extension)
- LSP communication: JSON-RPC over stdio (lsp/client.ts + lsp/protocol.ts)
- IPC: Unix domain socket (code-map daemon ↔ extension client)
- Peer deps: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`, `@sinclair/typebox`
- Bundled deps: `pi-mcporter`, `pi-ask-tool-extension`
## Extensions Bundled

- `agenda` (`extensions/agenda/`) — structured task tracking with SQLite and acceptance guards
- `code-map` (`extensions/code-map/`) — LSP-backed code intelligence daemon (outline, symbol, diagnostics, impact)
- `memory-md` (`extensions/memory-md/`) — persistent markdown memory store with FTS5 and vector search
- `subagents` (`extensions/subagents/`) — spawn and manage autonomous sub-agents
- `ptc` (`extensions/ptc.ts`) — Programmatic Tool Calling (uv Python and bash runner)
- `system-prompt` (`extensions/system-prompt.ts`) — package-wide runtime policy injector

Extensions in `./extensions/` loaded by pi at startup:

- **code-map** (`extensions/code-map/`) — spawns a per-project LSP daemon, exposes 4 LLM tools (`code_map_outline`, `code_map_symbol`, `code_map_diagnostics`, `code_map_impact`), shows daemon status in footer. Config: `~/.pi/agent/code-map.json`. Cache: `~/.pi/cache/code-map/<encoded-project>/`.
- **memory-md** (`extensions/memory-md/`) — wraps the `memory-md` daemon, exposes memory tools to the LLM.
- **agenda** (`extensions/agenda/`) — SQLite-backed task tracker with tools and a TUI widget.
- **subagents** (`extensions/subagents/`) — sub-agent orchestration, model resolver, session viewer.
- **ptc** (`extensions/ptc.ts`) — single-file tool: runs uv Python or bash scripts.
- **system-prompt** (`extensions/system-prompt.ts`) — injects global runtime policy via `before_agent_start`.
- **pi-mcporter** (bundled, `node_modules/pi-mcporter/`) — MCP server proxy tool.
- **pi-ask-tool-extension** (bundled, `node_modules/pi-ask-tool-extension/`) — `ask` clarification tool.
## Skills Bundled

- `doc-library` (`skills/doc-library/SKILL.md`) — Context7 MCP docs lookup
- `subagents` (`skills/subagents/SKILL.md`) — sub-agent delegation patterns
- `web-scout` (`skills/web-scout/SKILL.md`) — Tavily real-time web research
Skills in `./skills/` (SKILL.md definitions):

- **doc-library** — Context7 MCP for library/API docs lookup
- **web-scout** — Tavily MCP for real-time web research
- **subagents** (skill) — guidance for spawning and managing subagents
