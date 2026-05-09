# Changelog

All notable changes to this project will be documented in this file.

## [1.17.5] - 2026-05-09

### Added

- **git-stage**: New extension at `extensions/git-stage/` — interactive TUI for staging and unstaging git files via `/git-stage` command. Footer badge shows `⊕ N staged` when files are staged; auto-refreshes after each agent turn via `agent_end`.
- **git-commit**: New subagent at `extensions/subagents/agents/git-commit.md` — one-shot agent that reads the staged diff (via Hunk if available, otherwise `git diff --staged`), generates a Conventional Commits message, and runs `git commit`. Model: `gpt-5-mini`, no extensions, thinking off.

## [1.17.4] - 2026-05-09

### Changed

- **memory-md**: Removed `/memory init` and `/memory curate` inline commands. These are now dedicated subagents (`memory-init`, `memory-curate`) under `extensions/subagents/agents/`, consistent with `memory-compact`.
- **memory-md**: Removed `memoryAgent` model config from `~/.pi/agent/pi-code.json` (no longer needed).
- **memory-md**: Removed `runMemoryAgentSession`, `loadMemoryAgentModel`, `MEMORY_INIT_PROMPT`, `MEMORY_CURATE_PROMPT` from `extensions/memory-md/index.ts`.
- **memory-md**: `/memory` command now only accepts: `status | restart | snapshot | logs`.

### Added

- `extensions/subagents/agents/memory-init.md` — subagent that analyses the codebase and populates canonical memory files.
- `extensions/subagents/agents/memory-curate.md` — subagent that audits and restructures existing memory files.
