# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
