# Changelog

All notable changes to this project will be documented in this file.

## [3.1.0] - 2026-05-16

### Added

- **subagents**: Resolution chain encoded in `SUBAGENT_BRIDGE` — all subagents now follow a structured 5-step decision order before acting: (1) memory, (2) warm agent, (3) reason, (4) tools, (5) `ask_primary`. Each step has explicit guidance and fallback behaviour.
- **subagents**: `ask_primary` and `ask_subagent` guidance added to all built-in agent `.md` files (Explorer, Researcher, Reviewer, Data-Expert). Each agent has a tailored `## Resolving unknowns` section with the resolution chain relevant to its role.
- **subagents**: `ask_primary` added to Explorer’s allowed tool set — Explorer can now escalate blocking questions to the primary agent.
- **subagents**: Built-in agent loading — bundled agents are now loaded directly from the extension’s `agents/` directory. `~/.pi/agent/agents/` acts as a user-override layer (same-named file wins). No files are seeded on startup.
- **subagents**: `"bundled"` source type added to `AgentConfig` — system prompt agent lists now distinguish **Built-in agents** (extension-bundled), **Global agents** (`~/.pi/agent/agents/`), and **Project agents** (`.pi/agents/`).

### Changed

- **subagents**: `git-committer` removed from built-in agents — it now lives as a custom global agent at `~/.pi/agent/agents/git-committer.md`, allowing per-user customisation without touching the extension.
- **subagents**: `worker.md` body trimmed — inter-agent communication guidance already injected via `SUBAGENT_BRIDGE`; the `.md` file now contains only the frontmatter.
- **subagents**: `seedBundledAgents()` removed from `index.ts` — replaced by direct loading of the bundled directory via `loadAgents(cwd, BUNDLED_AGENTS_DIR)`.
- **subagents**: Agent registry type-list labels updated — previously all non-project agents showed as `Global agents (~/.pi/agent/agents/)`; now correctly labelled by origin.
- **ask-tool**: `before_agent_start` now guards subagents — `ASK_SYSTEM_INSTRUCTION` (which instructs direct `ask_user` calls) is no longer injected into subagent sessions.
- **pi-code-prompt**: `buildInstruction` accepts `isSubagent` flag — subagent sessions receive a variant Pre-Call Check that replaces the `ask_user` clarification bullet with a resolution-chain + `ask_primary` reference.

## [3.0.0] - 2026-05-16

### Added

- **subagents**: `ask_subagent` tool — a subagent can query a warm session of another agent type directly, reusing its conversation context instead of spawning a fresh session. Uses the fallback chain: ask_subagent → solve yourself → ask_primary.
- **subagents**: `ask_primary` tool — a subagent can send a blocking question to the primary agent and wait for a response. The primary agent answers autonomously or uses `ask_user` for human clarification. Configurable timeout (`subagents.askPrimaryTimeout`, default 5 min).
- **subagents**: `answer_subagent` tool — primary-only tool for responding to blocked `ask_primary` calls. Exclusive to the primary (excluded from subagent tool sets).
- **subagents**: Warm session reuse — spawning an agent of the same type + working directory within the warm period reuses the existing session (conversation history preserved). Controlled by `reusable: false` in agent frontmatter to opt out. Warm period configurable via `subagents.warmPeriod` (default 10 min), resets on each reuse.
- **subagents**: `fresh` parameter on `Subagent` tool — forces a new session, bypassing warm reuse.
- **subagents**: Session file tailing — each agent writes its session log to `/tmp/pi-subagents/<projectHash>/<agentType>` on start. Warm reuse appends a `── resumed` divider to the existing file. File path shown in `/subagents` menu and completion notifications.
- **subagents**: External session viewer — `subagents.viewer` config (e.g. `"zellij action new-tab --name 'Subagent $ID' -- less -R +F $FILE"`) opens the session file in an external program. `$FILE` and `$ID` are interpolated. Without a viewer, the menu shows the `less -R +F` command directly.
- **subagents**: `(warm)` indicator in background agent completion notifications.
- **subagents**: Settings now persist to `pi-code.json` — `maxConcurrent`, `defaultMaxTurns`, `graceTurns`, `warmPeriod`, `askPrimaryTimeout`, `askSubagentTimeout` all readable/writable via `/subagents → Settings`.
- **subagents**: `reusable` frontmatter field for agent `.md` files — set to `false` to prevent warm session reuse for that agent type.
- **_config**: `getProjectHash(cwd?)` utility — short 12-char sha256 of project root, used for namespacing temp files per project.
- **_config**: `updateGlobalConfig(patch)` — deep-merges a patch into `~/.pi/agent/pi-code.json` and reloads; used by subagents settings persistence.
- **_config**: Shared subagents runtime state (`subagentsSharedManager`, `subagentsPendingAskPrimary`, `subagentsSendToPrimary`) stored on `globalThis` via `_config` — ensures primary and subagent extension instances share one copy regardless of module isolation.

