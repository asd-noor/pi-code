import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { openAgendaBrowserInteractive } from "./browser.ts";
import { openDb } from "./db.ts";
import { AGENDA_TOOL_NAMES, registerAgendaTools } from "./tools.ts";
import { refreshAgendaWidget } from "./widget.ts";

export default function (pi: ExtensionAPI) {
  const AGENDA_INSTRUCTION = `
## Agenda discipline

Use agenda tools for any work with 2 or more implementation steps.
Create the plan before starting. Track progress. Do not free-style multi-step work without a visible agenda.

### State machine

Agenda: \`not_started\` → \`in_progress\` ⇔ \`paused\` → \`completed\` (terminal)
Task:   \`not_started\` → \`in_progress\` → \`completed\` (reopen: \`completed\` → \`in_progress\`)

Task state can only change while the parent agenda is \`in_progress\`.

### Workflow

1. \`agenda_create\` — title, description, acceptanceGuard, initial task notes
2. \`agenda_start\` — move to in_progress
3. \`agenda_task_start\` / \`agenda_task_done\` / \`agenda_task_reopen\` — track task progress
4. \`agenda_pause\` / \`agenda_resume\` — as needed
5. \`agenda_evaluate\` — summary + evidence + verdict (pass/fail) against the acceptance guard
6. \`agenda_complete\` — requires in_progress, ≥1 task, latest evaluation verdict=pass at current revision

### Completion rules

- \`agenda_complete\` is blocked unless the latest \`agenda_evaluate\` verdict is \`pass\` and matches the current revision.
- Re-evaluate after any agenda update (revision bump) — stale evaluations are rejected.
- An agenda may complete with unfinished tasks if the acceptance guard passes.
`.trim();

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: event.systemPrompt + "\n\n" + AGENDA_INSTRUCTION,
  }));

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
