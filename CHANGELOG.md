# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
