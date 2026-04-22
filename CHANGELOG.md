# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.8.7] - 2026-04-22

### Added

- **code-map — `/code-map` command argument completions**: The `/code-map` command now provides tab-completion for its sub-commands (`status`, `restart`, `logs`) via `getArgumentCompletions`. Typing `/code-map <Tab>` presents matching suggestions; partial prefixes (e.g. `re`) narrow the list.
- add mcporter skill

## [1.8.6] - 2026-04-22

### Fixed

- **code-map — `parallel` slots pass empty `language`**: `opCodeMap()` in `extensions/parallel.ts` destructured `language` from `params` but never forwarded it to `client.query()`. All four code-map tools (`outline`, `symbol`, `diagnostics`, `impact`) received `language: ""`, triggering `validateLanguage()` errors in the daemon. Fixed by extracting `const lang = params.language ?? ""` and including `language: lang` in every `client.query()` call.

## [1.8.3] - 2026-04-19

### Changed
- **subagents — Explore agent prompt**: Updated the `Explore` subagent system prompt to prefer chained shell operations inside `ptc` (bash or python) rather than individual tool calls, allowing multi-step exploration to run in one shot. Aligned natively indexed languages with the `code-map` extension capabilities.

## [1.8.2] - 2026-04-19

### Fixed

- **code-map — `./`-prefixed paths return no symbols**: `handleOutline` and `handleDiagnostics` passed relative paths straight to `db.getByFile()` without normalizing. Paths like `./main.go` never matched DB entries stored as `main.go` (via `path.relative()`). Fixed by applying `path.normalize()` to non-absolute paths before the DB lookup.
- **code-map — LSP early-init when tree-sitter unavailable**: When tree-sitter failed to install, `buildNodes` fell back to LSP document symbols — but the LSP hadn't been initialized yet, causing every file to time out at 15 s (~18 min blocked before the socket was created). The daemon now initializes all LSP clients before `buildNodes` when `tsParser` is null. `LspClient.initialize()` is now idempotent so Phase 8 doesn't double-initialize.
- **code-map — tree-sitter native build failing on Node ≥ v22**: `node-gyp` failed to compile the `tree-sitter` native addon because Node v22+ v8 headers require C++20. The installer now sets `CC="zig cc" CXX="zig c++"` when zig is available (full LLVM toolchain, C++20 by default), falling back to `CXXFLAGS="-std=c++20"` with the system compiler.
- **code-map — broken install detection retries on failed native build**: `isTreeSitterInstalled()` only checked for the package directory, not the compiled `.node` binary. A failed build left the directory in place, preventing retries. Now checks for `tree_sitter_runtime_binding.node` directly.
- **code-map — npm peer dep conflict during tree-sitter install**: `tree-sitter-typescript` declares `peerOptional tree-sitter@^0.21.0` conflicting with `^0.25.0` required by other grammars. Fixed by preferring bun (ignores peer dep conflicts) over npm, and adding `--legacy-peer-deps` to the npm fallback.
- **code-map — old cache path in injected system prompt**: `extensions/ptc.ts` still referenced `~/.pi/cache/code-map/<encoded>/daemon.sock` causing agents to look in the wrong directory. Updated to `~/.pi/cache/<encoded>/codemap-daemon.sock`.

## [1.8.1] - 2026-04-19

### Changed

- **code-map — cache path flattened**: Per-project state moved from `~/.pi/cache/code-map/<encoded-project>/` to `~/.pi/cache/<encoded-project>/`. Shared binaries follow: LSP servers at `~/.pi/cache/lsp/`, tree-sitter at `~/.pi/cache/tree-sitter/`.
- **code-map — daemon files renamed**: All per-project runtime files renamed from `daemon.*` to `codemap-daemon.*` (`codemap-daemon.sock`, `codemap-daemon.pid`, `codemap-daemon.status`, `codemap-daemon.log`) to avoid ambiguity with other daemons sharing the same cache directory.

## [1.8.0] - 2026-04-18

### Added

