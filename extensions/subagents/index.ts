/**
 * index.ts — Subagents extension entry point.
 *
 * Registers:
 *  - Subagent tool        (foreground + background subagent spawning)
 *  - get_subagent_result  (check/retrieve background agent results)
 *  - steer_subagent       (inject message into running agent)
 *  - /subagents command   (interactive management menu)
 *  - Live widget          (● Agents above editor)
 *
 * Bundled agent definitions (agents/) are seeded to ~/.pi/agent/agents/
 * on first run if not already present there.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { AgentManager } from "./agent-manager.ts";
import { loadCustomAgents } from "./custom-agents.ts";
import { resolveModel, modelLabel } from "./model-resolver.ts";
import { getDefaultMaxTurns, setDefaultMaxTurns, getGraceTurns, setGraceTurns, ALL_BUILTIN_TOOL_NAMES } from "./agent-runner.ts";
import { AgentWidget, formatMs } from "./widget.ts";
import { SessionViewer } from "./session-viewer.ts";
import type { AgentConfig, SubagentType } from "./types.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLED_AGENTS_DIR = join(EXTENSION_DIR, "agents");
const GLOBAL_AGENTS_DIR = join(homedir(), ".pi", "agent", "agents");

// ── Seed bundled agent definitions to ~/.pi/agent/agents/ on first run ────────

function seedBundledAgents(): void {
  mkdirSync(GLOBAL_AGENTS_DIR, { recursive: true });

  let files: string[];
  try {
    files = readdirSync(BUNDLED_AGENTS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return;
  }

  for (const file of files) {
    const dest = join(GLOBAL_AGENTS_DIR, file);
    if (existsSync(dest)) continue; // never overwrite user's version
    try {
      const content = readFileSync(join(BUNDLED_AGENTS_DIR, file), "utf-8");
      writeFileSync(dest, content, "utf-8");
    } catch {
      // best-effort
    }
  }
}

// ── Agent registry ─────────────────────────────────────────────────────────────

/** Merged registry: defaults + user-defined (user overrides defaults). */
let agentRegistry = new Map<string, AgentConfig>();

function rebuildRegistry(cwd: string): void {
  agentRegistry = new Map<string, AgentConfig>();
  for (const [name, cfg] of loadCustomAgents(cwd)) agentRegistry.set(name, cfg);
}

function getConfig(name: string): AgentConfig | undefined {
  if (agentRegistry.has(name)) return agentRegistry.get(name);
  const lower = name.toLowerCase();
  for (const [key, cfg] of agentRegistry) {
    if (key.toLowerCase() === lower) return cfg;
  }
  return undefined;
}

function getAvailableTypes(): string[] {
  return [...agentRegistry.entries()]
    .filter(([, cfg]) => cfg.enabled !== false)
    .map(([name]) => name);
}

function getAllTypes(): string[] {
  return [...agentRegistry.keys()];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return formatMs(completedAt - startedAt);
  return formatMs(Date.now() - startedAt) + " (running)";
}

