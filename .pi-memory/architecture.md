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

## Agenda-Subagent Integration

The agenda and subagent extensions integrate through a delegation pattern where the primary agent creates agendas and assigns them to subagents for execution.


### guard-mechanisms

Both the agenda and subagent extensions implement guard mechanisms to prevent duplicate instruction injection and ensure proper context isolation.


### delegation-workflow

The complete delegation workflow covers two execution paths: self-executing (primary agent runs agenda) and delegated (subagent runs agenda).

## Self-Executing Workflow

**Actor**: Primary agent

**Trigger**: Multi-step work that doesn't warrant a separate subagent

**Steps**:
1. `agenda_create` → creates agenda in `not_started` state, returns id
2. `agenda_start` → transitions to `in_progress`
3. For each task:
   - `agenda_task_start` → mark task `in_progress`
   - Execute work (ptc, parallel, tool calls)
   - `agenda_task_done` → mark task `completed`
   - (Optional) `agenda_task_reopen` → revert to `in_progress` if rework needed
4. `agenda_evaluate` → assess against acceptance guard, record verdict
5. (If verdict=fail) → fix issues, re-evaluate
6. `agenda_complete` → terminal state (requires latest eval verdict=pass)

**State transitions**:
```
Agenda: not_started → in_progress ⇔ paused → completed
Task:   not_started → in_progress → completed (↔ in_progress via reopen)
```

## Delegated Workflow

**Actors**: Primary agent (orchestrator) + Subagent (executor)

**Trigger**: Complex multi-step work requiring specialized context or parallel execution

### Primary Agent Phase

1. **Plan agenda** (agenda stays `not_started`):
   ```typescript
   const { id: agendaId } = agenda_create({
     title: "Implement feature X",
     description: "Add authentication layer",
     acceptanceGuard: "Feature X is implemented, tests pass, and code is committed",
     tasks: [
       "Explore codebase and understand current auth flow",
       "Implement new auth layer with all components",
       "Write tests and verify functionality",
       "Run linter and type-check",
       "Commit changes with descriptive message"
     ]
   });
   ```

2. **Spawn subagent with agenda assignment**:
   ```typescript
   Subagent({
     subagent_type: "worker",
     prompt: "Execute agenda #" + agendaId,
     description: "implement auth layer",
     agenda_id: agendaId,
     run_in_background: false  // or true for parallel work
   });
   ```

3. **Retrieve result**:
   - If foreground: result returned directly
   - If background: `get_subagent_result(agent_id, wait=true)`

### Subagent Phase

**Context**: Subagent receives targeted agenda instruction in system prompt

**Instruction content** (from `buildSubagentAgendaInstruction`):
```
## Assigned Agenda

You have been assigned agenda #42. Follow this workflow exactly:

1. agenda_start — move the agenda to in_progress (it is currently not_started)
2. For each task: agenda_task_start → do the work → agenda_task_done
   - Reopen a task with agenda_task_reopen if it needs revision
   - Use agenda_pause / agenda_resume if you need to pause mid-work
3. agenda_evaluate — evaluate against the acceptance guard (verdict: pass or fail)
   - Re-evaluate after any changes that bump the revision
4. agenda_complete — requires in_progress state, ≥1 task, and latest verdict=pass

After completing the agenda, report back with a concise summary of what was done.

**Do not create your own agendas. Work only on agenda #42.**
```

**Execution**:
1. Subagent reads assigned agenda via agenda tools
2. Executes workflow as documented in instruction
3. Returns summary to primary agent

### Parallel Delegation Pattern

**Use case**: Multiple independent tasks

**Pattern**:
```typescript
// Create one agenda per task
const agenda1 = agenda_create({...}).id;
const agenda2 = agenda_create({...}).id;
const agenda3 = agenda_create({...}).id;

// Fan out background subagents
const agent1 = Subagent({type: "worker", agenda_id: agenda1, run_in_background: true});
const agent2 = Subagent({type: "worker", agenda_id: agenda2, run_in_background: true});
const agent3 = Subagent({type: "worker", agenda_id: agenda3, run_in_background: true});

// Collect results in parallel (issue all calls simultaneously)
get_subagent_result(agent1, wait=true);
get_subagent_result(agent2, wait=true);
get_subagent_result(agent3, wait=true);
```

**Key points**:
- All agents start immediately (subject to concurrency limit, default 4)
- Queued agents auto-start when slots free
- Results collected concurrently (no sequential blocking)

## Workflow Comparison