- **code-map — SQLite persistent cache**: Replaced the in-memory `CodeGraph` Maps with a SQLite database (`bun:sqlite`) at `~/.pi/cache/code-map/<project>/codemap.db`. Schema: `nodes`, `reverse_refs`, `indexed_nodes`, `diagnostics`, `file_meta`. WAL mode + 64 MB page cache + foreign-key cascades. The `CodeGraph` class is removed; all reads and writes go through the new `CodeMapDB` class in `daemon/db.ts`.
- **code-map — incremental startup**: `file_meta` table stores per-file `mtime_ms`. On daemon start, only files whose mtime differs from the stored value are re-parsed; unchanged files load from the DB instantly. Second-and-later session starts are near-instant for stable codebases.
- **code-map — multi-LSP support**: `detectServers()` replaces `detectServer()` and returns all matching LSP server definitions (not just the first). A project with both `tsconfig.json` and `go.mod` now runs both `typescript-language-server` and `gopls` simultaneously. All clients are background-initialised in parallel; each client owns its file extensions.
- **code-map — `language` field on all schema types**: `GraphNode`, `SymbolRow`, `SymbolDefRow`, `ImpactRow`, and `DiagRow` all carry a `language` string. Tree-sitter populates it from the file extension; LSP fallback derives it the same way.
- **code-map — required `language` parameter on all tools**: `code_map_outline`, `code_map_symbol`, `code_map_diagnostics`, and `code_map_impact` now require a `language: string` parameter. Passing an unsupported language returns a descriptive error message pointing to the `ptc` fallback. All handlers filter results by language at the SQL level.
- **code-map — eager reverse-ref recomputation after file changes**: When a file is re-indexed, `deleteFile` now also removes `reverse_refs` rows where `ref_file` matches and unmarks those parent symbols as indexed. `_updateReverseRefsForFile` then eagerly recomputes refs for both the changed file's own symbols and all affected external symbols — no lazy deferral to the next `code_map_impact` call.

### Changed

- **code-map — tree-sitter indexes all 6 languages unconditionally**: File collection now uses all tree-sitter-supported extensions (`.ts .tsx .js .jsx .mjs .cjs .py .go .zig .lua`) regardless of which LSPs are detected. Previously only the first-matched LSP's extensions were walked.
- **code-map — tree-sitter-only mode**: If no LSP detection markers are found in the project root, the daemon starts without any LSP (no diagnostics or impact analysis). Previously it fell back to starting `typescript-language-server` unconditionally.
- **code-map — `language` column drives SQL filtering**: `findByName`, `getDiagnostics`, and all other DB queries filter by `language` directly in SQL rather than post-filtering in application code.
- **code-map — system prompt updated**: Injected code-map instructions now state that `language` is a required parameter and describe the `ptc` fallback for unsupported languages.
- **docs/code-map.md**: Fully rewritten to reflect SQLite persistence, incremental startup, multi-LSP, required `language` param, corrected language support table (Rust removed, Zig added), and updated cache layout.

## [1.7.0] - 2026-04-18

### Changed

- **`parallel` extension — inlined tool dispatch**: Rewrote `extensions/_parallel.ts` → `extensions/parallel.ts`. The previous approach monkey-patched `pi.registerTool` to capture extension execute functions, but pi gives each extension its own `ExtensionAPI` instance so the map was always empty, causing `Unknown tool` errors for `ptc` and all other extension tools. Fixed by inlining the execute logic for all supported non-native tools directly in `parallel.ts`:
  - `ptc` — inlined file write + `execFileAsync` (same logic as `ptc.ts`)
  - `code_map_outline`, `code_map_symbol`, `code_map_diagnostics`, `code_map_impact` — inlined via `SocketClient`
  - `memory_list`, `memory_get`, `memory_search`, `memory_validate_file` — read-only memory tools, inlined via `memory-md` CLI
  - Memory write tools (`memory_new`, `memory_update`, `memory_delete`, `memory_create_file`, `memory_delete_file`) explicitly rejected with an error pointing to sequential use — concurrent writes can corrupt the memory file
  - Agenda tools (`agenda_*`) intentionally not supported — sequential by nature
- **`parallel` extension — underscore prefix removed**: `_parallel.ts` renamed to `parallel.ts`. The underscore was only needed to guarantee load-before-others for the monkey-patch; it is no longer required.

## [1.6.2] - 2026-04-17

### Changed

- **System prompt extension**: Renamed `extensions/system-prompt.ts` to `extensions/pi-code-prompt.ts` for better semantic clarity. Updated documentation references in `README.md` and `docs/system-prompt.md`.

## [1.6.1] - 2026-04-17

### Removed

