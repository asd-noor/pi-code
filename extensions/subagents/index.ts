/**
 * index.ts — Subagents extension entry point.
 *
 * Registers:
 *   - Subagent           (foreground + background agent spawning)
 *   - MultiSubagent       (fan-out N independent agents in one shot)
 *   - get_subagent_result (check / retrieve background agent results)
 *   - steer_subagent      (inject a message into a running agent)
 *   - /subagents          (list running agents, view sessions)
 *   - /delegate           (quick-delegate to a named agent)
 *   - Live widget         (● Subagents above editor)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadAgents } from "./agents.ts";
import { AgentManager } from "./agent-manager.ts";
import { resolveModel, modelLabel } from "./model-resolver.ts";
import { getDefaultMaxTurns, setDefaultMaxTurns, getGraceTurns, setGraceTurns, ALL_BUILTIN_TOOL_NAMES } from "./agent-runner.ts";
import { AgentWidget, formatMs } from "./widget.ts";
import { SessionViewer } from "./session-viewer.ts";
import type { AgentConfig } from "./types.ts";

// ---- Seed bundled agents --------------------------------------------------

const EXTENSION_DIR    = dirname(fileURLToPath(import.meta.url));
const BUNDLED_AGENTS_DIR = join(EXTENSION_DIR, "agents");
const GLOBAL_AGENTS_DIR  = join(homedir(), ".pi", "agent", "agents");

/**
 * Copy bundled agent .md files to ~/.pi/agent/agents/ on first run.
 * Never overwrites files the user has already customised.
 */
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
      writeFileSync(dest, readFileSync(join(BUNDLED_AGENTS_DIR, file), "utf-8"), "utf-8");
    } catch {
      // best-effort
    }
  }
}

// ---- Agent registry -------------------------------------------------------

let agentRegistry = new Map<string, AgentConfig>();

function rebuildRegistry(cwd: string): void {
  agentRegistry = loadAgents(cwd);
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

// ---- Helpers --------------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function resolveCwd(ctx?: { cwd?: string }, fallback = process.cwd()): string {
  return typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : fallback;
}

// ---- Type-list text (for tool descriptions) -------------------------------

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

// ---- System instruction ---------------------------------------------------

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
    "- Background (`run_in_background: true`): starts immediately. Use for independent tasks.",
    "",
    "### Parallel work — fan-out with MultiSubagent",
    "",
    "To run multiple independent agents in one shot, use the `MultiSubagent` tool.",
    "Pass a `tasks` array — all agents start concurrently and results come back aggregated in one response.",
    "Use `MultiSubagent` instead of calling `Subagent` repeatedly when tasks are independent.",
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

// ---- Extension factory ----------------------------------------------------