### Changed

- **subagents**: Internal TUI session viewer removed — it was crashing pi. Replaced entirely by the external viewer + file tailing approach.
- **subagents**: Session files no longer use `.md` extension — they contain ANSI-colored output for terminal rendering, not markdown.
- **subagents**: Session file format uses ANSI colors (cyan agent name, green tool checks, magenta thinking, dim summaries, gray separators) — renders correctly with `less -R +F`.
- **subagents**: Turn order in session file corrected — thinking block now appears before tool calls within each turn.
- **subagents**: `steer_subagent` no longer intercepts `ask_primary` answers — replaced by dedicated `answer_subagent` tool.
- **subagents**: System prompt instructions updated — subagents instructed on `ask_subagent`/`ask_primary` fallback chain; primary instructed to respond immediately via `answer_subagent` in the same turn.
- **subagents**: Instruction prose updated to use "assign" instead of "delegate".
- **ask-tool**: Fixed broken `normalizeQuestions` import (`state.ts` → `validate.ts`).


### Changed

- **code-map**: LSP processes now release all open documents after Phase 2 completes (diagnostics snapshotted + reverse refs built). The LSP process stays alive for fast re-use; only the virtual document state is freed, dropping tsserver from ~858 MB to near-idle. Files are re-opened transiently on demand (watcher-triggered reindex or explicit query).
- **code-map**: Watcher-triggered reindex now follows an open→snapshot→close cycle: LSP opens only the changed file, snapshots fresh diagnostics, recomputes reverse refs for affected symbols, then immediately closes the file. The existing 500 ms debounce means SQLite is up to date before most `code_map_diagnostics` calls.
- **code-map**: `_updateReverseRefsForFile` now opens `nodeAbsFile` on-demand for the `affectedNodeIds` loop (external symbols whose caller sets are invalidated by a file change) and closes it in a `finally` block. Previously these files were assumed to be open from startup.
- **code-map**: All `closeFile` calls in `indexer.ts` are now guarded with `try/finally` — a rejection in `_updateReverseRefsForFile` or an error in the `affectedNodeIds` loop no longer leaks open LSP document handles or aborts the reverse-ref iteration for remaining nodes.
- **code-map**: `buildReverseRefs()` in `runner.ts` is now `await`-ed (was fire-and-forgot `void`) so the post-Phase-2 file-close step runs only after all reverse refs are in SQLite.

### Fixed

- **docs/code-map**: Language support table corrected — removed Zig and Lua (never implemented), added C (`clangd`; no tree-sitter grammar, LSP-only). Tool parameter docs updated: `language` values are now `typescript | javascript | python | go | c`.

## [2.2.0] - 2026-05-14

### Added

- **subagents**: `/assign <agent> [task]` command — quick-assigns a task to a named subagent in the background; result is delivered as a follow-up message that triggers a new AI turn.
- **subagents**: `/assign-multi agent1:task1; agent2:task2` command — parallel assignment; all agents run concurrently and a combined result is delivered as a single follow-up turn when all finish.
- **subagents**: `/delegate <agent> [task]` command — fire-and-forget variant of `/assign`; runs entirely in background with UI-only feedback (start toast + completion toast with duration, tool count, and output preview). No message is injected into the conversation, no AI turn is triggered.
- **code-map**: `/code-map-clean` command — cleans code-map artifacts with per-operation confirmation dialogs. Subcommands: `lsp-binaries` (removes `~/.pi/cache/lsp`, restarts daemon in tree-sitter-only mode), `tree-sitter-binaries` (removes `~/.pi/cache/tree-sitter`, restarts daemon in LSP-only mode), `projects` (removes all project index dirs, restarts daemon), no argument (removes current project cache, restarts daemon). All delete operations use try/catch/finally so daemon restart is guaranteed even on partial failure.
- **code-map**: Pinned tree-sitter package versions in `installer.ts` and `~/.pi/cache/tree-sitter/package.json`: `tree-sitter@0.25.0`, `tree-sitter-typescript@0.23.2` (latest published), `tree-sitter-javascript@0.25.0`, `tree-sitter-python@0.25.0`, `tree-sitter-go@0.25.0`, `tree-sitter-c@0.24.1`.
- **skills/hunk-review**: Improved CLI reference — documented `comment rm` positional-form requirement (`<sessionId> <commentId>`; `--repo` is unreliable for `rm`), added bulk removal ptc pattern, clarified `comment add` uses `--old-line`/`--new-line` not `--hunk`, updated error table.
- **skills/httpyac**: Expanded `httpyac send` flag reference (added `--raw`, `--no-color`, `--quiet`; corrected `--repeat-mode` default to `parallel`; fixed `--filter` as a valued flag); added full `httpyac oauth2` command section with flags and shell examples.

