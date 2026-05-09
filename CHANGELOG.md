# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.17.3] - 2026-05-09

### Added

- **Auto-generated `workflow.md` entries** (`extensions/memory-md/index.ts`): After every agent loop, an `agent_end` hook extracts tool calls and the final assistant text, calls a configurable model, and appends a timestamped nested entry (`## YYYY-MM-DD` / `### HH:MM — title`) directly to `workflow.md`. The daemon reindexes the file automatically. Skips turns with zero tool calls. Errors are caught silently so the hook never disrupts the agent loop.
- **`/memory init` command**: Runs a full memory-initialization agent session using the configured model. Analyzes the project (reads files, README, package.json) and creates canonical memory files with properly nested sections.
- **`/memory curate [file]` command**: Runs a memory-curation agent session that audits all memory files (or one specific file) for flat sections, duplicates, stale facts, and missing nesting — fixes them in place. Skips `workflow.md`.
- **Argument completion for `/memory`**: Two-level autocomplete — first token completes sub-commands (`status`, `restart`, `snapshot`, `logs`, `init`, `curate`); second token after `curate` completes memory file names from the active memory directory, excluding `workflow.md`.
- **`~/.pi/agent/pi-code.json`** (new): Project-level config file. `workflowLog.model` sets the summarizer model for the `agent_end` hook; `memoryAgent.model` sets the model for `/memory init` and `/memory curate`.

### Changed

- **`workflow.md` is now read-only from the LLM's perspective**: The `MEMORY_INSTRUCTION` canonical files table marks it as auto-generated. The LLM is instructed to use `memory_search` / `memory_get` to read it and never write to it. Same update applied to `prompts/memory-init.md` (now deleted).

### Removed

- **`prompts/memory-init.md`** and **`prompts/memory-curate.md`**: Content inlined as TypeScript string constants inside `extensions/memory-md/index.ts`. The commands are now invoked via `/memory init` and `/memory curate` rather than as slash prompt templates.

## [1.17.2] - 2026-05-09

### Fixed

- **`ask_user` review screen overflow crash** (`extensions/ask-tool/ui.ts`): The "Review answers" tab crashed the TUI when a long answer label exceeded the terminal width. Answer text, question notes, and option notes in `renderSubmitScreen` were not wrapped with `clamp()` / `truncateToWidth()`, unlike all other render paths. All three line types are now properly truncated to terminal width.

## [1.17.1] - 2026-05-09

### Added

- **`ask_user` notify integration** (`extensions/ask-tool/index.ts`): When the `notify` extension has notifications enabled, invoking `ask_user` now sends a macOS OS notification before the dialog appears. Message uses `params.title` if provided, otherwise `"Needs your input"`. Reads `notify-state` session entries directly — no coupling between extensions, works regardless of load order.

## [1.17.0] - 2026-05-09

### Added

- **`notify` extension** (`extensions/notify/`): Sends a macOS OS notification when the primary agent's turn ends. Subagent sessions are silently ignored (detected via the `<sub_agent_context>` system-prompt marker). The notification body shows the first ~80 characters of the agent's reply. Togglable via `/notify on` / `/notify off`; state persists across reloads via `pi.appendEntry()`. Footer badge (`🔔 notify: on`) shown while enabled. Default: off.

## [1.16.2] - 2026-05-09

### Added

- **`agenda_create` whitelisted in `parallel`** (`extensions/parallel.ts`): `agenda_create` can now be fanned out inside a `parallel` call alongside other operations. Added `opAgendaCreate` implementation (mirrors `tools.ts` logic), `AGENDA_CREATE_TOOLS` dispatch set, updated `ExtCall` description, `supported` error string, and `BASE_INSTRUCTION` system-prompt note. Also added missing `normalizeNotes` and `runTx` imports from `./agenda/db.ts`.

## [1.16.1] - 2026-05-09

### Fixed

- **Subagent skill access** (`extensions/subagents/agent-runner.ts`): `DefaultResourceLoader` was created with `noSkills: true`, preventing all subagents (both `append` and `replace` mode) from receiving the `<available_skills>` block. Changed to `noSkills: false` so skill paths are correctly injected into every subagent's system prompt.
- **Skill-relative path resolution in `replace` mode**: `replace`-mode subagents now receive an explicit instruction to resolve relative paths found inside a skill (e.g. `references/postgres.md`) against the skill's directory — derived from the `<location>` field in `<available_skills>` — rather than against CWD.