export default function (pi: ExtensionAPI) {
  let currentCwd = process.cwd();

  seedBundledAgents();
  rebuildRegistry(currentCwd);

  const manager = new AgentManager(
    // onComplete
    (record) => {
      if (record.resultConsumed) return;
      const duration = record.completedAt ? formatMs(record.completedAt - record.startedAt) : "?";
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

  // ---- Events ----------------------------------------------------------------

  pi.on("session_start", async (event, ctx) => {
    currentCwd = resolveCwd(ctx, currentCwd);
    rebuildRegistry(currentCwd);
    if (event.reason === "new" || event.reason === "resume") {
      manager.clearCompleted();
    }
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui);
    widget.onTurnStart();
  });

  pi.on("before_agent_start", async (event) => {
    const sp = event.systemPrompt;
    // Don't inject into sub-agents (they have the SUBAGENT_BRIDGE marker)
    if (sp.includes("<sub_agent_context>") || sp.startsWith("You are a pi coding agent sub-agent.")) {
      return {};
    }
    return { systemPrompt: event.systemPrompt + "\n\n" + buildSubagentInstruction() };
  });

  pi.on("session_shutdown", async () => {
    manager.abortAll();
    widget.dispose();
  });

  // =========================================================================
  // Tool: Subagent
  // =========================================================================

  pi.registerTool({
    name: "Subagent",
    label: "Subagent",
    description: `Launch a new subagent to handle complex, multi-step tasks autonomously.

The Subagent tool launches specialized subagents that autonomously handle complex tasks. Each subagent type has specific capabilities and tools available to it.

Available subagent types:
${buildTypeListText()}

Guidelines:
- Delegate to a subagent by default. Only handle work inline when it is a single, trivial action.
- Hard triggers: exploration across >2 files → Explore; implementation/refactor/edit → worker; committing staged changes → git-commit; any task with 3+ steps → worker.
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
      prompt: Type.String({ description: "The task for the agent to perform." }),
      description: Type.String({ description: "A short (3-5 word) description of the task (shown in UI)." }),
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
        description: "ID of a not_started agenda created by the primary agent. The subagent will start, execute, and complete it.",
        minimum: 1,
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      currentCwd = resolveCwd(ctx, currentCwd);
      rebuildRegistry(currentCwd);
      widget.setUICtx(ctx.ui);

      const agentConfig = getConfig(params.subagent_type) ?? getConfig("worker")!;
      const fellBack = !getConfig(params.subagent_type);

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
      const fallbackNote    = fellBack ? `Note: Unknown subagent type "${params.subagent_type}" — using worker.\n\n` : "";

      // Resume existing agent
      if (params.resume) {
        const record = manager.getRecord(params.resume);
        if (!record) return textResult(`Agent not found: "${params.resume}". It may have been cleaned up.`);
        if (!record.session) return textResult(`Agent "${params.resume}" has no active session to resume.`);
        const updated = await manager.resume(params.resume, params.prompt);
        if (!updated) return textResult(`Failed to resume agent "${params.resume}".`);
        return textResult(`${fallbackNote}${updated.result?.trim() || updated.error?.trim() || "No output."}`);
      }

      // Background execution
      if (runInBackground) {
        const id = manager.spawn({ ...ctx, cwd: currentCwd }, params.prompt, {
          description:   params.description,
          agentConfig,
          model:         resolvedModel,
          maxTurns,
          isolated,
          inheritContext,
          thinkingLevel: params.thinking as any,
          isBackground:  true,
          agendaId:      params.agenda_id,
        });
        const record   = manager.getRecord(id);
        const isQueued = record?.status === "queued";
        return textResult(
          `${fallbackNote}Agent ${isQueued ? "queued" : "started"} in background.\n` +
          `Agent ID: ${id}\n` +
          `Type: ${agentConfig.name}\n` +
          `Description: ${params.description}\n` +
          (isQueued ? `Status: queued (${manager.getMaxConcurrent()} max concurrent)\n` : "") +
          `\nYou will be notified when this agent completes.\n` +
          `Use get_subagent_result to retrieve results, or steer_subagent to send messages.\n` +
          `Do not duplicate this agent's work.`,
        );
      }

      // Foreground execution
      const record = await manager.spawnAndWait({ ...ctx, cwd: currentCwd }, params.prompt, {
        description:   params.description,
        agentConfig,
        model:         resolvedModel,
        maxTurns,
        isolated,
        inheritContext,
        thinkingLevel: params.thinking as any,
        agendaId:      params.agenda_id,
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

  // =========================================================================
  // Tool: get_subagent_result
  // =========================================================================

  pi.registerTool({
    name: "get_subagent_result",
    label: "Get Agent Result",
    description: "Check status and retrieve results from a background agent. Use the agent ID returned by Subagent with run_in_background.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "The agent ID to check." }),
      wait: Type.Optional(Type.Boolean({ description: "If true, wait for the agent to complete before returning. Default: false." })),
      verbose: Type.Optional(Type.Boolean({ description: "If true, include a preview of the agent's last output text. Default: false." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const record = manager.getRecord(params.agent_id);
      if (!record) return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);

      if (params.wait && (record.status === "running" || record.status === "queued") && record.promise) {
        record.resultConsumed = true;
        await record.promise;
      }

      const duration = record.completedAt
        ? formatMs(record.completedAt - record.startedAt)
        : formatMs(Date.now() - record.startedAt) + " (running)";
      const activity = manager.getActivity(params.agent_id);
      const stats = [
        activity ? `${activity.turnCount} turns` : "",
        `${record.toolUses} tool uses`,
        duration,
      ].filter(Boolean).join(" · ");

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

  // =========================================================================
  // Tool: steer_subagent
  // =========================================================================

  pi.registerTool({
    name: "steer_subagent",
    label: "Steer Agent",
    description: "Send a steering message to a running agent. Only works on running agents.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "The agent ID to steer (must be currently running)." }),
      message: Type.String({ description: "The steering message to send. Appears as a user message in the agent's conversation." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const record = manager.getRecord(params.agent_id);
      if (!record) return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);

      if (record.status === "queued") {
        record.pendingSteers = record.pendingSteers ?? [];
        record.pendingSteers.push(params.message);
        return textResult(`Agent ${record.id} is queued. Message will be delivered when it starts running.`);
      }
      if (record.status !== "running") {
        return textResult(`Agent "${params.agent_id}" is not running (status: ${record.status}).`);
      }

      const ok = await manager.steer(params.agent_id, params.message);
      if (!ok) return textResult(`Failed to steer agent "${params.agent_id}".`);
      return textResult(`Steering message sent to agent ${record.id}. It will be processed after the current tool execution.`);
    },
  });

  // =========================================================================
  // Tool: MultiSubagent
  // =========================================================================

  pi.registerTool({
    name: "MultiSubagent",
    label: "Multi-Subagent",
    description: `Launch multiple independent subagents in one shot and collect all results.

All agents start concurrently. Foreground (default): blocks until every agent finishes, returns aggregated results. Background (run_in_background: true): returns all agent IDs immediately — use get_subagent_result to collect each result later.

Use this instead of calling Subagent repeatedly when tasks are independent and you want them to run in parallel.

Each task in the tasks array accepts the same per-agent options as the Subagent tool (subagent_type, prompt, description, model, thinking, max_turns, isolated, inherit_context, agenda_id).`,
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          subagent_type: Type.String({ description: "Agent type to use for this task." }),
          prompt: Type.String({ description: "The task for this agent to perform." }),
          description: Type.String({ description: "A short (3-5 word) description (shown in UI)." }),
          model: Type.Optional(Type.String({ description: "Model override for this task." })),
          thinking: Type.Optional(Type.String({ description: "Thinking level override: off, minimal, low, medium, high, xhigh." })),
          max_turns: Type.Optional(Type.Number({ description: "Max agentic turns for this task.", minimum: 1 })),
          isolated: Type.Optional(Type.Boolean({ description: "If true, agent gets no extension/MCP tools." })),
          inherit_context: Type.Optional(Type.Boolean({ description: "If true, agent receives parent conversation history." })),
          agenda_id: Type.Optional(Type.Number({ description: "ID of a not_started agenda for this agent to execute.", minimum: 1 })),
        }),
        { minItems: 2, description: "Tasks to run in parallel. Minimum 2 (use Subagent for a single task)." },
      ),
      concurrency: Type.Optional(Type.Integer({
        description: "Max agents running at the same time. Default: all tasks start at once.",
        minimum: 1,
      })),
      run_in_background: Type.Optional(Type.Boolean({
        description: "If true, all agents start in background and agent IDs are returned immediately. Default: false (foreground — blocks until all finish).",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      currentCwd = resolveCwd(ctx, currentCwd);
      rebuildRegistry(currentCwd);
      widget.setUICtx(ctx.ui);

      const tasks = params.tasks as Array<{
        subagent_type: string; prompt: string; description: string;
        model?: string; thinking?: string; max_turns?: number;
        isolated?: boolean; inherit_context?: boolean; agenda_id?: number;
      }>;
      const runInBackground = (params as any).run_in_background ?? false;
      const concurrency     = (params as any).concurrency ?? tasks.length;

      // Resolve per-task agent configs and models up front — fail fast on unknown types
      const resolved = tasks.map((task, i) => {
        const agentConfig = getConfig(task.subagent_type) ?? getConfig("worker")!;
        const fellBack    = !getConfig(task.subagent_type);
        let model = ctx.model;
        if (task.model) {
          const found = resolveModel(task.model, ctx.modelRegistry);
          if (typeof found === "string") return { error: `Task ${i + 1}: ${found}` };
          model = found;
        } else if (agentConfig.model) {
          const found = resolveModel(agentConfig.model, ctx.modelRegistry);
          if (typeof found !== "string") model = found;
        }
        return { task, agentConfig, model, fellBack };
      });

      const firstError = resolved.find((r) => "error" in r);
      if (firstError && "error" in firstError) return textResult(firstError.error);

      // ---- Background mode: spawn all, return IDs immediately ----
      if (runInBackground) {
        const ids = resolved.map((r) => {
          if ("error" in r) return "";
          const { task, agentConfig, model } = r;
          return manager.spawn({ ...ctx, cwd: currentCwd }, task.prompt, {
            description:   task.description,
            agentConfig,
            model,
            maxTurns:      task.max_turns ?? agentConfig.maxTurns ?? getDefaultMaxTurns(),
            isolated:      agentConfig.isolated ?? task.isolated ?? false,
            inheritContext: agentConfig.inheritContext ?? task.inherit_context ?? false,
            thinkingLevel: task.thinking as any,
            isBackground:  true,
            agendaId:      task.agenda_id,
          });
        });

        const lines = ids.map((id, i) => {
          const rec = manager.getRecord(id);
          const t   = tasks[i]!;
          return `Task ${i + 1}: ${t.subagent_type} — "${t.description}"\n` +
            `  Agent ID: ${id}  Status: ${rec?.status ?? "unknown"}` +
            (resolved[i] && "fellBack" in resolved[i]! && resolved[i]!.fellBack
              ? `  (unknown type "${t.subagent_type}" → worker)` : "");
        });

        return textResult(
          `${ids.length} agents started in background.\n\n` +
          lines.join("\n") +
          `\n\nUse get_subagent_result to retrieve each result when ready.`,
        );
      }

      // ---- Foreground mode: run concurrently, aggregate results ----
      const limit   = Math.max(1, Math.min(concurrency, resolved.length));
      const results = new Array(resolved.length) as Array<{ index: number; label: string; output: string }>;
      let   next    = 0;

      async function runWorker(): Promise<void> {
        while (next < resolved.length) {
          const i = next++;
          const r = resolved[i]!;
          if ("error" in r) {
            results[i] = { index: i, label: `Task ${i + 1} (error)`, output: r.error };
            continue;
          }
          const { task, agentConfig, model, fellBack } = r;
          const fallbackNote = fellBack ? `(unknown type "${task.subagent_type}" → worker) ` : "";
          const record = await manager.spawnAndWait({ ...ctx, cwd: currentCwd }, task.prompt, {
            description:   task.description,
            agentConfig,
            model,
            maxTurns:      task.max_turns ?? agentConfig.maxTurns ?? getDefaultMaxTurns(),
            isolated:      agentConfig.isolated ?? task.isolated ?? false,
            inheritContext: agentConfig.inheritContext ?? task.inherit_context ?? false,
            thinkingLevel: task.thinking as any,
            agendaId:      task.agenda_id,
          });
          widget.markFinished(record.id);
          const duration = record.completedAt ? formatMs(record.completedAt - record.startedAt) : "?";
          const label    = `Task ${i + 1} (${task.subagent_type}) — "${task.description}" · ${duration} · ${record.toolUses} tools`;
          const output   = record.status === "error"
            ? `${fallbackNote}ERROR: ${record.error ?? "unknown"}`
            : `${fallbackNote}${record.result?.trim() || "(no output)"}`;
          results[i] = { index: i, label, output };
        }
      }

      await Promise.all(Array.from({ length: limit }, () => runWorker()));

      const sections = results.map((r) =>
        `=== ${r.label} ===\n${r.output}`,
      );

      return textResult(sections.join("\n\n"));
    },
  });

  // =========================================================================
  // Command: /subagents
  // =========================================================================

  async function showAgentsMenu(ctx: any): Promise<void> {
    currentCwd = resolveCwd(ctx, currentCwd);
    rebuildRegistry(currentCwd);

    const records = manager.listRecords();
    const running = records.filter((r) => r.status === "running" || r.status === "queued");
    const allTypes = getAllTypes();

    const options: string[] = [];
    if (records.length > 0) options.push(`Running subagents (${records.length}) — ${running.length} active`);
    if (allTypes.length > 0) options.push(`Subagent types (${allTypes.length})`);
    options.push("Settings");

    const choice = await ctx.ui.select("Subagents", options);
    if (!choice) return;

    if (choice.startsWith("Running subagents"))  await showRunningAgents(ctx);
    else if (choice.startsWith("Subagent types")) await showAgentTypesList(ctx);
    else if (choice === "Settings")              await showSettings(ctx);
  }

  async function showAgentSession(ctx: any, record: any): Promise<void> {
    const isLive = record.status === "running" || record.status === "queued";

    await ctx.ui.custom(
      (tui: any, theme: any, _kb: any, done: (v: any) => void) => {
        const viewer = new SessionViewer(record, () => manager.getActivity(record.id), theme);
        viewer.onClose = () => {
          if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = undefined; }
          done(undefined);
        };
        let refreshTimer: ReturnType<typeof setInterval> | undefined;
        if (isLive) refreshTimer = setInterval(() => tui.requestRender(), 300);
        return {
          render:      (w: number) => viewer.render(w),
          invalidate:  ()          => viewer.invalidate(),
          handleInput: (data: string) => { viewer.handleInput(data); tui.requestRender(); },
        };
      },
      { overlay: true, overlayOptions: { anchor: "center", width: "95%", maxHeight: "95%" } },
    );
  }

  async function showRunningAgents(ctx: any): Promise<void> {
    const records = manager.listRecords();
    if (records.length === 0) { ctx.ui.notify("No subagents.", "info"); return; }

    const options = records.map((r) => {
      const activity = manager.getActivity(r.id);
      const dur      = r.completedAt ? formatMs(r.completedAt - r.startedAt) : formatMs(Date.now() - r.startedAt);
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
      if (ok) { manager.abort(record.id); ctx.ui.notify(`Subagent ${record.id} stopped.`, "info"); }
    }
  }

  async function showAgentTypesList(ctx: any): Promise<void> {
    const allTypes = getAllTypes();
    if (allTypes.length === 0) { ctx.ui.notify("No subagent types defined.", "info"); return; }

    const options = allTypes.map((name) => {
      const cfg = getConfig(name);
      const src = cfg?.source === "project" ? "• " : "◦ ";
      const dis = cfg?.enabled === false ? "✕ " : "";
      const model = cfg?.model ? `  [${modelLabel(cfg.model)}]` : "";
      return `${dis}${src}${name}${model}  —  ${cfg?.description ?? name}`;
    });

    const choice = await ctx.ui.select("Subagent types  (• = project  ◦ = global  ✕ = disabled)", options);
    if (!choice) return;
    const idx = options.indexOf(choice);
    if (idx < 0) return;
    const name = allTypes[idx];
    const cfg  = getConfig(name);
    if (!cfg) return;

    // Show a quick summary and offer to view any running sessions of this type
    const running = manager.listRecords().filter((r) => r.type === name);
    const infoLines = [
      `Name:        ${name}`,
      `Source:      ${cfg.source ?? "unknown"}`,
      `Description: ${cfg.description}`,
      cfg.model    ? `Model:       ${cfg.model}` : null,
      cfg.thinking ? `Thinking:    ${cfg.thinking}` : null,
      cfg.maxTurns ? `Max turns:   ${cfg.maxTurns}` : null,
    ].filter(Boolean).join("\n");

    const menuOpts = running.length > 0
      ? [`Info`, ...running.map((r) => `View session: ${r.id.slice(0, 8)} (${r.status})`)]
      : ["Info"];

    const pick = await ctx.ui.select(name, menuOpts);
    if (!pick || pick === "Info") {
      ctx.ui.notify(infoLines, "info");
      return;
    }
    const sessionIdx = menuOpts.indexOf(pick) - 1;
    if (sessionIdx >= 0 && running[sessionIdx]) {
      await showAgentSession(ctx, running[sessionIdx]);
    }
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
        if (n === 0)     { setDefaultMaxTurns(undefined); ctx.ui.notify("Max turns → unlimited", "info"); }
        else if (n >= 1) { setDefaultMaxTurns(n);         ctx.ui.notify(`Max turns → ${n}`, "info"); }
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
    description: "Manage subagents — list running agents, view sessions, configure",
    handler: async (_args, ctx) => {
      await showAgentsMenu(ctx);
    },
  });

  // =========================================================================
  // Command: /delegate
  // =========================================================================

  pi.registerCommand("delegate", {
    description: "Delegate a task directly to a named subagent. Usage: /delegate <agent> [task]",

    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      if (prefix.includes(" ")) return null;
      rebuildRegistry(currentCwd);
      return getAvailableTypes()
        .filter((name) => name.toLowerCase().startsWith(prefix.toLowerCase()))
        .map((name) => {
          const cfg = getConfig(name);
          return { value: name + " ", label: name, description: cfg?.description };
        });
    },

    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      if (!trimmed) { ctx.ui.notify("Usage: /delegate <agent-name> [task]", "error"); return; }

      const spaceIdx  = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task      = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      currentCwd = resolveCwd(ctx, currentCwd);
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
        ctx.ui.notify(`${agentName} failed: ${record.error?.slice(0, 200) ?? "unknown error"}`, "error");
        return;
      }

      const output   = record.result?.trim() || "(no output)";
      const duration = record.completedAt ? formatMs(record.completedAt - record.startedAt) : "?";
      const stats    = `${agentName} · ${duration} · ${record.toolUses} tool use${record.toolUses !== 1 ? "s" : ""}`;

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

  // =========================================================================
  // Command: /delegate-multi
  // =========================================================================

  pi.registerCommand("delegate-multi", {
    description: "Delegate multiple tasks to agents in parallel. Usage: /delegate-multi agent1:task1; agent2:task2",

    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const lastSemicolon = prefix.lastIndexOf(";");
      const current = lastSemicolon === -1 ? prefix : prefix.slice(lastSemicolon + 1).trimStart();
      if (current.includes(":")) return null;
      rebuildRegistry(currentCwd);
      return getAvailableTypes()
        .filter((name) => name.toLowerCase().startsWith(current.toLowerCase()))
        .map((name) => {
          const cfg = getConfig(name);
          return { value: name + ":", label: name, description: cfg?.description };
        });
    },

    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      if (!trimmed) { ctx.ui.notify("Usage: /delegate-multi agent1:task1; agent2:task2", "error"); return; }

      currentCwd = resolveCwd(ctx, currentCwd);
      rebuildRegistry(currentCwd);
      widget.setUICtx(ctx.ui);

      // Parse semicolon-separated "agent:task" pairs
      const pairs = trimmed.split(";").map((s) => s.trim()).filter(Boolean);
      const tasks: Array<{ agentName: string; task: string }> = [];
      for (let i = 0; i < pairs.length; i++) {
        const colon = pairs[i]!.indexOf(":");
        if (colon === -1) { ctx.ui.notify(`Segment ${i + 1}: missing ":" — expected agent:task`, "error"); return; }
        tasks.push({ agentName: pairs[i]!.slice(0, colon).trim(), task: pairs[i]!.slice(colon + 1).trim() });
      }

      // Resolve agent configs up front — fail fast
      const resolved: Array<{ agentName: string; task: string; agentConfig: any }> = [];
      for (let i = 0; i < tasks.length; i++) {
        const { agentName, task } = tasks[i]!;
        const agentConfig = getConfig(agentName);
        if (!agentConfig) {
          const available = getAvailableTypes().join(", ") || "none";
          ctx.ui.notify(`Unknown agent: "${agentName}". Available: ${available}`, "error");
          return;
        }
        resolved.push({ agentName, task, agentConfig });
      }

      ctx.ui.notify(`Delegating to ${resolved.length} agents in parallel…`, "info");

      const results = new Array(resolved.length) as Array<{ agentName: string; label: string; output: string; status: string }> ;
      await Promise.all(
        resolved.map(async ({ agentName, task, agentConfig }, i) => {
          const description = task.length > 50 ? task.slice(0, 50) + "…" : (task || agentName);
          const record = await manager.spawnAndWait({ ...ctx, cwd: currentCwd }, task, {
            description,
            agentConfig,
          });
          widget.markFinished(record.id);
          const duration = record.completedAt ? formatMs(record.completedAt - record.startedAt) : "?";
          const stats    = `${agentName} · ${duration} · ${record.toolUses} tool use${record.toolUses !== 1 ? "s" : ""}`;
          results[i] = {
            agentName,
            label:  stats,
            output: record.status === "error" ? `ERROR: ${record.error ?? "unknown"}` : record.result?.trim() || "(no output)",
            status: record.status,
          };
        }),
      );

      const content = results
        .map((r) => `[${r.label}]\n\n${r.output}`)
        .join("\n\n---\n\n");

      pi.sendMessage(
        {
          customType: "delegate-multi:result",
          content,
          display: true,
          details: { count: resolved.length },
        },
        { deliverAs: "followUp" },
      );
    },
  });
}