### Fixed

- **subagents**: `/delegate` and `/assign` no longer produce duplicate completion messages. Previously both `onComplete` (sending `subagents:complete`) and the command-level `.then()` handler fired on agent completion, resulting in two messages to the primary agent.
- **subagents**: `widget.setUICtx` in `/assign` and `/delegate` is now set after the `!agentConfig` guard so the widget context is only refreshed for valid invocations.
- **subagents**: Pluralisation fixed in stats strings — `1 tool uses` → `1 tool use`.

## [2.1.2] - 2026-05-13

### Fixed

- **code-map**: Primary session no longer gets trapped in client-only mode on pi restart. The `daemonAlreadyUp` socket-exists fallback has been removed — on restart, both the old and new sessions exist briefly; the fallback caused the new session to skip spawning a daemon just as the old session's `session_shutdown` killed it, leaving the primary session permanently stuck. Only the explicit `subagentMode` flag (set by subagents) now triggers client-only mode.
- **code-map**: Added `killOrphan()` — reads the PID file and sends SIGTERM to any stale daemon left by a crashed previous process before spawning a fresh one.
- **code-map**: `/code-map status` now checks socket existence and shows a warning with `(missing)` when the daemon has died but the status file still says ready.
- **code-map**: Status poller now shows `stopped` in the footer when the status file claims ready/indexing/starting but the socket is absent.
- **code-map**: Dropped zig and lua support — `tree-sitter-zig@0.2.0` and `tree-sitter-lua@2.1.3` use the pre-v0.21 grammar export format and fail with "Invalid language object" under tree-sitter v0.25. Removed from tree-sitter installer, loader, parser, LSP registry, LSP installer, queries, and all tool descriptions. Supported languages are now: TypeScript, JavaScript, Python, Go.
- **code-map**: Fixed tree-sitter v0.25 API breakage — grammar packages no longer expose `language.query()`; queries are now compiled with `new Parser.Query(grammar, src)` + `q._init()`. The old API silently returned `[]` for every file, stored mtimes, and permanently prevented re-indexing.
- **code-map**: Added poisoned-DB recovery in `indexer.buildNodes()` — if all files have stored mtimes but the node table is empty (silent failure on first run), mtimes are cleared and a full re-index is forced automatically.
- **code-map**: `TreeSitterParser` now accepts a `log` callback; query compilation failures and parse errors are surfaced in the daemon log instead of being silently swallowed. Per-language symbol counts added to the indexing completion log.
- **code-map**: Added `db.clearMtimes()` method.

### Added

- **code-map**: `/code-map index` command — kills the running daemon, clears all stored file mtimes from the SQLite DB, and spawns a fresh daemon that re-parses every file from scratch. Tab-completion included.

## [2.1.1] - 2026-05-13

### Fixed

- **code-map**: Subagent sessions no longer spawn a competing daemon. Previously, `bindExtensions()` in the subagent runner triggered `session_start` on the code-map extension inside every subagent, which deleted the primary session's socket file, started a second daemon for the same project root, then killed it on `session_shutdown` — leaving the primary session's tools with no socket. Fixed with a dual-signal client-only guard: (1) `bindExtensions({ subagentMode: true })` in `agent-runner.ts` passes an explicit flag; (2) a fallback checks whether a socket file already exists. Client-only sessions set `ownsDaemon = false`, only poll the status for footer updates, and never spawn or kill the daemon.
- **parallel**: `opCodeMap` now resolves the git root via `git rev-parse --show-toplevel` (cached per cwd) before constructing the `SocketClient`, so `parallel` code-map slots work correctly when `ctx.cwd` is a subdirectory rather than the project root.

