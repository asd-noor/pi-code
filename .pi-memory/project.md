# project

## Overview

**pi-code** (v1.6.2) is a curated pi package that bundles custom extensions, skills, and system-prompt instructions for an enhanced AI coding experience on top of `@mariozechner/pi-coding-agent`.

- License: GPL-3.0-only
- Package keyword: `pi-package`
- Entry point for pi: `pi` key in `package.json` declares extensions, skills, prompts arrays
- Repo root: `/Users/noor/Builds/pi-code`
- README.md comprehensively updated to v1.6.2 (April 2026)
- All 7 extensions documented: agenda, code-map, memory-md, subagents, parallel, pi-code-prompt, ptc
- All 2 skills documented: doc-library, web-scout
- All prompts documented: memory-init
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
- `subagents` (`extensions/subagents/`) — spawn and manage autonomous subExtensions in `./extensions/` loaded by pi at startup:

- **agenda** (`extensions/agenda/`) — SQLite-backed task tracking with acceptance guards, Ralph-loop completion, and TUI widget.
- **code-map** (`extensions/code-map/`) — spawns a per-project LSP daemon, exposes 4 LLM tools (`code_map_outline`, `code_map_symbol`, `code_map_diagnostics`, `code_map_impact`), shows daemon status in footer.
- **memory-md** (`extensions/memory-md/`) — wraps the `memory-md` daemon, exposes memory tools to the LLM for persistent markdown-backed memory with hybrid FTS + vector search.
- **subagents** (`extensions/subagents/`) — sub-agent orchestration, model resolver, session viewer for delegating autonomous work.
- **parallel** (`extensions/parallel.ts`) — fan-out tool: runs 2+ independent operations (read/bash/write/edit/ptc) concurrently in one call.
- **pi-code-prompt** (`extensions/pi-code-prompt.ts`) — injects package-wide runtime policy: skill routing, library versions, clarification protocol, change safety.
- **ptc** (`extensions/ptc.ts`) — Programmatic Tool Calling: runs uv Python or bash scripts as the default for all work.

Bundled dependency extensions:
- **pi-mcporter** (bundled, `node_modules/pi-mcporter/`) — MCP server proxy tool.
- **pi-ask-tool-extension** (bundled, `node_modules/pi-ask-tool-extension/`) — `ask` clarification tool.
*pi-mcporter** (bundled, `node_modules/pi-mcporter/`) — MCP server proxy tool.
- **pi-ask-tool-extension** (bundled, `node_modules/pi-ask-tool-extension/`) — `ask` clarification tool.
## Skills Bundled

- `doc-library` (`skills/doc-library/SKILL.md`) — Context7 MCP docs lookup
- `subagents` (`skills/subagents/SKILL.md`) — sub-agent delegation patterns
- `web-scout` (`skills/web-scout/SKILL.md`) — Tavily real-time web research
Skills in `./skills/` (SKILL.md definitions):

- **doc-library** — Context7 MCP for library/API docs lookup
- **web-scout** — Tavily MCP for real-time web research
- **subagents** (skill) — guidance for spawning and managing subagents

Skills in `./skills/` (SKILL.md definitions):

- **doc-library** — Context7 MCP for library/API docs lookup
- **web-scout** — Tavily MCP for real-time web research

> Note: There is no bundled `subagents` skill. The subagents orchestration is handled entirely by the extension (`extensions/subagents/`).
## Documentation Status

Last comprehensive audit: April 18, 2026

