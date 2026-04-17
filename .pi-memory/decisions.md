# decisions

## Memory Directory Default

Changed default memory directory from global (`~/.pi/memory`) to project-local (`<cwd>/.pi-memory`) in v1.1.0.
Rationale: makes memory per-project by default; prevents cross-project memory bleed.
Override: set `MEMORY_MD_DIR` env var for global or custom paths.

## No TypeScript Build Step

Extensions are TypeScript files executed directly via Bun — no tsconfig.json, no compile step.
Rationale: simplicity; pi's Bun-based runtime handles TypeScript natively.

## PTC as Default Tool

`ptc` (Programmatic Tool Calling) is the mandatory default for all agent work. Individual tools (`read`, `edit`, `bash`) are reserved for specific edge cases only.
Rationale: reduces round-trips, consolidates retrieval, keeps token usage efficient.

## Skill Routing Protocol

Agents must run a deterministic skill-routing pass before any non-trivial action, scoring each available skill on four dimensions: intent, tool capability, domain specificity, keyword overlap. Auto-select when total score >= 12.
Rationale: prevents hallucinated APIs and ensures specialized tools are used consistently.

## Bundled vs Peer Dependencies

`pi-mcporter` and `pi-ask-tool-extension` are `bundledDependencies`; pi-coding-agent packages are `peerDependencies`.
Rationale: MCP bridge and ask tool must ship with the package; pi runtime is provided by the host environment.

## Extension System Instruction Pattern

Each extension injects its own domain-specific system instruction via `pi.addSystemInstruction()`. The `system-prompt.ts` extension covers package-wide policy only.
Rationale: separation of concerns; each extension is self-contained and composable.

## Avoid Markdown Tables in Memory Files

Do not use markdown tables (`|---|---|` syntax) in `.pi-memory/*.md` files.
Rationale: goldmark parser in memory-md daemon panics with `interface conversion: ast.Node is *ast.List, not *ast.ListItem` when it encounters tables. Use bullet lists instead.

## Code-Map Extension SDK Audit (v0.67.6)

Audited 2026-04-17 against pi SDK v0.67.6. Result: **fully compatible, no update needed**.

Verified:
- All `ExtensionAPI` methods used (`on`, `registerTool`, `registerCommand`, `exec`) match current signatures
- `BeforeAgentStartEventResult.systemPrompt` — extension correctly prepends `event.systemPrompt` before its own content
- `SessionStartEvent` has no `cwd`; extension correctly reads it from `ctx.cwd` (second handler arg)
- `ExecResult.{ code, stdout }` — used correctly in `resolveProjectRoot`
- `AgentToolResult<T>` shape `{ content, details }` — matched by local `text()` helper
- `ToolDefinition.execute(id, params, signal, onUpdate, ctx)` — 5-arg signature correct
- `ctx.ui.setStatus()` / `ctx.ui.notify()` — both present on `ExtensionUIContext`
- `code_map_diagnostics(severity:1)` returned clean across all 13 extension files

Daemon confirmed running and responding to all 4 methods (outline, symbol, diagnostics, impact).

## Memory-MD Footer Status Design

Footer shows 4 states: `starting…`, `indexing…`, `ready`, `stopped`.

Implementation: `getDaemonStatus(memDir)` runs `memory-md status` via `spawnSync` (fast socket roundtrip, only when socket exists). Parses stdout for `indexing: active` → `"indexing"`, `running` → `"ready"`. Falls back to `"stopped"` on any error.

Poller runs every 2s for the full session lifetime (stopped only by `session_shutdown`) — keeps indexing state visible after agent memory writes. Previous design stopped the poller once the socket appeared.

`/memory status` command now shows the `DaemonStatus` string instead of a raw running/stopped boolean.

## Memory Instruction Format (sandwich + checklist)

Rewrote `MEMORY_INSTRUCTION` in `extensions/memory-md/index.ts` to use a sandwich + checklist structure.

Problem: original was ~60 lines of uniform prose with the flush step buried last. LLM attention distributes by primacy + recency — the flush had weak weight.

Fix applied:
- **Top blockquote (primacy):** mandatory pre-reply checklist with YES/NO branch. "Skipping this = failing your job."
- **Middle:** Recall section unchanged. Store section converted to `- [ ]` checkbox list under "hard triggers" header.
- **Bottom blockquote (recency):** ⚠️ reminder to store before replying.
- File structure condensed to bullets (secondary concern).

Key principle: checkbox lists are followed more reliably than prose; bookending with blockquotes exploits primacy + recency attention.

## Subagent Agenda Instruction Injection

Subagents had agenda tools bound but never received AGENDA_INSTRUCTION in their system prompt.

Root cause: `before_agent_start` hook in `agenda/index.ts` fires for the main session only. `buildSystemPrompt()` in `agent-runner.ts` only injected `SUBAGENT_BRIDGE` + env block — no agenda instruction.

Fix (commit e1072a3):
- Extracted `AGENDA_INSTRUCTION` to `extensions/agenda/instruction.ts` as a named export
- `extensions/agenda/index.ts` imports from there (no behaviour change)
- `extensions/subagents/agent-runner.ts` imports it and appends it in both `buildSystemPrompt()` branches (append-mode and replace-mode) when extensions are enabled