## [2.1.0] - 2026-05-13

### Added

- **skills/httpyac**: New skill for sending HTTP, REST, GraphQL, gRPC, WebSocket, and MQTT requests from `.http`/`.rest` files using the `httpyac` CLI and Node.js API. Covers the full `httpyac send` flag reference, `.http` file format (variables, regions, annotations, chained requests), declarative assertions (`??`), inline JavaScript scripting (pre-request, post-response, global hooks), environment configuration via `http-client.env.json`, output formats (`--json`, `--junit`), `.httpyac.js` plugin hooks, and the programmatic `send()` / `getVariables()` / `getEnvironments()` API. Includes a dedicated **"Using parallel and ptc"** section with a decision guide, `parallel` fan-out patterns, uv-backed Python result parsers, multi-file aggregation scripts, and a multi-step bash workflow example.

## [2.0.1] - 2026-05-13

### Added

- **subagents/Reviewer**: New expert code-review agent that reads a live Hunk diff session and leaves precise inline annotations. Runs `hunk session list` first — if no session is active it stops immediately with a prompt to open one. Otherwise fans out parallel inspect calls, fetches patches per file, analyses hunks across eight dimensions (correctness, safety, security, performance, contracts, architecture, tests, hygiene), and applies all annotations in one `comment apply --stdin` batch. Delivers a structured Critical / Important / Minor / Approved summary when done.
- **prompts/diff-action**: New `diff-action` prompt.
- **subagents/Explorer**: Fixed `display_name` (`Explore` → `Explorer`).
- **subagents/Researcher**: Fixed `display_name` and heading (`Research` → `Researcher`).

## [2.0.0] - 2026-05-13

### Added

- **finder**: First-party `extensions/finder/` extension replacing the bundled `@ff-labs/pi-fff` package. Owns the `FileFinder` singleton directly via `@ff-labs/fff-node`, registers `ffgrep` and `fffind` tools, and exposes the instance to other extensions via `pi.events` (`fff:finder` / `fff:request` channels).
- **finder**: Full parity with upstream pi-fff v0.6.0 — mode system (`tools-and-ui` / `tools-only` / `override`), `FffEditor` @-mention autocomplete, `renderCall`/`renderResult` on both tools, `--fff-mode` / `--fff-frecency-db` / `--fff-history-db` CLI flags, updated `/fff-health` showing version + mode + query tracker.
- **parallel**: `ffgrep` and `fffind` whitelisted as parallel slots — delegates to the shared `FileFinder` instance from the finder extension via the event bridge.
- **parallel**: All seven scout tools whitelisted as parallel slots (`web_search`, `web_extract`, `web_crawl`, `web_map`, `web_research`, `find_library_id`, `query_library_docs`) — spawns `tvly`/`ctx7` CLI subprocesses directly, reads API keys from `~/.pi/agent/pi-code.json`.
- **finder**, **scout**: Both extensions now inject domain-specific usage instructions via `before_agent_start` — instructions travel with the extension rather than living only in `pi-code-prompt.ts`.

### Changed

- **parallel**: `BASE_INSTRUCTION`, `description`, and `promptSnippet` rewritten to enumerate every supported slot by category (Native, Scripts, Code intelligence, Memory, Agenda, File search, Scout/web) instead of vaguely referencing "any supported extension tool".
- **pi-code-prompt**: Removed scout hard triggers and library-version guidance (now owned by `extensions/scout/index.ts`). Removed tool-selection prose that duplicated `ptc.ts` instruction. Package-level prompt now covers only cross-cutting policy.

### Removed

- **mcporter**: Removed `mcporter` as a parallel slot — `McporterCall` type, `opMcporter()` function, and all dispatch logic deleted from `extensions/parallel.ts`. Scout tools cover the primary use cases via direct CLI.
- **mcporter**: All references removed from `extensions/ptc.ts`, `docs/ptc.md`, `docs/web-scout.md`, `docs/doc-library.md`, and `README.md`. Docs updated to describe direct scout tools.
- **@aliou/pi-processes**: Removed from `dependencies`, `bundleDependencies`, `pi.extensions`, and `pi.skills` — no references existed anywhere in the codebase.
- **@ff-labs/pi-fff**: Replaced by the first-party `extensions/finder/` extension.