## [1.16.0] - 2026-05-09

### Added

- **`ask_user` tool** (`extensions/ask-tool/`): Native interactive clarification tool replacing the `@eko24ive/pi-ask` npm dependency. Implemented from scratch following the existing extension conventions.
  - Supports `single`, `multi`, and `preview` question types with full keyboard navigation (Tab, arrow keys, digit shortcuts 1–9, Space to toggle).
  - **Question notes** (`N`): annotate the current question with freeform context before submitting.
  - **Option notes** (`n`): annotate a specific option choice with freeform context.
  - Freeform "Type your own" input on every question.
  - Review tab summarising all answers and notes before final Submit / Elaborate / Cancel.
  - Non-interactive fallback: lists questions as plain text when UI is unavailable (print/RPC/SDK modes).
  - Notes flow through to `AskResult` (`AskResultAnswer.note`, `AskResultAnswer.optionNotes`) and are included in the text returned to the LLM.
  - System prompt injection (`ASK_SYSTEM_INSTRUCTION`) with hard triggers, high-stakes/ambiguous classification, 5-step handshake protocol, question spew prevention, budget and escalation rules, and guardrails — baked in, no skill routing required.

### Changed

- **Package scope migration**: all `@mariozechner/*` packages renamed to `@earendil-works/*` following upstream repo move to `earendil-works/pi-mono`.
- **`@sinclair/typebox` → `typebox`**: all extension imports updated to the renamed package; `@sinclair/typebox` removed from `peerDependencies`.
- **Peer dependencies dropped**: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `typebox` removed from `peerDependencies` — pi provides these at runtime.
- **`pi-ask-tool-extension` → `@eko24ive/pi-ask` → native**: bundled npm ask dependency fully replaced by `extensions/ask-tool/`.
- **`pi-coding-agent` version**: bumped peer dependency references from `0.69.0` to `0.74.0`.
- **Bundled extensions updated**: `pi-ask-tool-extension` → `@eko24ive/pi-ask@0.9.0` (then removed), `pi-mcporter` → `0.3.2`, `@aliou/pi-processes` → `0.8.1`.
- **`pi-code-prompt.ts`**: removed duplicate `## Clarification first` section (owned by `ask-tool`); fixed stale `` `ask` `` → `` `ask_user` `` reference in Mandatory Pre-Call Check.
- **`diff-watcher`**: footer now shown only when ≥1 Hunk session is active; fixed `sessions.map is not a function` crash when `hunk session list --json` returns a wrapped object instead of a bare array.

### Removed

- `@eko24ive/pi-ask` npm dependency and all references.
- `skills/ask-user/SKILL.md` — guidance merged into `ASK_SYSTEM_INSTRUCTION` in `extensions/ask-tool/index.ts`.
- `bun.lock` — project no longer uses Bun.

## [1.15.0] - 2026-05-09

### Added