// ── Extension factory ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let currentCwd = process.cwd();

  function resolveCwd(ctx?: { cwd?: string }): string {
    return typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : currentCwd;
  }

  // Seed bundled agents and build registry on load
  seedBundledAgents();
  rebuildRegistry(currentCwd);

  const manager = new AgentManager(
    // onComplete — fire nudge into conversation
    (record) => {
      if (record.resultConsumed) return;
      const duration = record.completedAt
        ? formatMs(record.completedAt - record.startedAt)
        : "?";
      const statusLabel =
        record.status === "completed" ? "✓ completed"
        : record.status === "aborted"  ? "✗ aborted (turn limit)"
        : record.status === "error"    ? `✗ error: ${record.error ?? "unknown"}`
        : `■ ${record.status}`;

      const preview = record.result?.trim().slice(0, 300) ?? "(no output)";
      const dots = (record.result?.trim().length ?? 0) > 300 ? "\n…(truncated)" : "";

      pi.sendMessage(
        {
          customType: "subagents:complete",
          content: [
            `Background subagent finished — ID: ${record.id}`,
            `Type: ${record.type}  ·  ${record.description}`,
            `Status: ${statusLabel}  ·  ${record.toolUses} tool uses  ·  ${duration}`,
            "",
            preview + dots,
          ].join("\n"),
          display: true,
          details: { id: record.id, status: record.status },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );

      widget.markFinished(record.id);
    },
    // onStart
    (_record) => {
      widget.ensureTimer();
      widget.update();
    },
  );

  const widget = new AgentWidget(manager);

  // ── Events ──────────────────────────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    currentCwd = resolveCwd(ctx);
    rebuildRegistry(currentCwd);
    // Clear completed records on session switch (replaces the old session_switch event)
    if (event.reason === "new" || event.reason === "resume") {
      manager.clearCompleted();
    }
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui);
    widget.onTurnStart();
  });

  pi.on("before_agent_start", async (event) => {
    // Subagent sessions are detected by two markers depending on prompt mode:
    //   append mode  → contains <sub_agent_context> (from SUBAGENT_BRIDGE)
    //   replace mode → starts with "You are a pi coding agent sub-agent."
    // Orchestration instructions are only relevant to the primary agent.
    const sp = event.systemPrompt;
    if (sp.includes("<sub_agent_context>") || sp.startsWith("You are a pi coding agent sub-agent.")) return {};
    return { systemPrompt: event.systemPrompt + "\n\n" + buildSubagentInstruction() };
  });

  pi.on("session_shutdown", async () => {
    manager.abortAll();
    widget.dispose();
  });

  // ── Type list for tool descriptions ─────────────────────────────────────────

  function buildTypeListText(): string {
    const global  = getAllTypes().filter((n) => getConfig(n)?.source === "global");
    const project = getAllTypes().filter((n) => getConfig(n)?.source === "project");
    const lines: string[] = [];

    if (global.length > 0) {
      lines.push("Global agents (~/.pi/agent/agents/):");
      for (const name of global) {
        const cfg = getConfig(name);
        const modelSuffix = cfg?.model ? ` (${modelLabel(cfg.model)})` : "";
        lines.push(`- ${name}: ${cfg?.description ?? name}${modelSuffix}`);
      }
    }
    if (project.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("Project agents (.pi/agents/):");
      for (const name of project) {
        const cfg = getConfig(name);
        const modelSuffix = cfg?.model ? ` (${modelLabel(cfg.model)})` : "";
        lines.push(`- ${name}: ${cfg?.description ?? name}${modelSuffix}`);
      }
    }
    lines.push(
      "",
      "Agents are defined in .pi/agents/<name>.md (project) or ~/.pi/agent/agents/<name>.md (global).",
      "Project-level agents override global ones.",
    );
    return lines.join("\n");
  }

  // ── System instruction: subagent usage ──────────────────────────────────────

  /**
   * Builds the always-on subagent system-prompt section.
   *
   * Base block: when to delegate + parallel-work pattern (always injected).
   * Custom-agents block: live list of user-defined agents + selection policy
   *   (appended only when custom agents are installed).
   */
  function buildSubagentInstruction(): string {
    const lines: string[] = [
      "## Subagents",
      "",
      "The parent agent is an orchestrator: plan, delegate, summarize. Subagents do the work and report back.",
      "",
      "Delegate by default. Only handle inline when genuinely trivial.",
      "**Trivial means:** a direct answer from existing context, a single tool call, no file changes.",
      "Anything beyond that — delegate.",
      "",
      "**Always spawn a subagent for:**",
      "- Any multi-phase task (exploration, implementation, refactor, planning, commit)",
      "- Anything that requires reading more than 2 files to understand",
      "- Any work complex enough to warrant its own agenda",
      "",
      "**Never do inline:**",
      "- Multi-phase work of any kind",
      "- Reading more than 2 files",
      "- Running multi-step shell sequences",
      "- Anything that could be described as implementing or building",
      "",
      "### Foreground vs background",
      "",
      "- Foreground (default): result is needed before continuing. Runs one at a time — blocks the conversation.",
      "- Background (`run_in_background: true`): starts immediately and runs in parallel. Use for independent tasks.",
      "",
      "### Parallel work — fan-out pattern",
      "",
      "To run multiple agents simultaneously: create one agenda per independent task, then fan out with `run_in_background: true`.",
      "All agents start at once. Collect all results in parallel — call all get_subagent_result calls without waiting between them.",
      "",
      "Example:",
      "1. agenda_create(title, tasks, acceptanceGuard) → agenda_id=42  [repeat for each independent task]",
      "2. Subagent(task=A, agenda_id=42, run_in_background=true) → id-1",
      "3. Subagent(task=B, agenda_id=43, run_in_background=true) → id-2",
      "4. Subagent(task=C, agenda_id=44, run_in_background=true) → id-3",
      "5. get_subagent_result(id-1, wait=true)  \\",
      "   get_subagent_result(id-2, wait=true)  \\  ← issue all three simultaneously",
      "   get_subagent_result(id-3, wait=true)",
      "",
      "Use this pattern whenever tasks are independent. Never run sequential subagents when parallel is possible.",
      "- `get_subagent_result` — retrieve output when done (`wait: true` to block)",
      "- `steer_subagent` — redirect a running agent mid-run",
      "- `resume` param — continue a previous agent from where it left off",
      "",
      "### Meta-agenda coordination pattern",
      "",
      "For complex orchestration where you need to track multiple parallel sub-agendas.",
      "**Best for independent tasks** that can run simultaneously. See below for handling dependencies.",
      "",
      "1. Create independent sub-agendas (one per task, stays \`not_started\`)",
      "2. Create a meta-agenda where each task represents tracking one sub-agenda",
      "3. Start the meta-agenda and all its tasks in parallel",
      "4. Spawn background subagents, each assigned one sub-agenda via \`agenda_id\`",
      "5. As each subagent completes, mark its corresponding meta-task done",
      "6. Evaluate and complete the meta-agenda when all sub-agendas succeed",
      "",
      "**Dependencies:** If sub-agendas have dependencies, use staged spawning instead of parallel:",
      "- Don't start all meta-tasks at once — start only independent tasks first",
      "- Spawn and wait for Wave 1 agents (\`wait: true\` on \`get_subagent_result\`)",
      "- Mark Wave 1 meta-tasks done, then start Wave 2 meta-tasks",
      "- Spawn Wave 2 agents (can use Wave 1 results via context or memory)",
      "- For fully sequential work, consider foreground Subagent calls or single-agenda execution instead",
      "",
      "Example:",
      "\`\`\`",
      "// Create sub-agendas",
      "agenda_create(title=\"Research X\") → id=10",
      "agenda_create(title=\"Explore Y\") → id=11",
      "agenda_create(title=\"Analyze Z\") → id=12",
      "",
      "// Create meta-agenda to track them",
      "agenda_create(",
      "  title=\"Parallel coordination\",",
      "  tasks=[\"Track #10: Research\", \"Track #11: Explore\", \"Track #12: Analyze\"],",
      "  acceptanceGuard=\"All sub-agendas completed successfully\"",
      ") → id=13",
      "",
      "// Start meta-agenda and all tasks in parallel",
      "agenda_start(13)",
      "agenda_task_start(13, 1)",
      "agenda_task_start(13, 2)",
      "agenda_task_start(13, 3)",
      "",
      "// Spawn all subagents in background",
      "Subagent(agenda_id=10, run_in_background=true) → agent-1",
      "Subagent(agenda_id=11, run_in_background=true) → agent-2",
      "Subagent(agenda_id=12, run_in_background=true) → agent-3",
      "",
      "// As agents complete (you'll be notified):",
      "get_subagent_result(agent-1) → agenda_task_done(13, 1)",
      "get_subagent_result(agent-2) → agenda_task_done(13, 2)",
      "get_subagent_result(agent-3) → agenda_task_done(13, 3)",
      "",
      "// Evaluate and complete",
      "agenda_evaluate(13, verdict=\"pass\", evidence=[...])",
      "agenda_complete(13)",
      "\`\`\`",
      "",
      "Benefits:",
      "- Single meta-agenda shows orchestration status at a glance",
      "- Each meta-task tracks one sub-agenda's lifecycle",
      "- Clear parent-child relationship for complex work",
      "- Structured completion: meta-agenda completes only when all sub-agendas succeed",
      "- Full audit trail of what was delegated and when it completed",
      "",
      "### Available agents",
      "",
      "Read each agent's description and pick the best fit for the task.",
      "If no agent matches, handle the work inline.",
    ];

    const global  = getAllTypes().filter((n) => getConfig(n)?.source === "global");
    const project = getAllTypes().filter((n) => getConfig(n)?.source === "project");

    if (project.length > 0) {
      lines.push("", "Project agents (.pi/agents/):");
      for (const name of project) {
        const cfg = getConfig(name);
        const modelSuffix = cfg?.model ? ` [${modelLabel(cfg.model)}]` : "";
        lines.push(`- **${name}**${modelSuffix}: ${cfg?.description ?? name}`);
      }
    }

    if (global.length > 0) {
      lines.push("", "Global agents (~/.pi/agent/agents/):");
      for (const name of global) {
        const cfg = getConfig(name);
        const modelSuffix = cfg?.model ? ` [${modelLabel(cfg.model)}]` : "";
        lines.push(`- **${name}**${modelSuffix}: ${cfg?.description ?? name}`);
      }
    }

    return lines.join("\n");
  }

  // =====================================================================
  // Tool: Subagent
  // =====================================================================


  pi.registerTool({
    name: "Subagent",
    label: "Subagent",
    description: `Launch a new subagent to handle complex, multi-step tasks autonomously.

The Subagent tool launches specialized subagents that autonomously handle complex tasks. Each subagent type has specific capabilities and tools available to it.

Available subagent types:
${buildTypeListText()}

Guidelines:
- Delegate to a subagent by default. Only handle work inline when it is a single, trivial action.
- Hard triggers: exploration across >2 files → Explore; implementation/refactor/edit → general; committing staged changes → git-commit; any task with 3+ steps → general.
- Read each agent's description and pick the best fit. The available agents are listed in the system prompt.
- For parallel work, use run_in_background: true on each subagent. Foreground calls run sequentially — only one executes at a time.
- Provide clear, detailed prompts so the subagent can work autonomously.
- Subagent results are returned as text — summarize them for the user.
- Use run_in_background for work you don't need immediately. You will be notified when it completes.
- Pass agenda_id when the primary agent has pre-created a not_started agenda for this task. The subagent will start, execute, and complete it.
- Use resume with an agent ID to continue a previous subagent's work.
- Use steer_subagent to send mid-run messages to a running background subagent.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the subagent needs the parent conversation history.`,
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task for the agent to perform.",
      }),
      description: Type.String({
        description: "A short (3-5 word) description of the task (shown in UI).",
      }),
      subagent_type: Type.String({
        description: `The type of specialized subagent to use. Available types: ${getAvailableTypes().join(", ")}. Agents are defined in .pi/agents/<name>.md (project) or ~/.pi/agent/agents/<name>.md (global).`,
      }),
      model: Type.Optional(Type.String({
        description: 'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to use the agent type\'s default.',
      })),
      thinking: Type.Optional(Type.String({
        description: "Thinking level: off, minimal, low, medium, high, xhigh. Overrides agent default.",
      })),
      max_turns: Type.Optional(Type.Number({
        description: "Maximum number of agentic turns before stopping. Omit for unlimited (default).",
        minimum: 1,
      })),
      run_in_background: Type.Optional(Type.Boolean({
        description: "Set to true to run in background. Returns agent ID immediately. You will be notified on completion.",
      })),
      resume: Type.Optional(Type.String({
        description: "Optional agent ID to resume from. Continues from previous context.",
      })),
      isolated: Type.Optional(Type.Boolean({
        description: "If true, agent gets no extension/MCP tools — only built-in tools.",
      })),
      inherit_context: Type.Optional(Type.Boolean({
        description: "If true, fork parent conversation into the agent. Default: false (fresh context).",
      })),
      agenda_id: Type.Optional(Type.Number({
        description: "ID of a not_started agenda created by the primary agent. The subagent will start, execute, and complete this agenda.",
        minimum: 1,
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      currentCwd = resolveCwd(ctx);
      rebuildRegistry(currentCwd);
      widget.setUICtx(ctx.ui);

      const rawType = params.subagent_type as SubagentType;
      const agentConfig = getConfig(rawType) ?? getConfig("worker")!;
      const fellBack = !getConfig(rawType);

      // Resolve model override
      let resolvedModel = ctx.model;
      if (params.model) {
        const found = resolveModel(params.model, ctx.modelRegistry);
        if (typeof found === "string") return textResult(found);
        resolvedModel = found;
      } else if (agentConfig.model) {
        const found = resolveModel(agentConfig.model, ctx.modelRegistry);
        if (typeof found !== "string") resolvedModel = found;
      }

      const runInBackground = agentConfig.runInBackground ?? params.run_in_background ?? false;
      const isolated        = agentConfig.isolated        ?? params.isolated         ?? false;
      const inheritContext  = agentConfig.inheritContext  ?? params.inherit_context   ?? false;
      const maxTurns        = params.max_turns ?? agentConfig.maxTurns ?? getDefaultMaxTurns();

      const fallbackNote = fellBack
        ? `Note: Unknown subagent type "${rawType}" — using general.\n\n`
        : "";

      // Resume existing agent
      if (params.resume) {
        const record = manager.getRecord(params.resume);
        if (!record) return textResult(`Agent not found: "${params.resume}". It may have been cleaned up.`);
        if (!record.session) return textResult(`Agent "${params.resume}" has no active session to resume.`);
        const updated = await manager.resume(params.resume, params.prompt);
        if (!updated) return textResult(`Failed to resume agent "${params.resume}".`);
        return textResult(
          `${fallbackNote}${updated.result?.trim() || updated.error?.trim() || "No output."}`,
        );
      }

      // Background execution
      if (runInBackground) {
        const id = manager.spawn({ ...ctx, cwd: currentCwd }, params.prompt, {
          description:    params.description,
          agentConfig,
          model:          resolvedModel,
          maxTurns,
          isolated,
          inheritContext,
          thinkingLevel:  params.thinking as any,
          isBackground:   true,
          agendaId:       params.agenda_id,
        });

        const record   = manager.getRecord(id);
        const isQueued = record?.status === "queued";
        return textResult(
          `${fallbackNote}Agent ${isQueued ? "queued" : "started"} in background.\n` +
          `Agent ID: ${id}\n` +
          `Type: ${agentConfig.displayName ?? agentConfig.name}\n` +
          `Description: ${params.description}\n` +
          (isQueued ? `Status: queued (${manager.getMaxConcurrent()} max concurrent)\n` : "") +
          `\nYou will be notified when this agent completes.\n` +
          `Use get_subagent_result to retrieve results, or steer_subagent to send messages.\n` +
          `Do not duplicate this agent's work.`,
        );
      }

      // Foreground execution
      const record = await manager.spawnAndWait({ ...ctx, cwd: currentCwd }, params.prompt, {
        description:    params.description,
        agentConfig,
        model:          resolvedModel,
        maxTurns,
        isolated,
        inheritContext,
        thinkingLevel:  params.thinking as any,
        agendaId:       params.agenda_id,
      });

      widget.markFinished(record.id);

      if (record.status === "error") {
        return textResult(`${fallbackNote}Agent failed: ${record.error}`);
      }

      const duration = record.completedAt ? formatMs(record.completedAt - record.startedAt) : "?";
      return textResult(
        `${fallbackNote}Agent completed in ${duration} (${record.toolUses} tool uses).\n\n` +
        (record.result?.trim() || "No output."),
      );
    },
  });

  // =====================================================================
  // Tool: get_subagent_result
  // =====================================================================

  pi.registerTool({
    name: "get_subagent_result",
    label: "Get Agent Result",
    description: "Check status and retrieve results from a background agent. Use the agent ID returned by Agent with run_in_background.",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to check.",
      }),
      wait: Type.Optional(Type.Boolean({
        description: "If true, wait for the agent to complete before returning. Default: false.",
      })),
      verbose: Type.Optional(Type.Boolean({
        description: "If true, include a preview of the agent's last output text. Default: false.",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const record = manager.getRecord(params.agent_id);
      if (!record) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }

      if (params.wait && (record.status === "running" || record.status === "queued") && record.promise) {
        record.resultConsumed = true;
        await record.promise;
      }

      const duration = formatDuration(record.startedAt, record.completedAt);
      const activity = manager.getActivity(params.agent_id);
      const turns    = activity ? `${activity.turnCount} turns` : "";
      const tools    = `${record.toolUses} tool uses`;
      const stats    = [turns, tools, duration].filter(Boolean).join(" · ");

      let output =
        `Agent: ${record.id}\n` +
        `Type: ${record.type}  ·  Status: ${record.status}  ·  ${stats}\n` +
        `Description: ${record.description}\n\n`;

      if (record.status === "running" || record.status === "queued") {
        output += "Subagent is still running. Use wait: true or check back later.";
      } else if (record.status === "error") {
        output += `Error: ${record.error}`;
      } else {
        output += record.result?.trim() || "No output.";
        if (params.verbose && activity?.lastText) {
          output += `\n\n--- Last streamed text ---\n${activity.lastText.slice(0, 500)}`;
        }
      }

      if (record.status !== "running" && record.status !== "queued") {
        record.resultConsumed = true;
      }

      return textResult(output);
    },
  });

  // =====================================================================
  // Tool: steer_subagent
  // =====================================================================

  pi.registerTool({
    name: "steer_subagent",
    label: "Steer Agent",
    description: "Send a steering message to a running agent. The message will be injected into its conversation, allowing you to redirect its work mid-run. Only works on running agents.",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to steer (must be currently running).",
      }),
      message: Type.String({
        description: "The steering message to send. This will appear as a user message in the agent's conversation.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const record = manager.getRecord(params.agent_id);
      if (!record) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }
      if (record.status === "queued") {
        record.pendingSteers = record.pendingSteers ?? [];
        record.pendingSteers.push(params.message);
        return textResult(`Agent ${record.id} is queued. Message will be delivered when it starts running.`);
      }
      if (record.status !== "running") {
        return textResult(`Agent "${params.agent_id}" is not running (status: ${record.status}).`);
      }

      const ok = await manager.steer(params.agent_id, params.message);
      if (!ok) {
        return textResult(`Failed to steer agent "${params.agent_id}".`);
      }
      return textResult(`Steering message sent to agent ${record.id}. It will be processed after the current tool execution.`);
    },
  });

  // =====================================================================
  // Command: /subagents
  // =====================================================================

  const BUILTIN_TOOL_NAMES = ALL_BUILTIN_TOOL_NAMES;

  function agentsDir(kind: "project" | "global"): string {
    return kind === "project"
      ? join(currentCwd, ".pi", "agents")
      : GLOBAL_AGENTS_DIR;
  }

  function findAgentFile(name: string): { path: string; location: "project" | "global" } | undefined {
    const project = join(agentsDir("project"), `${name}.md`);
    if (existsSync(project)) return { path: project, location: "project" };
    const global  = join(agentsDir("global"),  `${name}.md`);
    if (existsSync(global))  return { path: global,  location: "global" };
    return undefined;
  }

  async function showAgentsMenu(ctx: any): Promise<void> {
    currentCwd = resolveCwd(ctx);
    rebuildRegistry(currentCwd);

    const records = manager.listRecords();
    const running = records.filter((r) => r.status === "running" || r.status === "queued");
    const allTypes = getAllTypes();

    const options: string[] = [];
    if (records.length > 0) options.push(`Running subagents (${records.length}) — ${running.length} active`);
    if (allTypes.length > 0) options.push(`Subagent types (${allTypes.length})`);
    options.push("Create new subagent");
    options.push("Settings");

    const choice = await ctx.ui.select("Subagents", options);
    if (!choice) return;

    if (choice.startsWith("Running subagents"))  await showRunningAgents(ctx);
    else if (choice.startsWith("Subagent types")) await showAgentTypesList(ctx);
    else if (choice === "Create new subagent")   await showCreateWizard(ctx);
    else if (choice === "Settings")              await showSettings(ctx);
  }

  // ── Session viewer overlay ─────────────────────────────────────────────────

  async function showAgentSession(ctx: any, record: any): Promise<void> {
    const isLive = record.status === "running" || record.status === "queued";

    await ctx.ui.custom(
      (tui: any, theme: any, _kb: any, done: (v: any) => void) => {
        const viewer = new SessionViewer(
          record,
          () => manager.getActivity(record.id),
          theme,
        );
        viewer.onClose = () => {
          if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = undefined; }
          done(undefined);
        };

        let refreshTimer: ReturnType<typeof setInterval> | undefined;
        if (isLive) {
          refreshTimer = setInterval(() => tui.requestRender(), 300);
        }

        return {
          render:      (w: number) => viewer.render(w),
          invalidate:  ()          => viewer.invalidate(),
          handleInput: (data: string) => {
            viewer.handleInput(data);
            tui.requestRender();
          },
        };
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "95%",
          maxHeight: "95%",
        },
      },
    );
  }

  // ── Running-agents list ───────────────────────────────────────────────────

  async function showRunningAgents(ctx: any): Promise<void> {
    const records = manager.listRecords();
    if (records.length === 0) { ctx.ui.notify("No subagents.", "info"); return; }

    const options = records.map((r) => {
      const activity = manager.getActivity(r.id);
      const dur      = formatDuration(r.startedAt, r.completedAt);
      const turns    = activity ? ` ⟳${activity.turnCount}` : "";
      return `${r.type}  (${r.description})  ·  ${r.status}${turns}  ·  ${dur}`;
    });

    const choice = await ctx.ui.select("Subagents", options);
    if (!choice) return;

    const idx    = options.indexOf(choice);
    if (idx < 0) return;
    const record = records[idx];

    const isActive = record.status === "running" || record.status === "queued";
    const actions: string[] = ["View session"];
    if (isActive) actions.push("Stop subagent");
    actions.push("Back");

    const action = await ctx.ui.select(`${record.type}  ·  ${record.description}`, actions);
    if (!action || action === "Back") return;

    if (action === "View session") {
      await showAgentSession(ctx, record);
    } else if (action === "Stop subagent") {
      const ok = await ctx.ui.confirm("Stop subagent?", `Abort: ${record.description}`);
      if (ok) {
        manager.abort(record.id);
        ctx.ui.notify(`Subagent ${record.id} stopped.`, "info");
      }
    }
  }

  // ── Agent types list ──────────────────────────────────────────────────────

  async function showAgentTypesList(ctx: any): Promise<void> {
    const allTypes = getAllTypes();
    if (allTypes.length === 0) { ctx.ui.notify("No subagent types defined.", "info"); return; }

    const options = allTypes.map((name) => {
      const cfg = getConfig(name);
      const src = cfg?.isDefault ? "  " : cfg?.source === "project" ? "• " : "◦ ";
      const dis = cfg?.enabled === false ? "✕ " : "";
      const model = cfg?.model ? `  [${modelLabel(cfg.model)}]` : "";
      return `${dis}${src}${name}${model}  —  ${cfg?.description ?? name}`;
    });

    const choice = await ctx.ui.select("Subagent types  (• = project  ◦ = global  ✕ = disabled)", options);
    if (!choice) return;

    const idx = options.indexOf(choice);
    if (idx < 0) return;
    await showAgentDetail(ctx, allTypes[idx]);
  }

  async function showAgentDetail(ctx: any, name: string): Promise<void> {
    const cfg = getConfig(name);
    if (!cfg) { ctx.ui.notify(`Config not found for "${name}".`, "warning"); return; }

    const file      = findAgentFile(name);
    const isDefault = cfg.isDefault === true;
    const disabled  = cfg.enabled === false;

    let menuOptions: string[];
    if (disabled && file) {
      menuOptions = isDefault
        ? ["Enable", "Edit", "Reset to default", "Delete"]
        : ["Enable", "Edit", "Delete"];
    } else if (isDefault && !file) {
      menuOptions = ["Eject (export as .md)", "Disable"];
    } else if (isDefault && file) {
      menuOptions = ["Edit", "Disable", "Reset to default", "Delete"];
    } else {
      menuOptions = ["Edit", "Disable", "Delete"];
    }

    const choice = await ctx.ui.select(name, menuOptions);
    if (!choice) return;

    if (choice === "Edit" && file) {
      const current = readFileSync(file.path, "utf-8");
      const edited  = await ctx.ui.editor(`Edit ${name}`, current);
      if (edited !== undefined && edited !== current) {
        writeFileSync(file.path, edited, "utf-8");
        rebuildRegistry(resolveCwd(ctx));
        ctx.ui.notify(`Saved ${file.path}`, "info");
      }
    } else if (choice === "Delete" && file) {
      const ok = await ctx.ui.confirm("Delete subagent", `Delete ${name} from ${file.location} (${file.path})?`);
      if (ok) {
        unlinkSync(file.path);
        rebuildRegistry(resolveCwd(ctx));
        ctx.ui.notify(`Deleted ${file.path}`, "info");
      }
    } else if (choice === "Reset to default" && file) {
      const ok = await ctx.ui.confirm("Reset to default", `Remove override at ${file.path} and restore built-in defaults?`);
      if (ok) {
        unlinkSync(file.path);
        rebuildRegistry(resolveCwd(ctx));
        ctx.ui.notify(`Restored default ${name}`, "info");
      }
    } else if (choice === "Eject (export as .md)") {
      await ejectAgent(ctx, name, cfg);
    } else if (choice === "Disable") {
      await disableAgent(ctx, name);
    } else if (choice === "Enable") {
      await enableAgent(ctx, name);
    }
  }

  async function ejectAgent(ctx: any, name: string, cfg: AgentConfig): Promise<void> {
    const loc = await ctx.ui.select("Save to", [
      "Project (.pi/agents/)",
      "Global (~/.pi/agent/agents/)",
    ]);
    if (!loc) return;

    const targetDir = loc.startsWith("Project") ? agentsDir("project") : agentsDir("global");
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${name}.md`);

    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite?", `${targetPath} already exists.`);
      if (!overwrite) return;
    }

    const fm: string[] = [`description: ${cfg.description}`];
    if (cfg.displayName) fm.push(`display_name: ${cfg.displayName}`);
    fm.push(`tools: ${cfg.builtinToolNames?.join(", ") ?? "all"}`);
    if (cfg.model)     fm.push(`model: ${cfg.model}`);
    if (cfg.thinking)  fm.push(`thinking: ${cfg.thinking}`);
    if (cfg.maxTurns)  fm.push(`max_turns: ${cfg.maxTurns}`);
    fm.push(`prompt_mode: ${cfg.promptMode}`);
    if (cfg.extensions === false)          fm.push("extensions: false");
    else if (Array.isArray(cfg.extensions)) fm.push(`extensions: ${cfg.extensions.join(", ")}`);

    const content = `---\n${fm.join("\n")}\n---\n\n${cfg.systemPrompt}\n`;
    writeFileSync(targetPath, content, "utf-8");
    rebuildRegistry(resolveCwd(ctx));
    ctx.ui.notify(`Ejected ${name} to ${targetPath}`, "info");
  }

  async function disableAgent(ctx: any, name: string): Promise<void> {
    const file = findAgentFile(name);
    if (file) {
      const content = readFileSync(file.path, "utf-8");
      if (content.includes("\nenabled: false\n")) {
        ctx.ui.notify(`${name} is already disabled.`, "info");
        return;
      }
      writeFileSync(file.path, content.replace(/^---\n/, "---\nenabled: false\n"), "utf-8");
      rebuildRegistry(resolveCwd(ctx));
      ctx.ui.notify(`Disabled ${name}`, "info");
      return;
    }
    const loc = await ctx.ui.select("Save stub to", [
      "Project (.pi/agents/)",
      "Global (~/.pi/agent/agents/)",
    ]);
    if (!loc) return;
    const dir = loc.startsWith("Project") ? agentsDir("project") : agentsDir("global");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), "---\nenabled: false\n---\n", "utf-8");
    rebuildRegistry(resolveCwd(ctx));
    ctx.ui.notify(`Disabled ${name}`, "info");
  }

  async function enableAgent(ctx: any, name: string): Promise<void> {
    const file = findAgentFile(name);
    if (!file) return;
    const content = readFileSync(file.path, "utf-8");
    const updated = content.replace(/^(---\n)enabled: false\n/, "$1");
    if (updated.trim() === "---\n---" || updated.trim() === "---\n---\n") {
      unlinkSync(file.path);
      rebuildRegistry(resolveCwd(ctx));
      ctx.ui.notify(`Enabled ${name} (removed stub)`, "info");
    } else {
      writeFileSync(file.path, updated, "utf-8");
      rebuildRegistry(resolveCwd(ctx));
      ctx.ui.notify(`Enabled ${name}`, "info");
    }
  }

  async function showCreateWizard(ctx: any): Promise<void> {
    const loc = await ctx.ui.select("Save to", [
      "Project (.pi/agents/)",
      "Global (~/.pi/agent/agents/)",
    ]);
    if (!loc) return;
    const targetDir = loc.startsWith("Project") ? agentsDir("project") : agentsDir("global");

    const name = await ctx.ui.input("Subagent name (no spaces, no .md)");
    if (!name?.trim()) return;
    const safeName = name.trim();

    const description = await ctx.ui.input("One-line description");
    if (!description?.trim()) return;

    const toolChoice = await ctx.ui.select("Tools", [
      "all built-in tools",
      "read-only  (read, bash, grep, find, ls)",
      "no tools",
      "custom…",
    ]);
    if (!toolChoice) return;

    let tools: string;
    if (toolChoice.startsWith("all"))       tools = BUILTIN_TOOL_NAMES.join(", ");
    else if (toolChoice.startsWith("read")) tools = "read, bash, grep, find, ls";
    else if (toolChoice.startsWith("no"))   tools = "none";
    else {
      const custom = await ctx.ui.input("Tool names (comma-separated)", BUILTIN_TOOL_NAMES.join(", "));
      if (!custom) return;
      tools = custom;
    }

    const modelChoice = await ctx.ui.select("Model", [
      "inherit (parent model)",
      "haiku",
      "sonnet",
      "opus",
      "custom…",
    ]);
    if (!modelChoice) return;

    let modelLine = "";
    if      (modelChoice === "haiku")    modelLine = "\nmodel: anthropic/claude-haiku-4-5-20251001";
    else if (modelChoice === "sonnet")   modelLine = "\nmodel: anthropic/claude-sonnet-4-5";
    else if (modelChoice === "opus")     modelLine = "\nmodel: anthropic/claude-opus-4-5";
    else if (modelChoice === "custom…") {
      const m = await ctx.ui.input("Model (provider/modelId)");
      if (m) modelLine = `\nmodel: ${m}`;
    }

    const thinkingChoice = await ctx.ui.select("Thinking level", [
      "inherit", "off", "minimal", "low", "medium", "high", "xhigh",
    ]);
    if (!thinkingChoice) return;
    const thinkingLine = thinkingChoice !== "inherit" ? `\nthinking: ${thinkingChoice}` : "";

    const extensionsChoice = await ctx.ui.select("Extension/MCP tools", [
      "inherit (same as parent)",
      "none (built-in tools only)",
    ]);
    if (!extensionsChoice) return;
    const extensionsLine = extensionsChoice.startsWith("none") ? "\nextensions: false" : "";

    const promptModeChoice = await ctx.ui.select("Prompt mode", [
      "replace — body is the full system prompt",
      "append  — body is appended to default prompt",
    ]);
    if (!promptModeChoice) return;
    const promptMode = promptModeChoice.startsWith("replace") ? "replace" : "append";

    const systemPrompt = await ctx.ui.editor(
      `System prompt for ${safeName}`,
      promptMode === "append"
        ? "# Additional instructions\n\nYou are specialized in ...\n"
        : "# Role\nYou are a specialized agent for ...\n\n# Instructions\n",
    );
    if (systemPrompt === undefined) return;

    const content = [
      "---",
      `description: ${description.trim()}`,
      `tools: ${tools}${modelLine}${thinkingLine}${extensionsLine}`,
      `prompt_mode: ${promptMode}`,
      "---",
      "",
      systemPrompt,
    ].join("\n");

    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${safeName}.md`);

    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite?", `${targetPath} already exists.`);
      if (!overwrite) return;
    }

    writeFileSync(targetPath, content, "utf-8");
    rebuildRegistry(resolveCwd(ctx));
    ctx.ui.notify(`Created ${targetPath}`, "info");
  }

  async function showSettings(ctx: any): Promise<void> {
    const choice = await ctx.ui.select("Settings", [
      `Max concurrency  (current: ${manager.getMaxConcurrent()})`,
      `Default max turns  (current: ${getDefaultMaxTurns() ?? "unlimited"})`,
      `Grace turns  (current: ${getGraceTurns()})`,
    ]);
    if (!choice) return;

    if (choice.startsWith("Max concurrency")) {
      const val = await ctx.ui.input("Max concurrent background agents", String(manager.getMaxConcurrent()));
      if (val) {
        const n = parseInt(val, 10);
        if (n >= 1) { manager.setMaxConcurrent(n); ctx.ui.notify(`Max concurrency → ${n}`, "info"); }
        else ctx.ui.notify("Must be ≥ 1.", "warning");
      }
    } else if (choice.startsWith("Default max turns")) {
      const val = await ctx.ui.input("Default max turns (0 = unlimited)", String(getDefaultMaxTurns() ?? 0));
      if (val) {
        const n = parseInt(val, 10);
        if (n === 0)      { setDefaultMaxTurns(undefined); ctx.ui.notify("Max turns → unlimited", "info"); }
        else if (n >= 1)  { setDefaultMaxTurns(n);         ctx.ui.notify(`Max turns → ${n}`, "info"); }
        else ctx.ui.notify("Must be 0 (unlimited) or ≥ 1.", "warning");
      }
    } else if (choice.startsWith("Grace turns")) {
      const val = await ctx.ui.input("Grace turns after wrap-up steer", String(getGraceTurns()));
      if (val) {
        const n = parseInt(val, 10);
        if (n >= 1) { setGraceTurns(n); ctx.ui.notify(`Grace turns → ${n}`, "info"); }
        else ctx.ui.notify("Must be ≥ 1.", "warning");
      }
    }
  }

  pi.registerCommand("subagents", {
    description: "Manage subagents — list running, browse types, create, configure",
    handler: async (_args, ctx) => {
      await showAgentsMenu(ctx);
    },
  });

  // =====================================================================
  // Command: /delegate
  // =====================================================================

  pi.registerCommand("delegate", {
    description: "Delegate a task directly to a named subagent. Usage: /delegate <agent> [task]",

    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      // Only offer completions while the user is still typing the agent name
      // (no space yet in the prefix).
      if (prefix.includes(" ")) return null;
      rebuildRegistry(currentCwd);
      return getAvailableTypes()
        .filter((name) => name.toLowerCase().startsWith(prefix.toLowerCase()))
        .map((name) => {
          const cfg = getConfig(name);
          return {
            value: name + " ",
            label: name,
            description: cfg?.description,
          };
        });
    },

    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();

      if (!trimmed) {
        ctx.ui.notify("Usage: /delegate <agent-name> [task]", "error");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      currentCwd = resolveCwd(ctx);
      rebuildRegistry(currentCwd);
      const agentConfig = getConfig(agentName);

      if (!agentConfig) {
        const available = getAvailableTypes().join(", ") || "none";
        ctx.ui.notify(`Unknown agent: "${agentName}". Available: ${available}`, "error");
        return;
      }

      ctx.ui.notify(`Delegating to ${agentName}…`, "info");

      const description = task.length > 50 ? task.slice(0, 50) + "…" : (task || agentName);
      const record = await manager.spawnAndWait({ ...ctx, cwd: currentCwd }, task, {
        description,
        agentConfig,
      });

      widget.markFinished(record.id);

      if (record.status === "error") {
        ctx.ui.notify(
          `${agentName} failed: ${record.error?.slice(0, 200) ?? "unknown error"}`,
          "error",
        );
        return;
      }

      const output = record.result?.trim() || "(no output)";
      const duration = record.completedAt
        ? formatMs(record.completedAt - record.startedAt)
        : "?";
      const stats = `${agentName} · ${duration} · ${record.toolUses} tool use${record.toolUses !== 1 ? "s" : ""}`;

      pi.sendMessage(
        {
          customType: "delegate:result",
          content: `[${stats}]\n\n${output}`,
          display: true,
          details: { agentName, agentId: record.id, status: record.status },
        },
        { deliverAs: "followUp" },
      );
    },
  });
}
