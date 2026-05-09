# Changelog

All notable changes to this project will be documented in this file.

## [1.17.7] - 2026-05-09

### Changed

- **git-stage**: Upgraded to hunk-level staging. The `/git-stage` command now opens a centred overlay popup (95 % width, 95 % height) with a split-panel layout — file list on the left, diff/hunk viewer on the right. Individual hunks can be staged or unstaged via `git apply --cached` with a temp-file patch. Key hints moved to the header so they remain visible when long diffs fill the panel. Footer badge now polls every 3 s instead of refreshing only on `agent_end`.
- **agenda**: Both the orchestrator and subagent workflow instructions now include an explicit hunk-staging step between `agenda_evaluate` (pass) and `agenda_complete`. Agents write per-hunk patches to `/tmp` and apply them with `git apply --cached`, staging only the hunks they authored.

## [1.17.6] - 2026-05-09

### Added

- **git-stage**: `x` key runs `git rm --cached` on the selected file, removing it from the index while leaving it on disk.

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