- **diff-watcher extension**: New `extensions/diff-watcher/` extension that monitors live [Hunk](https://hunk.tools) diff review sessions and surfaces them to the agent automatically.
  - Polls `hunk session list --json` every 4 seconds and reflects the active session count in the pi footer (`⬡ hunk: no sessions` / `⬡ hunk: 1 session` / `⬡ hunk: N sessions`).
  - `before_agent_start`: live-queries sessions and injects their repo paths and IDs into the system prompt so the agent knows which Hunk windows are open without being asked.
  - `/diff-watcher status` command: lists all active Hunk sessions by repo path.
  - Zero daemon management — per the official Hunk agent-workflows docs the TUI starts the local daemon automatically; the extension is purely observational.
  - Requires `hunk` CLI on `PATH`; silently skips when not installed.

### Fixed

- **code-map — 14 memory leaks, resource cleanup, and correctness bugs** across the daemon, LSP client, file watcher, tree-sitter parser, socket client, and SQLite layer:

  **`lsp/client.ts`**
  - `onData` buffer now capped at 16 MB — malformed LSP output no longer causes unbounded string growth.
  - `diagnostics` Map is pruned via new `clearDiagnostics(uri)` method; called in `closeFile()` and `shutdown()`.
  - New `closeFile(filePath)` method sends `textDocument/didClose` and removes entries from `openFiles` and `fileVersions` — files are no longer held open indefinitely.
  - `proc.on("exit")` now immediately rejects all pending requests and clears the `pending` Map — previously requests waited up to 60 s for their individual timers after the LSP process died.
  - `setMaxListeners(0)` added in constructor to prevent Node.js max-listener warnings from concurrent `waitForQuietDiagnostics` callers.

  **`daemon/server.ts`**
  - `close()` now tracks all active sockets in a `Set<Socket>`, destroys them before calling `server.close()`, and falls back to a hard 2-second timeout — previously `close()` hung indefinitely if any connection was still open.
  - `activeConnections` double-decrement fixed: removed the `socket.on("error")` decrement since Node.js always fires `close` after `error`.
  - Per-connection `buf` capped at 1 MB — clients streaming data without newlines can no longer exhaust memory; socket is destroyed on overflow.

  **`daemon/watcher.ts`**
  - `stop()` now calls `watchedDirs.clear()` — previously a daemon restart via `/code-map restart` would register zero watchers (all dirs already in the set) leaving the watcher completely silent.
  - Each `FSWatcher` now has `error` and `close` handlers that evict the watcher from `this.watchers` and the dir from `watchedDirs` — dead watchers for deleted directories no longer accumulate.

  **`tree-sitter/parser.ts`**
  - `parseSource()` now reuses a cached `Parser` instance per language (via `parserCache: Map<string, any>`) instead of allocating a new native `Parser` object for every file — eliminates native heap pressure during initial indexing of hundreds of files.

  **`index.ts`** (extension entry point)
  - `spawnDaemon()` now calls `closeSync(logFd)` immediately after `spawn()` — the log file descriptor was previously leaked in the parent process on every daemon restart.

  **`client.ts`** (SocketClient)
  - `socket.end()` replaced with `socket.destroy()` after receiving a query response — `end()` left the socket half-open until the server closed its side.

  **`daemon/db.ts`**
  - 16 hot-path `db.prepare()` calls moved to constructor-initialised private fields (`StatementSync`) — statements are now compiled once at startup instead of on every method invocation.

## [1.14.0] - 2026-05-08

### Added

- **hunk-review skill**: New skill for interacting with live [Hunk](https://hunk.tools) diff review sessions via the `hunk session` CLI. Covers session discovery, file/hunk navigation, session reload, inline comment authoring (`comment add` / `comment apply` batch), and review guidance (navigate-before-comment, `--include-patch` on demand, `--focus` sparingly).
  - `skills/hunk-review/SKILL.md`: full skill definition with command reference, session-selection rules (`--repo` vs `--session-path` vs `--source`), navigation flags, `comment apply` stdin-JSON batch workflow, and common error table.
  - `docs/hunk-review.md`: user-facing documentation with when-to-use, key commands table, step-by-step workflow, navigation reference, review guidance, common errors, and requirements.
  - `README.md`: `hunk-review` added to Skills table and Hard Triggers table; `hunk` binary added to Binary Requirements table with link to [hunk.tools](https://hunk.tools); `hunk-review.md` added to Documentation section.
  - **Prerequisite**: `hunk` CLI must be on `PATH` and a live Hunk session must be open in the user's terminal.

- **Data Expert agent**: New `extensions/subagents/agents/Data-Expert.md` specialist agent for data analysis and source operations using the `data-wrangler` skill.
  - **Source resolution protocol**: checks prompt for an explicit source → verifies in memory then `sq`, stores if new; falls back to memory search then `sq ls` when no source is named; exits with a `sq add` instruction if no source can be confirmed.
  - Covers inspect, SLQ queries, native SQL, cross-source joins, output formats (JSON, CSV, XLSX, Markdown), table ops (`tbl copy/truncate/drop`), and `sq diff`.
  - Memory discipline: stores discovered sources under `data-sources/<handle>` and findings in `notes.md`.
  - Constraints: no guessing handles, no destructive ops without explicit instruction.

### Changed

- **README.md**: Added `mcporter` to Skills table and Hard Triggers table (MCP tool discovery/schema inspection/invocation); added `diff-review` and `get-shit-done` to Prompts table with usage examples; updated Project Structure to list all five skills (`doc-library`, `web-scout`, `hunk-review`, `mcporter`, `data-wrangler`) and all three prompts.

## [1.13.0] - 2026-05-08

### Added

- **data-wrangler skill**: New skill for querying SQL databases and tabular files using the `sq` CLI. Supports SLQ (sq's jq-like query language) and native SQL, source management, output formats (JSON, CSV, XLSX, Markdown, etc.), cross-source joins, `sq inspect`, `sq diff`, and `sq tbl` operations. Driver-specific reference files included under `skills/data-wrangler/references/` for `sqlite3`, `postgres`, `sqlserver`, `mysql`, `clickhouse`, `csv`, `tsv`, `json`, `jsona`, `jsonl`, and `xlsx`.
  - `skills/data-wrangler/SKILL.md`: skill definition with query modes, source/handle management, ping/inspect, output flags, diff/table ops, and per-driver reference index.
  - `README.md`: `data-wrangler` added to the Skills table; `sq` binary added to the Binary Requirements table with install link to [sq.io/docs/install](https://sq.io/docs/install/).
  - **Prerequisite**: `sq` CLI must be on `PATH` — install from https://sq.io/docs/install/

## [1.12.8] - 2026-05-07

### Added

- **pi-processes — background process management**: Bundled `@aliou/pi-processes@^0.8.1` as a new dependency. The extension exposes a `process` tool for running long-lived commands (dev servers, test watchers, build watchers, log tails) without blocking the conversation. The skill file at `skills/pi-processes` is also registered.
  - `package.json`: `@aliou/pi-processes` added to `dependencies`, `bundledDependencies`, `pi.extensions` (`node_modules/@aliou/pi-processes/src/index.ts`), and `pi.skills` (`node_modules/@aliou/pi-processes/skills/pi-processes`).
  - `extensions/pi-code-prompt.ts`: Added `## pi-processes — Background Process Management` section covering the `process` tool API (`start`, `list`, `output`, `logs`, `write`, `kill`, `clear`), `logWatches` runtime alerts (pattern/stream/repeat options with examples), a typical workflow, and the `/ps` family of TUI commands.

## [1.12.7] - 2026-05-05

### Fixed

- **subagents — memory tools always reported "daemon is not running"**: `createAgentSession()` in the pi SDK does not call `bindExtensions()`, so `session_start` never fired on extension instances loaded inside a subagent session. The memory-md extension sets its `memDir` closure variable in `session_start`; without that event, `memDir` stayed `undefined`, causing memory tools to fall back to `ctx.cwd` (the project root) instead of the correct `.pi-memory` subdirectory. The resulting `MEMORY_MD_DIR` hash differed from the one the daemon was started with, so the socket was never found.
  - `extensions/subagents/agent-runner.ts`: added `await (session as any).bindExtensions({})` immediately after `createAgentSession()`. Passing an empty bindings object means `hasUI` is `false` in fired events — memory-md's `session_start` handler sets `memDir` correctly and returns early without re-spawning the daemon. All subsequent memory tool calls in subagents now use the correct socket path.

## [1.12.6] - 2026-05-02

### Added

- **parallel — `agenda_discovery_*` tools now supported as inlined slots**: All four discovery tools (`agenda_discovery_add`, `agenda_discovery_get`, `agenda_discovery_list`, `agenda_discovery_delete`) can now be fanned out inside a `parallel` call alongside `read`, `ptc`, `code_map_*`, and `memory_*` ops.
  - `extensions/agenda/tools.ts`: exported new `AGENDA_DISCOVERY_TOOL_NAMES` set — canonical source of truth imported by `parallel.ts`.
  - `extensions/parallel.ts`: added imports from `./agenda/db.ts`, `./agenda/types.ts`, `./agenda/format.ts`, and `./agenda/tools.ts`; new `opAgendaDiscovery()` function implements all four tools directly via SQLite (WAL mode serialises concurrent writes safely, so no blacklisting needed); dispatch added in `opExtension()`; `ExtCall` description, top-level JSDoc comment, `BASE_INSTRUCTION` (`### agenda discovery tools` section), and the `supported` error message all updated.

- **session-viewer — auto-scroll**: The subagent session viewer (`extensions/subagents/session-viewer.ts`) now tracks the bottom of the log automatically while an agent is running.
  - New `private autoScroll = true` flag. When `true` and the agent is live (`isLive`), `scrollOffset` is pinned to `maxScroll` on every render.
  - Pressing ↑, PgUp, or Home disables auto-scroll so the user can freely read history.
  - Pressing End re-enables auto-scroll and jumps back to the bottom.
  - Footer hint updated to say *"auto-scroll: off on ↑, End to resume"*.

## [1.12.5] - 2026-05-02

### Added

- **agenda — `agenda_discoveries`**: New append-only knowledge log per agenda. Captures code searches, web research, library lookups, and expected/unexpected findings encountered during work. Discoveries sit entirely outside the Ralph loop — adding one never bumps the revision or affects evaluation staleness.
  - New `agenda_discoveries` SQLite table: `category` (`code` | `web` | `library` | `finding`), `title`, `detail`, `outcome` (`expected` | `unexpected` | `neutral`, default `neutral`), optional `source`.
  - Four new tools: `agenda_discovery_add` (requires `in_progress`), `agenda_discovery_get`, `agenda_discovery_list` (optional `category` filter), `agenda_discovery_delete` (blocked when `completed`).
  - `agenda_create` extended with an optional `discoveries` array — primary agents can pre-fill the log at creation time so subagents inherit context before starting work.
  - `instruction.ts` updated: `AGENDA_INSTRUCTION` gains a "Discoveries — knowledge artifacts" section covering categories, outcomes, and workflow; `buildSubagentAgendaInstruction` now includes a step to check `agenda_discovery_list` before starting work.

- **pi-code-prompt — memory/agenda integration guidance**: Added `## Memory — Work & Agenda Integration` section to `extensions/pi-code-prompt.ts` (injected into all agent sessions).
  - **During work** hard triggers: write to memory immediately when completing a non-trivial implementation, discovering how a module works, hitting unexpected constraints, making architectural decisions, or correcting assumptions.
  - **After agenda completion** pipeline: call `agenda_discovery_list` immediately after `agenda_complete`, map discoveries to the appropriate memory file by category (`code` → `architecture.md`, `library` → `architecture.md`/`setup.md`, `web` → `notes.md`, `finding`/unexpected → `decisions.md`/`notes.md`), group related discoveries, prioritise by `outcome`.

### Changed

- **docs/agenda.md**: Updated to reflect all of the above.
  - `agenda_create` row notes optional discoveries param.
  - `agenda_evaluate` row notes `in_progress` precondition.
  - `agenda_complete` row notes that unfinished tasks are allowed when the acceptance guard passes.
  - Browser keyboard table gains the missing `Enter` key (focuses selected in-progress agenda in widget).
  - New `## Discoveries` section: fields table, lifecycle gating table, discovery tools table, memory integration category mapping.
  - `## Skill` section replaced with `## Instruction injection` (correct terminology — this is a `before_agent_start` event hook, not a pi skill file).

## [1.12.4] - 2026-04-30

### Fixed

- **code-map — tree-sitter and LSP used as fallbacks for each other (wrong architecture)**: The indexer treated LSP `documentSymbol` as a fallback when tree-sitter returned 0 nodes. This was wrong — 0 nodes is a valid result (e.g. a config file with no declarations), and LSP is not initialized during `buildNodes` so it timed out. The correct split is: **tree-sitter owns all symbol extraction** for supported extensions; **LSP handles diagnostics and reverse-ref analysis only**.
  - `buildNodes`: if tree-sitter has a grammar for the file’s extension, always use it and never touch LSP. 0 nodes = file processed with no declarations, mtime recorded, no error. Files with no grammar are silently skipped.
  - `_reindexFile`: tree-sitter extracts symbols (even if 0); LSP is notified asynchronously for diagnostics and reverse refs. Removed the LSP `documentSymbol` call from the re-index path entirely.
  - `runner.ts`: removed the “early-init LSPs before indexing” block (was only needed to prevent LSP timeouts during `buildNodes`, no longer relevant). Updated startup sequence comment to reflect the correct roles.

## [1.12.3] - 2026-04-30

### Fixed

- **code-map — TypeScript enums not supported in strip-only mode**: `lsp/protocol.ts` used `export enum SymbolKind` and `export enum DiagnosticSeverity`. Node’s strip-only transpiler cannot emit the runtime object enums generate. Converted both to `as const` objects with a matching type alias (`export type X = typeof X[keyof typeof X]`), which are pure type annotations that strip cleanly. Updated `SKIP_KINDS` in `indexer.ts` to `new Set<SymbolKind>()` so `.has()` accepts the full value union.

## [1.12.2] - 2026-04-30

### Fixed

- **code-map — more TypeScript parameter properties in strip-only mode**: `indexer.ts`, `watcher.ts`, and `server.ts` all used constructor parameter properties (`private x: T`), which Node’s strip-only transpiler does not support. Expanded all three to explicit field declarations with assignments in the constructor body.

## [1.12.1] - 2026-04-30

### Fixed

- **code-map — `bun:sqlite` not available under Node.js**: `daemon/db.ts` imported `Database` from `bun:sqlite`, causing `ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'bun:'` when the daemon runs under Node. Migrated to `node:sqlite` (`DatabaseSync`, available without flags since Node v22.5 / v24). `bun:sqlite`'s `db.transaction(fn)` helper has no equivalent in `node:sqlite`; replaced all five usages with an explicit `private transaction()` wrapper using `BEGIN`/`COMMIT`/`ROLLBACK`.
- **code-map — `bun-types` devDependency and tsconfig reference removed**: `bun-types` is no longer needed now that the codebase uses only Node.js built-ins. Removed from `package.json` `devDependencies` and from `extensions/code-map/tsconfig.json` `types` array.
- **code-map — TypeScript parameter property in strip-only mode**: `constructor(private grammars: LoadedGrammars) {}` in `tree-sitter/parser.ts` is not supported by Node’s strip-only TypeScript transpiler. Expanded to an explicit field declaration and assignment.
- **code-map — `"type": "module"` missing from root `package.json`**: Node emitted a `MODULE_TYPELESS_PACKAGE_JSON` performance warning on every daemon start because the package type was unspecified. Added `"type": "module"` to `package.json`.

## [1.12.0] - 2026-04-30

### Fixed

- **code-map — daemon spawned with `bun` instead of `node`**: `spawnDaemon()` in `extensions/code-map/index.ts` used `bun run runner.ts`, which caused the daemon to run under Bun. Bun resolves native addon paths differently from Node.js, producing `ResolveMessage: Cannot find module './prebuilds/darwin-arm64/tree-sitter.node'` at startup. Node v24 runs `.ts` files natively (type-stripping is on by default since v23.6), so the fix is a direct `node runner.ts` spawn — no wrapper needed.
- **code-map — tree-sitter installer: bun fallback removed**: `runNpm()` in `tree-sitter/installer.ts` still had a bun fallback path. Removed entirely; npm is required and an explicit error is thrown if it is absent.

## [1.11.1] - 2026-04-30

### Fixed

- **code-map — tree-sitter native addon fails to build when bun is on PATH**: `runNpm()` in `tree-sitter/installer.ts` preferred bun over npm. Bun 1.3.10 only compiled 3 of 9 source files and never produced `tree_sitter_runtime_binding.node`. At runtime Node v24 (ABI 137) failed to load the addon with `No native build was found for ... abi=137`, `loadGrammars()` returned `null` silently, and the daemon fell back to LSP-only mode — skipping all JS/TS/Python/Zig/Lua files since no LSP was configured for them. Fixed by flipping the preference order to npm-first (npm's `node-gyp-build` install hook compiles correctly for Node.js ABI). Added `PACKAGES_NEED_BUILD` constant for the three packages without prebuilts (`tree-sitter`, `tree-sitter-zig`, `tree-sitter-lua`). After `npm install`, `missingNodeFiles()` checks each package's `build/Release/` for a `.node` file; any missing ones are rebuilt via `rebuildPackages()` using `npx node-gyp rebuild`, with a clear actionable error if the rebuild also fails. `loadGrammars()` now accepts an optional `log` callback to surface the native load error instead of swallowing it silently; `runner.ts` passes `log` through.

## [1.11.0] - 2026-04-28

### Fixed

- **subagents — extension tools unavailable in subagent sessions**: Subagents had access to only 7 built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`). Two root causes in `extensions/subagents/agent-runner.ts`:
  1. **Loader never reloaded**: `DefaultResourceLoader` was constructed and passed to `createAgentSession` without calling `reload()`. The SDK only reloads loaders it creates itself — pre-built loaders are used as-is. Result: extensions never loaded, no extension tools registered.
  2. **Built-in allowlist blocked extension tools**: `tools: ALL_BUILTIN_TOOL_NAMES` in `sessionOpts` set `allowedToolNames` in the SDK, acting as a strict whitelist. Extension tools (`agenda_*`, `ask`, `mcporter`, etc.) are not built-ins and were filtered out of the registry entirely before `setActiveToolsByName` even ran.
  
  **Fix**: Added `await loader.reload()` after `DefaultResourceLoader` construction. Removed `tools: toolNames` from `sessionOpts`; replaced with post-creation `session.getAllTools()` filtering — built-in tools restricted to agent config allowlist, extension tools always included, delegation tools (`Subagent`, `get_subagent_result`, `steer_subagent`) excluded to prevent recursive spawning.

- **agenda widget — not activating for subagent-driven agendas**: Widget never appeared when agendas were started by subagents rather than the parent session. Direct consequence of the above: subagents couldn't call `agenda_start` (tool unavailable), so agendas stayed `not_started`, the parent's 2s poller saw no change, and the widget remained hidden. Resolved by the extension tools fix above.

- **subagents — `tools: none` not respected**: `builtinToolNames = []` was falsy, causing the condition `agentConfig.builtinToolNames?.length` to fall back to `ALL_BUILTIN_TOOL_NAMES`. Fixed by checking `!= null` instead of `?.length`.

### Added

- **subagents — `extensions:` CSV filtering in agent frontmatter**: The `extensions:` field now fully controls which extension tools are active in a subagent session. Previously only `true`/`false` was wired up; the CSV string[] was parsed but ignored.
  - `extensions: memory-md, agenda` — allowlist: only tools from those extensions
  - `extensions: ^memory-md` — excludelist: all extensions except those prefixed with `^`
  - `extensions: false` — no extension tools; also suppresses `before_agent_start` injections
  - `AgentConfig` gains `extensionsExclude?: string[]` derived from the `!`-prefix syntax

- **subagents — unified `tools:` frontmatter**: Non-builtin tool names listed in `tools:` (e.g. `ptc`, `parallel`) are now treated as explicit extension tool allows — included unconditionally as long as the extension loaded, bypassing the `extensions:` filter. Previously non-builtin names in `tools:` were silently ignored.

- **docs — `MultiSubagent` tool documented**: Added `MultiSubagent` to `docs/subagents.md` tools table with its own parameter reference (`tasks`, `run_in_background`, `concurrency`). Previously absent from docs entirely.

- **docs — `agenda_id` parameter documented**: Added `agenda_id` to the `Subagent` parameters table in `docs/subagents.md`.

- **docs — `memory-compact` bundled agent documented**: Added to the bundled agents table in `docs/subagents.md`.

### Changed

- **memory-compact agent — `extensions: ^memory-md`**: Previously used `extensions: true` with a manual override note in the prompt body warning against the injected `MEMORY_INSTRUCTION` checklist. Now uses `extensions: ^memory-md` to exclude the memory-md extension entirely, preventing the injection at source. `tools:` updated to `read, bash, write, ptc, parallel` — the explicit minimal set needed for compaction.

## [1.9.1] - 2026-04-24

### Fixed

- **subagents — `agentDir` missing from `DefaultResourceLoader`**: Root cause of the persistent `Agent failed: The "path" argument must be of type string. Received undefined` error. `agent-runner.ts` was creating `DefaultResourceLoader` without `agentDir`, so `DefaultPackageManager` received `agentDir: undefined` and called `path.join(undefined, ...)` during `loader.reload()`. Fixed by importing `getAgentDir()` and passing `agentDir` to `DefaultResourceLoader`, `sessionOpts`, and `SettingsManager.create()`.

## [1.9.0] - 2026-04-24

### Added

- **subagents — `memory-compact` bundled agent**: New `extensions/subagents/agents/memory-compact.md` agent that snapshots memory with `memory-md snapshot --move`, reads snapshot files one by one, compacts noisy/large sections into concise durable bullet points, and recreates the root-level memory files. Includes concrete compaction heuristics (3–7 bullets per section, section deletion criteria, section merge rules) and per-file handling for `workflow.md`, `decisions.md`, `architecture.md`, `setup.md`, `project.md`, and `notes.md`.
- **`ptc` extension — uv shebang execution**: Python `ptc` scripts are now executed directly by file path so the kernel honors `#!/usr/bin/env -S uv run --script`. The shebang is now required for all Python `ptc` scripts. This lets uv manage dependencies via PEP 723 inline metadata and benefits from its dependency cache for very fast repeated runs.
- **Binary requirements — `uv`**: `uv` is now documented as a required binary in `README.md`. Added to the binary requirements table with its purpose: executing Python `ptc` scripts via the uv shebang.

### Changed

- **`parallel` extension — memory write tools unblocked**: Removed the old blacklist that rejected concurrent `memory_new`, `memory_update`, `memory_delete`, `memory_create_file`, and `memory_delete_file` calls in `parallel` slots. All memory tools are now fully supported as inlined `parallel` ops. Added `memRunWithInput()` (using `spawn`) so `memory_new` and `memory_update` can feed stdin to the `memory-md` process correctly.
- **`ptc` / `parallel` — preferred Python + uv over bash**: Sharpened all instruction and prompt text to make Python + uv the clear default scripting type. Bash is now explicitly reserved for clearly pure-shell tasks such as git, shell operations, and build commands.
- **`ptc` / `parallel` / `pi-code-prompt` — scripts over multiple bash calls**: Updated all guidance so even shell-heavy work prefers a bash script through `ptc` rather than multiple raw `bash` calls. Standalone `bash` and `bash` slots inside `parallel` are now explicitly framed as one-shot-only.
- **`parallel` — inlined `BashCall` description**: The `bash` slot schema now says "One-shot bash command to execute — for non-trivial shell work, prefer a bash script through `ptc` instead."
- **`subagents/agent-runner.ts` — subagent bridge prompt**: The subagent bridge now explicitly tells subagents to use the `bash` tool only for genuinely one-shot shell commands, and to prefer a `ptc` bash script otherwise.
- **`extensions/memory-md` — sync with upstream**: Instruction text, validation policy, `memory_search` fallback behavior, and `memory_create_file` schema all synced with `memory-md` upstream changes. `create-file` now accepts `name`, `title`, and an optional `description`.
- **`skills/mcporter/SKILL.md` — completed CLI section**: Filled in the `## CLI Tool` section using actual `mcporter --help` output. Documents all commands (`list`, `call`, `auth`, `generate-cli`, `inspect-cli`, `emit-ts`, `config`, `daemon`) and all global flags.
- **`pi-code-prompt` — mcporter hard triggers**: Added `mcporter` as an explicit hard-trigger skill for MCP server discovery, schema inspection, and tool invocation. Also added a proactive discovery trigger: if external integrations or hosted services may materially help, the agent should activate `mcporter` first.
- **`subagents` — cwd normalization**: Fixed `Agent failed: The "path" argument must be of type string. Received undefined` by normalizing `ctx.cwd` with a `process.cwd()` fallback in `index.ts`, `agent-runner.ts`, and `custom-agents.ts`.

## [1.8.7] - 2026-04-22

### Added

- **code-map — `/code-map` command argument completions**: The `/code-map` command now provides tab-completion for its sub-commands (`status`, `restart`, `logs`) via `getArgumentCompletions`. Typing `/code-map <Tab>` presents matching suggestions; partial prefixes (e.g. `re`) narrow the list.
- **mcporter skill**: Added `skills/mcporter/SKILL.md` as a dedicated skill for MCP tool access via the `mcporter` proxy binary.

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
