# architecture

## Directory Structure

Top-level layout of `/Users/noor/Builds/pi-code`:

- `extensions/` — custom pi extensions (TypeScript, run via Bun)
- `extensions/agenda/` — SQLite task tracking; files: index.ts, db.ts, tools.ts, types.ts, widget.ts, browser.ts, format.ts
- `extensions/code-map/` — LSP daemon; files: index.ts, tools.ts, client.ts, paths.ts, daemon/, lsp/
- `extensions/code-map/daemon/` — long-running daemon: runner.ts, server.ts, indexer.ts, graph.ts, watcher.ts
- `extensions/code-map/lsp/` — LSP client: client.ts, installer.ts, protocol.ts, registry.ts
- `extensions/memory-md/` — memory daemon wrapper: index.ts, tools.ts
- `extensions/subagents/` — sub-agent orchestration: index.ts, agent-manager.ts, agent-runner.ts, custom-agents.ts, model-resolver.ts, session-viewer.ts, types.ts, widget.ts
- `extensions/ptc.ts` — uv Python and bash script runner tool
- `extensions/system-prompt.ts` — global runtime policy via before_agent_start hook
- `skills/` — SKILL.md definitions for doc-library, subagents, web-scout
- `prompts/` — prompt templates (memory-init.md)
- `docs/` — human-readable docs per extension/skill
- `node_modules/` — pi-mcporter and pi-ask-tool-extension (bundled)
- `.pi-memory/` — project-local memory store (this directory)

## Key Design Patterns

- Extension entry points export a default function `(pi: ExtensionAPI) => void`
- code-map daemon socket: `~/.pi/cache/code-map/<encoded-project>/daemon.sock`
- memory-md daemon socket: `~/.cache/memory-md/<sha256[:16] of MEMORY_MD_DIR>/channel.sock`
- Memory directory: `MEMORY_MD_DIR` env var, or `<cwd>/.pi-memory` as fallback
- Tool naming convention: snake_case (e.g. `agenda_create`, `memory_new`, `code_map_outline`)
- System instructions injected per-extension via `pi.addSystemInstruction()`

- **ExtensionFactory pattern**: each extension exports a default function `(pi: ExtensionAPI) => void`. Pi calls it at load time.
- **Daemon lifecycle**: code-map and memory-md both spawn a child process (`bun run <script>`) on `session_start`, write PID/sock/status files under `~/.pi/cache/<ext>/<encoded-root>/`, and kill on `session_shutdown`.
- **Unix socket IPC**: daemon listens on `daemon.sock`, client sends newline-delimited JSON-RPC (`{id, method, params}` → `{id, result|error}`).
- **Footer status**: extensions call `ctx.ui.setStatus(key, text)` to show persistent footer items; cleared on `session_shutdown`.
- **System prompt injection**: extensions return `{ systemPrompt: event.systemPrompt + additions }` from `before_agent_start` handler — the SDK chains multiple extensions sequentially.
- **Tool return shape**: `{ content: [{type:"text", text: string}], details: undefined }` satisfies `AgentToolResult<undefined>`.
- **code-map daemon lifecycle**: Started by pi on `session_start`, killed on `session_end` via SIGTERM. No idle timer — daemon runs for the full session. Only shutdown triggers: SIGTERM/SIGINT or explicit `"shutdown"` socket command.
- **code-map LSP freshness**: After a file change, `updateFile` sends `textDocument/didChange` then `waitForQuietDiagnostics(600ms quiet, 6s cap)` waits for the LSP to finish type-checking before re-querying symbols. Eliminates stale symbols from blind `sleep(800)`.
- **code-map diagnostics**: After each watcher-triggered re-index, ALL diagnostics are re-snapshotted (not just the changed file) because a TS change cascades to importers. `LspClient` emits `"diagnostics"` event on every `publishDiagnostics` push.
- **code-map re-index serialisation**: `Indexer.reindexQueue` (promise chain) ensures concurrent watcher events run one at a time. Public `reindexFile()` enqueues; private `_reindexFile()` executes.
- **code-map footer**: Status poller runs continuously for the entire session (no early exit). Daemon writes `"indexing"` → `"ready"` around each re-index so the footer reflects activity. Status file values: `starting`, `indexing`, `ready`, `error`, `stopped`.
- **Extension pattern**: Each extension is a TypeScript file/directory exporting a pi extension object with `tools`, `hooks`, and optional footer/widget registrations.
- **Agenda**: SQLite-backed, all state in `.pi/cache/agenda/<project>/agenda.db`. TUI widget in sidebar.
## Package Entry Points

The `pi` key in `package.json` declares:

- extensions: `./extensions`, `node_modules/pi-mcporter/dist/index.js`, `node_modules/pi-ask-tool-extension/src/index.ts`
- skills: `./skills`
- prompts: `./prompts`
