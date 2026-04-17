import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { openAgendaBrowserInteractive } from "./browser.ts";
import { openDb } from "./db.ts";
import { AGENDA_INSTRUCTION } from "./instruction.ts";
import { AGENDA_TOOL_NAMES, registerAgendaTools } from "./tools.ts";
import { refreshAgendaWidget } from "./widget.ts";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    // Subagent sessions always contain <sub_agent_context> in their base system prompt.
    // They receive a targeted agenda instruction via buildSubagentAgendaInstruction() instead.
    if (event.systemPrompt.includes("<sub_agent_context>")) return {};
    return { systemPrompt: event.systemPrompt + "\n\n" + AGENDA_INSTRUCTION };
  });

  registerAgendaTools(pi);

  let focusedAgendaId: number | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  let lastInProgressCount = -1;
  let lastRevision        = -1;
  let pollCwd: string | undefined;
  let pollUi:  any;
  let isInteractive       = false;

  function pollState(cwd: string): { count: number; revision: number } {
    const handle = openDb(undefined, cwd);
    try {
      const countRow = handle.db
        .prepare(`SELECT COUNT(*) AS count FROM agendas WHERE state = 'in_progress'`)
        .get() as { count?: number };
      const count = Number(countRow.count || 0);

      const agendaRow = focusedAgendaId != null
        ? handle.db
            .prepare(`SELECT revision FROM agendas WHERE id = ? AND state = 'in_progress'`)
            .get(focusedAgendaId) as { revision?: number } | undefined
        : handle.db
            .prepare(`SELECT revision FROM agendas WHERE state = 'in_progress' ORDER BY updated_at DESC, id DESC LIMIT 1`)
            .get() as { revision?: number } | undefined;

      return { count, revision: Number(agendaRow?.revision ?? -1) };
    } finally {
      handle.db.close();
    }
  }

  function startPoller(): void {
    if (poller) return;
    poller = setInterval(() => {
      if (!pollCwd || !pollUi) return;
      try {
        const { count, revision } = pollState(pollCwd);
        if (count !== lastInProgressCount || revision !== lastRevision) {
          lastInProgressCount = count;
          lastRevision        = revision;
          refresh(pollCwd, pollUi);
        }
      } catch { /* db not ready or session shutting down */ }
    }, 2000);
  }

  function stopPoller(): void {
    if (!poller) return;
    clearInterval(poller);
    poller = undefined;
  }

  function refreshFooter(cwd: string, ui: any): void {
    const handle = openDb(undefined, cwd);
    try {
      const row = handle.db
        .prepare(`SELECT COUNT(*) AS count FROM agendas WHERE state = 'in_progress'`)
        .get() as { count?: number };
      const count = Number(row.count || 0);
      ui.setStatus(
        "agenda",
        count > 0 ? `❆ ${count} in progress   ` : undefined,
      );
    } finally {
      handle.db.close();
    }
  }

  function refresh(cwd: string, ui: any): void {
    refreshFooter(cwd, ui);
    refreshAgendaWidget({ cwd, ui } as any, focusedAgendaId);
  }

  pi.registerCommand("agenda-browser", {
    description: "Open interactive agenda browser. Enter focuses the selected in-progress agenda in the widget.",
    handler: async (_args, ctx) => {
      const selected = await openAgendaBrowserInteractive(ctx);
      if (selected != null) focusedAgendaId = selected;
      refresh(ctx.cwd, ctx.ui);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    isInteractive       = true;
    pollCwd = ctx.cwd;
    pollUi  = ctx.ui;
    lastInProgressCount = -1;
    lastRevision        = -1;
    refresh(ctx.cwd, ctx.ui);
    startPoller();
  });

  pi.on("session_shutdown", async () => {
    if (!isInteractive) return;
    isInteractive = false;
    stopPoller();
    pollCwd = undefined;
    pollUi  = undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (AGENDA_TOOL_NAMES.has(event.toolName)) {
      refresh(ctx.cwd, ctx.ui);
      const { count, revision } = pollState(ctx.cwd);
      lastInProgressCount = count;
      lastRevision        = revision;
    }
  });
}