All docs/*.md files reviewed against source code:

**✅ Accurate (7 files):**
- docs/agenda.md
- docs/code-map.md
- docs/doc-library.md
- docs/memory-md.md
- docs/ptc.md
- docs/system-prompt.md
- docs/web-scout.md

**✅ Fixed (1 file):**
- docs/subagents.md
  - Updated bundled agents: `worker`, `Explore`, `Research` (was: general-purpose, Plan)
  - Added `/delegate` command documentation

**✅ Created (1 file):**
- docs/parallel.md
  - **Issue**: `parallel` is a full extension in `extensions/parallel.ts` but had no documentation
  - Created comprehensive docs covering: tool parameters, supported operations, when to use, independence constraints, edit safety warnings, examples, output format
  - Updated README.md to link to new docs/parallel.md instead of source file

**Status:** All 9 documentation files are now accurate and up-to-date with v1.6.2 codebase.

## code-map-parsing-approach

`extensions/code-map` does not use Tree-sitter. It delegates symbol/diagnostic/reference data to language servers via an internal LSP client/daemon architecture.

Evidence in source:
- `extensions/code-map/lsp/registry.ts` wires language servers (`typescript-language-server`, `gopls`, `pyright`/`pylsp`).
- `extensions/code-map/daemon/indexer.ts` builds graph from LSP `documentSymbol` + diagnostics snapshots.
- `extensions/code-map/daemon/server.ts` serves `outline/symbol/diagnostics/impact` from graph and LSP references.
- Repo search in `extensions/code-map` found no `tree-sitter`/`web-tree-sitter` usage.

## ptc-purpose-visibility

Supported inlined tools:
- Native: `read`, `bash`, `write`, `edit`
- `ptc` — inlined: file write + execFileAsync
- `code_map_outline/symbol/diagnostics/impact` — inlined via `SocketClient`
- `memory_list`, `memory_get`, `memory_search`, `memory_validate_file` — read-only memory tools, safe for concurrent execution

**Excluded memory write tools** (`memory_new`, `memory_update`, `memory_delete`, `memory_create_file`, `memory_delete_file`): calling these in `parallel` returns an error with a hint to use them sequentially — concurrent writes can corrupt the memory file.

File renamed from `_parallel.ts` → `parallel.ts`. Underscore prefix was only needed for the (now-removed) monkey-patch load ordering.
## parallel dispatch architecture

**Previous approach (broken)**: monkey-patched `pi.registerTool` to capture extension execute functions into an `extensionTools` map. Failed because pi gives each extension its own `ExtensionAPI` instance — the patch only affected `_parallel.ts`'s own instance, so the map was always empty.

**Current approach**: Tool execution is **inlined** directly in `parallel.ts`. No monkey-patching, no dynamic dispatch.

Supported inlined tools:
- Native: `read`, `bash`, `write`, `edit`
- `ptc` — inlined: file write + execFileAsync (same logic as ptc.ts)
- `code_map_outline/symbol/diagnostics/impact` — inlined via `SocketClient` from `./code-map/client.ts`
- `memory_list/get/search/new/update/delete/create_file/delete_file/validate_file` — inlined via `memory-md` CLI calls (same logic as memory-md/tools.ts)
- Agenda tools (`agenda_*`) intentionally excluded — sequential by nature

File renamed from `_parallel.ts` → `parallel.ts`. The underscore prefix was only needed to ensure load-before-others for the (now-removed) monkey-patch. Glob ordering no longer matters.
## Parallel Tool Names Visibility

Final state after renderer migration for `extensions/parallel.ts`:

- ANSI escape sequences were removed from text payloads.
  - Invocation update is now plain text: `Invoking parallel: ${toolNames}`.
  - Final header is now plain text: `Parallel operations: ${toolNames}`.
- Comma-separated tool-name behavior is preserved via:
  - `calls.map((call) => String(call.tool)).join(", ")`.
- Added custom render hooks for styled UI labels:
  - `renderCall`: `theme.fg("toolTitle", theme.bold("parallel ")) + theme.fg("accent", toolNames)`.
  - `renderResult`: styled `Parallel operations:` header plus body with `theme.fg("toolOutput", ...)`.
- Plain-text fallback remains intact because content strings still include invocation/header text.
- `code_map_diagnostics` severity=1 for this file reports no diagnostics.
- Quick smoke checks confirm:
  - no `\\x1b[` literals in either target file,
  - required plain invocation/header strings present,
  - render hooks present in both files.