### Fixed

- **parallel / finder**: Doubled-backslash regex bug in `opFfgrep` — `hasRegex` character class and wildcard-guard regex had every backslash doubled by a bash heredoc during code generation, causing `]` to be excluded from the metacharacter set and bare `*`/`+` patterns to bypass the wildcard guard.
- **parallel, pi-code-prompt**: Bare backticks inside template literals caused `ParseError: Missing semicolon` at runtime. Fixed in `BASE_INSTRUCTION` (parallel.ts) and the Tool selection section (pi-code-prompt.ts).

## [1.19.0] - 2026-05-13

### Fixed

- **code-map**: `gopls` is now activated for Go workspace projects. The LSP detection condition in `lsp/registry.ts` checks for `go.work` in addition to `go.mod`, so multi-module workspace layouts correctly enable diagnostics and impact analysis.

## [1.18.0] - 2026-05-12

### Changed

- **memory-md**: `appendWorkflowEntry` now writes through `memory-md` CLI (`create-file` + `new`) instead of raw `fs.readFileSync`/`writeFileSync`. `workflow.md` is structured as `## YYYY-MM-DD` / `### HH:MM — title` sections, consistently indexed by the daemon and searchable like all other memory files.
- **memory-md**: All timestamps in workflow entries now use local time (via `Date` getters) instead of mixing UTC date (`toISOString`) with local time (`toTimeString`).
- **memory-md**: `appendWorkflowEntry` is now `async`; `ExecFn` is threaded from `pi.exec.bind(pi)` at the call site. `run` and `runWithInput` exported from `tools.ts`.
- **subagents**: `buildSubagentInstruction()` and the `MultiSubagent` tool description now clearly distinguish when to use `MultiSubagent` (read-only autonomous agents: Explore, Research, Data-Expert) vs individual `Subagent(run_in_background: true)` calls (worker agents that may need `steer_subagent` or sequential orchestration).
- **git-stage**: Overlay layout changed from horizontal split (file list left 35%, diff right 65%) to vertical split (file list top ~35%, diff bottom ~65%). Both panels now use full overlay width.
- **prompts/get-shit-done**: Steps section rewritten — scouting bypass gate added, `MultiAgent` typo fixed to `MultiSubagent`, worker spawning clarified to use individual `Subagent` background calls, dependency handling step separated, hunk-staging step added before git-commit, memory write step added after commit.

## [1.18.1] - 2026-05-12

### Fixed

- **memory-md**: Workflow log errors no longer write to `process.stderr` (which broke the TUI). Errors are now appended to the daemon log (`~/.cache/memory-md/<hash>/daemon.log`, inspectable via `/memory logs`) and trigger a best-effort macOS OS notification.
- **memory-md**: Date section existence check in `appendWorkflowEntry` now uses `memory-md get` instead of catching `"already exists"` error strings. The old approach could silently mask file corruption and let step 3 (`new workflow/<date>/<time>`) fail with a confusing "parent section not found" error.
- **git-stage**: Fixed overlay flickering when switching between files. `allLines` is now padded to exactly `overlayRows` empty lines before rendering, so the overlay height is constant across all frames.

## [1.17.9] - 2026-05-10

### Fixed

- **memory-md**: `agent_end` workflow log is now fire-and-forget — the hook returns synchronously so it no longer blocks the agent session lifecycle while the LLM summarisation call runs in the background.
- **memory-md**: Workflow log is skipped entirely for interrupted (`stopReason: "aborted"`) and errored (`stopReason: "error"`) sessions, preventing incomplete or noisy entries.

## [1.17.8] - 2026-05-10

### Changed

- **git-stage**: Replaced blank line hunk separators with labelled `─── hunk N / total ───` dividers for clear positional context when navigating multi-hunk diffs.
- **git-stage**: Added `│` left-gutter marker on all body lines of the selected hunk — selection highlight is now visible even when the `@@` header has scrolled off-screen.
- **git-stage**: Fixed scroll offset calculation: divider line was not counted before `selectedHunkLineStart` was captured, causing the selected hunk to appear at the bottom of the viewport. Navigating to any hunk now snaps the divider and `@@` header to the top.
- **git-stage**: Adjusted diff line colours — added lines are green (`success`), deleted lines are dim gray, context lines are white (`text`). Additions are now the clear focal point.

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