Widget: the parent session's 2s poller queries the shared DB (`~/.pi/cache/agenda/<encoded-cwd>/agenda.db`). Subagent and parent share the same `cwd`, so parent widget picks up subagent agendas automatically — no widget code needed in subagent sessions (they are headless, `hasUI = false`).

## Subagent Parallel Fan-Out Instruction

The parallel fan-out pattern in `buildSubagentInstruction()` was vague — it mentioned `run_in_background` but never showed the concrete "call Subagent N times, collect with get_subagent_result" pattern.

Fix (commit 8387524): rewrote the "Foreground vs background" and "Parallel work" sections in `extensions/subagents/index.ts` to include:
- Explicit statement that foreground blocks, background runs in parallel
- 4-step numbered example showing fan-out of 3 simultaneous agents
- Rule: "Never run sequential subagents when parallel is possible"

## Subagent Agenda Delegation Flow

**Primary agent** creates agenda (`not_started`), passes `agenda_id` to `Subagent` tool. Subagent receives the ID, starts it, works through tasks, completes it, reports back. Subagents must NOT create their own agendas.

Key code change (commit 20d043b):
- `extensions/agenda/instruction.ts`: split into `AGENDA_INSTRUCTION` (primary, with delegation section) and `buildSubagentAgendaInstruction(agendaId)` (dynamic, injected per-subagent)
- `extensions/subagents/agent-manager.ts`: `SpawnOptions.agendaId?: number` + threaded through
- `extensions/subagents/agent-runner.ts`: `buildSystemPrompt()` no longer injects generic agenda instruction; instead `spawnAndRun()` appends `buildSubagentAgendaInstruction(opts.agendaId)` when id is provided
- `extensions/subagents/index.ts`: `Subagent` tool has `agenda_id?: number` parameter, passed to both foreground and background spawn calls

## before_agent_start Subagent Guard

`before_agent_start` fires for every session including subagents. Primary-agent instructions (AGENDA_INSTRUCTION, buildSubagentInstruction) must not leak into subagent sessions.

Detection pattern: every subagent system prompt contains `<sub_agent_context>` (from SUBAGENT_BRIDGE in `agent-runner.ts` `buildSystemPrompt()`). Both hooks now guard:
```ts
if (event.systemPrompt.includes("<sub_agent_context>")) return {};
```

Files fixed (commit 77bcccd):
- `extensions/agenda/index.ts` — AGENDA_INSTRUCTION skipped for subagents
- `extensions/subagents/index.ts` — buildSubagentInstruction() skipped for subagents; fan-out example updated to show agenda_create pre-step with agenda_id

## meta-agenda-coordination-pattern

**Context:** After successfully testing parallel subagent coordination (agendas #10, #11, #12 tracked by meta-agenda #13), we identified an emergent orchestration pattern that combines agenda discipline with parallel fan-out but wasn't explicitly documented in system instructions.

**Decision:** Added "Meta-agenda coordination pattern" section to `extensions/subagents/index.ts` after the "Parallel work — fan-out pattern" section.

**Pattern:**
1. Create N independent sub-agendas (each stays `not_started`)
2. Create one meta-agenda where each task tracks one sub-agenda
3. Start meta-agenda and all its tasks in parallel
4. Spawn N background subagents, each assigned one sub-agenda via `agenda_id`
5. As each subagent completes, mark its corresponding meta-task done
6. Evaluate and complete meta-agenda when all sub-agendas succeed

**Dependency handling (added 2759ad0):**
- Pattern is **best for independent tasks** that can run simultaneously
- For dependencies: use **staged spawning** instead of full parallel
  - Start only Wave 1 meta-tasks, spawn Wave 1 agents with `wait: true`
  - Mark Wave 1 done, then start Wave 2 meta-tasks
  - Spawn Wave 2 agents (can use Wave 1 results via context/memory)
- For fully sequential work: consider foreground Subagent calls or single-agenda execution

**Benefits:**
- Single meta-agenda shows orchestration status at a glance
- Each meta-task tracks one sub-agenda's lifecycle  
- Clear parent-child relationship for complex work
- Structured completion semantics (meta completes only when all subs succeed)
- Full audit trail of delegation and completion
- Works for both parallel and staged execution

**Rationale:** This pattern was synthesized from existing primitives (agenda discipline + parallel fan-out + task granularity) but makes complex orchestration significantly more explicit and manageable. It provides visual tracking, structured coordination, and clear completion semantics that weren't available with simple parallel fan-out alone.

**Implementation:** 
- Commit `55ae0bf` - Added 53-line documentation block with complete example
- Commit `2759ad0` - Added dependency handling guidance and staged spawning pattern

**Testing:** Successfully validated in session with 3 parallel subagents (Research, Explore, Worker) executing TypeScript research, architecture exploration, and integration analysis simultaneously. Meta-agenda #13 tracked all three through completion (807s work done in 487s wall time, ~40% speedup from parallelization).