- **Subagents footer/status bar**: Removed all `setStatus` calls from `extensions/subagents/widget.ts`. The subagents extension now only displays the widget above the editor and no longer creates status bar/footer entries. Useful when using a custom dedicated widget to avoid duplicate information.

## [1.6.0] - 2026-04-17

### Added

- **Research agent**: New built-in specialist subagent (`extensions/subagents/agents/research.md`) that performs comprehensive research using web-scout skill (Tavily search/research/extract/crawl), doc-library skill (Context7 API documentation), and memory tools. Uses `replace` prompt mode for focused research workflow with hard triggers for latest library versions and current web data.
- **Meta-agenda coordination pattern**: Documented comprehensive pattern in subagent instructions for tracking multiple parallel sub-agendas. Primary agent creates N sub-agendas + one meta-agenda (each meta-task tracks one sub-agenda), starts all meta-tasks in parallel, spawns background subagents with `agenda_id` assignments, then marks meta-tasks done as subagents complete. Includes dependency handling via staged spawning (Wave 1 → wait → Wave 2).
- **Code-map tools for Explore agent**: Added `code_map_outline`, `code_map_symbol`, `code_map_diagnostics`, `code_map_impact` to Explore agent's tool usage instructions for structural analysis during read-only codebase exploration.
- **PTC purpose field**: Made `purpose` field mandatory on `ptc` tool (shown in UI when tool runs, replacing generic "Running..." message). Updated schema, tool description, and SYSTEM_INSTRUCTION.

### Changed

- **Worker agent** (renamed from `general`): Renamed `general.md` → `worker.md`, updated `display_name` and fallback reference in `extensions/subagents/index.ts`. Better describes the role: primary orchestrates, worker executes.
- **Task granularity guidance**: Updated agenda instructions and tool schemas to emphasize tasks as meaningful phases/checkpoints (not individual tool calls). With `ptc`/`parallel`, many operations run in one shot. Target: 2-6 tasks per agenda.
- **Subagent delegation triggers**: Replaced "3+ steps" quantitative trigger with qualitative phase-based criteria: multi-phase work, >2 files to understand, agenda-worthy complexity.
- **Memory tool messages**: All memory tools (`memory_new`, `memory_update`, `memory_delete`) now include the affected path in result messages for better visibility.
- **Parallel result collection**: Clarified in subagent instructions that all `get_subagent_result` calls in fan-out pattern should be issued simultaneously (not sequential waits).

### Fixed

- **Subagent guards for both prompt modes**: Updated guards in `agenda/index.ts` and `subagents/index.ts` to detect subagents via BOTH `<sub_agent_context>` (append mode) AND `startsWith("You are a pi coding agent sub-agent.")` (replace mode). Previously only detected append mode, causing Explore and Research agents to receive primary-agent instructions.
- **PTC + parallel composition**: Fixed `ptc.ts` and `parallel.ts` documentation to clarify that `parallel` slots can include `ptc` scripts. Decision tree now explicit: 2+ independent ops → `parallel` (slots can be read/bash/write/edit/ptc), single op → `ptc`, exceptions: read (raw content before deciding), edit (parallel writes same file).
- **Backtick escaping**: Fixed unescaped backticks in agenda instructions, ptc instructions, and subagent instructions that caused TypeScript string literal errors.

### Removed

- **Plan agent**: Removed bundled Plan agent as redundant with Worker agent's general-purpose capabilities.

## [1.5.0] - 2026-04-17

### Added

- **`parallel` extension**: New `extensions/parallel.ts` registers a `parallel` meta tool that fans out multiple independent operations (read, bash, write, edit, ptc) concurrently in a single tool call via `Promise.all`. Results are returned together. Sits alongside `ptc.ts` as a single-file extension, auto-discovered by the `./extensions` glob.

### Changed

- **`system-prompt` extension — tool selection section**: Added a `## Tool selection` section positioning `ptc` as the default and `parallel` as the preferred choice when 2+ independent operations are needed — fan out instead of issuing sequential calls.
- **`subagents` extension — system prompt injection**: Revised `buildSubagentInstruction()`:
  - Added coordinator framing: parent agent orchestrates, subagents do the work and report back.
  - Defined "trivial" explicitly: direct answer from context, single tool call, no file changes.
  - Replaced hardcoded `→ Explore / → general-purpose` mappings in triggers with description-based matching: agent reads the live registry and picks by description.
  - Added **Never do inline** anti-patterns: writing/editing code, reading >2 files, multi-step shell sequences.
  - Added **Foreground vs background** decision rule.
  - Added fallback: if no matching agent is found, handle the work inline.