| Aspect | Self-Executing | Delegated |
|--------|----------------|-----------|
| Agenda creation | Primary creates & starts | Primary creates, stays `not_started` |
| Execution | Primary runs all tasks | Subagent runs all tasks |
| System prompt | `AGENDA_INSTRUCTION` (general workflow) | `buildSubagentAgendaInstruction(id)` (targeted) |
| Task tracking | Primary calls task tools | Subagent calls task tools |
| Evaluation | Primary evaluates | Subagent evaluates |
| Completion | Primary completes | Subagent completes |
| Use case | Simple multi-phase work | Complex/parallel/specialized work |
| Concurrency | Single-threaded | Parallel (background mode) |

## Data Flow Diagram

```
[Primary Agent]
    |
    ├─ agenda_create(...) → id=42, state=not_started
    |
    ├─ Subagent(agenda_id=42)
    |       |
    |       └─→ [AgentManager.spawn]
    |               |
    |               └─→ [AgentRunner.spawnAndRun]
    |                       |
    |                       ├─ buildSystemPrompt(config)
    |                       ├─ + buildSubagentAgendaInstruction(42)
    |                       └─→ [Subagent Session]
    |                               |
    |                               ├─ agenda_start(42) → state=in_progress
    |                               ├─ agenda_task_start(42, 1)
    |                               ├─ [execute work]
    |                               ├─ agenda_task_done(42, 1)
    |                               ├─ agenda_evaluate(42, ...)
    |                               └─ agenda_complete(42) → state=completed
    |                                       |
    |                                       └─→ result text
    |
    └─ [receive result] → summarize to user
```

## Revision Tracking

Agenda revisions bump on every structural change (title, description, guard, tasks).

**Evaluation stale-ness check**:
- `agenda_complete` requires latest evaluation revision matches current agenda revision
- If agenda updated after evaluation → re-evaluate before completing
- Ensures acceptance guard is re-checked after any change

**Trigger**: `bumpAgendaRevision(db, agendaId)` called by:
- `agenda_update` (if title/description/acceptanceGuard changed)
- `agenda_create` when appending tasks
## Detection Strategy

Subagent sessions are detected via markers in the system prompt that vary by agent config prompt mode:

### Append Mode
- **Marker**: `<sub_agent_context>` tag present in system prompt
- **Source**: `SUBAGENT_BRIDGE` constant in `agent-runner.ts` line 89
- **Injected by**: `buildSystemPrompt()` when `promptMode === "append"`

### Replace Mode
- **Marker**: System prompt starts with `"You are a pi coding agent sub-agent."`
- **Source**: First line of system prompt in `buildSystemPrompt()` when `promptMode === "replace"`
- **Injected by**: `buildSystemPrompt()` line 128

## Guard Implementation

### Subagent Extension Guard

**File**: `extensions/subagents/index.ts` lines 148-152

**Hook**: `before_agent_start`

**Logic**:
```typescript
pi.on("before_agent_start", async (event) => {
  const sp = event.systemPrompt;
  if (sp.includes("<sub_agent_context>") || sp.startsWith("You are a pi coding agent sub-agent.")) return {};
  return { systemPrompt: event.systemPrompt + "\n\n" + buildSubagentInstruction() };
});
```

**Purpose**: Prevent injecting primary-agent orchestration instructions into subagent sessions

**Behavior**:
- If marker detected → return empty object (no-op)
- If marker absent (primary agent) → append subagent orchestration instructions

### Agenda Extension Guard

**File**: `extensions/agenda/index.ts` lines 9-16

**Hook**: `before_agent_start`

**Logic**:
```typescript
pi.on("before_agent_start", async (event) => {
  const sp = event.systemPrompt;
  if (sp.includes("<sub_agent_context>") || sp.startsWith("You are a pi coding agent sub-agent.")) return {};
  return { systemPrompt: event.systemPrompt + "\n\n" + AGENDA_INSTRUCTION };
});
```

**Purpose**: Prevent injecting primary-agent agenda workflow into subagent sessions

**Behavior**:
- If marker detected → return empty object (no-op)
- If marker absent (primary agent) → append `AGENDA_INSTRUCTION` (self-executing workflow)

**Comment in code** (line 11-13):
> "They receive a targeted agenda instruction via buildSubagentAgendaInstruction() instead."

## Guard Execution Order

Both extensions register `before_agent_start` hooks. Pi SDK calls all hooks sequentially, merging system prompts.

**For primary agent**:
1. Base system prompt from `system-prompt.ts` extension
2. Subagent extension adds orchestration instructions
3. Agenda extension adds self-executing workflow instructions

**For subagent (append mode)**:
1. Parent system prompt wrapped in `<inherited_system_prompt>`
2. `SUBAGENT_BRIDGE` tag injected
3. Agent-specific instructions from config (if any)
4. `buildSubagentAgendaInstruction(agendaId)` appended (if agenda assigned)
5. Both guards detect marker → skip injection

**For subagent (replace mode)**:
1. "You are a pi coding agent sub-agent." header
2. Environment block
3. Full agent system prompt from config
4. `buildSubagentAgendaInstruction(agendaId)` appended (if agenda assigned)
5. Both guards detect marker → skip injection

## Rationale

**Why guard?**
- Primary-agent instructions tell the agent to delegate and orchestrate
- Subagents should execute, not delegate further
- Mixing instructions causes confusion and infinite delegation loops

**Why use markers instead of flags?**
- System prompt is the authoritative source of agent context
- No need to pass boolean flags through the session creation chain
- Guards are stateless and robust across different session creation paths
## Integration Architecture

### Extension Separation
- **Agenda extension** (`extensions/agenda/`): SQLite-backed task tracker with CRUD tools and evaluation workflow
- **Subagent extension** (`extensions/subagents/`): Agent orchestration, spawning, session management
- **Integration point**: `agenda_id` parameter in Subagent tool + targeted system prompt injection

### Key Files
- `extensions/agenda/instruction.ts`: Exports `AGENDA_INSTRUCTION` (primary) and `buildSubagentAgendaInstruction(agendaId)` (subagent)
- `extensions/subagents/agent-runner.ts`: Imports `buildSubagentAgendaInstruction` and injects it into subagent system prompt
- `extensions/subagents/index.ts`: Defines `agenda_id` parameter in Subagent tool schema
- `extensions/subagents/agent-manager.ts`: Passes `agendaId` through spawn options
- `extensions/agenda/index.ts`: Guards against duplicate instruction injection in subagents

## Parameter Flow Trace

### From Primary Agent to Subagent Execution

1. **Primary agent creates agenda**:
   ```typescript
   agenda_create(title, description, acceptanceGuard, tasks) → { id: 42 }
   ```
   Agenda state: `not_started`

2. **Primary agent calls Subagent tool with agenda_id**:
   ```typescript
   Subagent({
     subagent_type: "worker",
     prompt: "Implement feature X",
     description: "implement feature X",
     agenda_id: 42  // ← parameter entry point
   })
   ```

3. **Subagent tool → AgentManager.spawn()**:
   ```typescript
   // extensions/subagents/index.ts, line 415
   manager.spawn(ctx, params.prompt, {
     description: params.description,
     agentConfig,
     model: resolvedModel,
     maxTurns,
     isolated,
     inheritContext,
     thinkingLevel: params.thinking,
     isBackground: runInBackground,
     agendaId: params.agenda_id  // ← passed to SpawnOptions
   })
   ```

4. **AgentManager → AgentRunner.spawnAndRun()**:
   ```typescript
   // extensions/subagents/agent-manager.ts, line 127
   spawnAndRun(ctx, options.agentConfig, prompt, {
     model: options.model,
     maxTurns: options.maxTurns,
     isolated: options.isolated,
     inheritContext: options.inheritContext,
     thinkingLevel: options.thinkingLevel,
     signal: record.abortController!.signal,
     activity,
     agendaId: options.agendaId  // ← forwarded
   })
   ```

5. **AgentRunner builds system prompt**:
   ```typescript
   // extensions/subagents/agent-runner.ts, lines 266-268
   let systemPrompt = buildSystemPrompt(agentConfig, cwd);
   if (options.agendaId != null) {
     systemPrompt += "\n\n" + buildSubagentAgendaInstruction(options.agendaId);
   }
   ```

6. **Subagent session starts with augmented system prompt**:
   - Base system prompt (from agent config)
   - Environment block (cwd, git, platform)
   - `<sub_agent_context>` or "You are a pi coding agent sub-agent."
   - **Agenda assignment block** (if `agendaId` present)

7. **Subagent executes workflow**:
   ```
   agenda_start(42)
   → agenda_task_start(42, 1)
   → [do work]
   → agenda_task_done(42, 1)
   → agenda_evaluate(42, summary, verdict)
   → agenda_complete(42)
   ```

### Data Structure Flow

```
Subagent Tool Parameters
  ├─ agenda_id: number (optional)
  └─ → SpawnOptions.agendaId

SpawnOptions (agent-manager.ts)
  ├─ agendaId?: number
  └─ → spawnAndRun options

AgentRunner.SpawnOptions (agent-runner.ts)
  ├─ agendaId?: number
  └─ → buildSubagentAgendaInstruction(agendaId)

buildSubagentAgendaInstruction(agendaId: number): string
  └─ Returns targeted system prompt block with workflow steps
```