## [1.4.0] - 2026-04-17

### Changed

- **code-map daemon — idle timer removed**: Eliminated the 5-minute idle shutdown (`IDLE_TIMEOUT_MS`, `idleTimer`, `resetIdleTimer`). The daemon now stays alive for the full pi session and is only killed by SIGTERM/SIGINT or an explicit `"shutdown"` socket command.
- **code-map daemon — stale LSP cache fixed**: `LspClient` now emits a `"diagnostics"` event on every `publishDiagnostics` push. `waitForQuietDiagnostics(quietMs, maxMs)` replaces the blind `sleep(800)` after `updateFile` — it waits until no new diagnostic push arrives for 600 ms (hard cap 6 s), ensuring the LSP has finished type-checking before symbols are re-queried.
- **code-map daemon — full diagnostics snapshot on re-index**: After a file change, all diagnostics (not just the changed file's) are re-snapshotted. A single TypeScript change can invalidate diagnostics in any importer.
- **code-map daemon — serialised re-indexes**: Concurrent file-watcher events are now queued (`reindexQueue`) so re-indexes never race each other.
- **code-map footer — continuous polling**: The status poller no longer stops itself when it sees `ready`/`error`/`stopped`. It runs for the entire session, so crashes and re-index flips are always reflected.
- **code-map footer — re-index status**: The daemon writes `"indexing"` to `daemon.status` before each watcher-triggered re-index and `"ready"` when it completes, so the footer shows activity during incremental updates.


### Added

- **Subagents extension — system prompt injection**: The subagents extension now injects a `## Subagents` block into the system prompt on every turn via `before_agent_start`. Covers when to delegate, parallel work patterns (`run_in_background`, `get_subagent_result`, `steer_subagent`, `resume`), and a live list of all available agents grouped by source (global / project).

### Changed

- **Subagents extension — agent list**: The injected agent list includes all agents from the registry (seeded defaults + any user-defined agents in `~/.pi/agent/agents/` or `.pi/agents/`). Removed the "custom vs default" distinction — all agents are listed uniformly.
- **Subagents extension — tool description**: Removed hardcoded `Use Explore/Plan/general-purpose for…` task mappings from the `Subagent` tool description. The agent now reads descriptions from the live list and self-selects. Tone updated to encourage delegation as the default instinct.
- **system-prompt extension**: Removed the `subagents` hard trigger — subagent guidance is now fully owned by the subagents extension.
- **code-map extension — footer fix**: `session_start` now always resets the footer to "starting" and writes `"starting"` to `daemon.status` before spawning the daemon. Prevents a stale `"ready"` status file from a prior session causing the footer to show "ready" and the poller to stop prematurely.
- **memory-md extension — footer fix**: Same fix applied — `session_start` always shows "starting" instead of checking the socket file, which could be a stale leftover from a previous session.

### Removed

- **`skills/subagents/` skill**: Removed entirely. Guidance previously in the skill is now covered by the subagents extension's `before_agent_start` injection (always-on) and the `Subagent` tool description. The skill was redundant.

## [1.2.0] - 2026-04-17

### Added

- **Prompt templates**: Added `pi.prompts` entry in `package.json` pointing to `./prompts`, so prompt templates (e.g. `memory-init`) are auto-discovered when the package is installed.

## [1.1.0] - 2026-04-17

### Changed

- **memory-md extension**: Default memory directory changed from `~/.pi/memory` (global) to `<current-directory>/.pi-memory` (project-local). This makes memory per-project by default while still allowing global override via `MEMORY_MD_DIR` environment variable.

## [1.0.0] - 2026-04-17

### Added

- Initial stable release of `pi-code`, a curated pi package bundling custom extensions and configurations.
- Bundled extensions: `pi-mcporter` (MCP tool proxy) and `pi-ask-tool-extension` (structured clarification tool).
- Custom skills: `agenda`, `doc-library`, `memory-md`, `subagents`, `web-scout`.
- Custom extensions under `./extensions`.
- Peer dependencies on `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`, and `@sinclair/typebox`.
