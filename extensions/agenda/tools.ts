import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { DatabaseSync } from "node:sqlite";
import { AGENDA_STATES, type AgendaRow, type ToolResult } from "./types.ts";
import {
  bumpAgendaRevision,
  ensureState,
  findTaskByOrder,
  getAgenda,
  getLatestEvaluation,
  getTasks,
  normalizeNotes,
  nowIso,
  openDb,
  projectParam,
  requireAgendaInProgress,
  runTx,
  toPositiveInt,
} from "./db.ts";
import { formatAgenda, formatList } from "./format.ts";

export const AGENDA_TOOL_NAMES = new Set([
  "agenda_create",
  "agenda_list",
  "agenda_get",
  "agenda_update",
  "agenda_start",
  "agenda_pause",
  "agenda_resume",
  "agenda_task_start",
  "agenda_task_done",
  "agenda_task_reopen",
  "agenda_evaluate",
  "agenda_complete",
  "agenda_search",
  "agenda_delete",
]);

function ok(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text }], details };
}

function registerAgendaTool(
  pi: ExtensionAPI,
  config: {
    name: string;
    label: string;
    description: string;
    parameters: any;
    execute: (db: DatabaseSync, params: Record<string, unknown>) => ToolResult;
  },
): void {
  pi.registerTool({
    name: config.name,
    label: config.label,
    description: config.description,
    parameters: config.parameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const handle = openDb(typeof params.project === "string" ? params.project : undefined, ctx.cwd);
      try {
        const result = config.execute(handle.db, params as Record<string, unknown>);
        return {
          ...result,
          details: {
            ...result.details,
            project: handle.project,
            dbPath: handle.dbPath,
            operation: config.name,
          },
        };
      } finally {
        handle.db.close();
      }
    },
  });
}

export function registerAgendaTools(pi: ExtensionAPI): void {
  registerAgendaTool(pi, {
    name: "agenda_create",
    label: "Agenda Create",
    description: "Create an agenda with one agenda-level acceptance guard and optional short task notes.",
    parameters: Type.Object({
      project: projectParam(),
      title: Type.String({ description: "Agenda title." }),
      description: Type.String({ description: "Agenda description." }),
      acceptanceGuard: Type.String({ description: "Agenda-level acceptance guard for terminal completion." }),
      tasks: Type.Optional(Type.Array(Type.String({ description: "Short task note." }))),
    }),
    execute(db, params) {
      const title       = String(params.title ?? "").trim();
      const description = String(params.description ?? "").trim();
      const guard       = String(params.acceptanceGuard ?? "").trim();
      if (!title) throw new Error("Title is required");
      if (!guard) throw new Error("acceptanceGuard is required");

      const notes = normalizeNotes(params.tasks);
      const now   = nowIso();

      const agendaId = runTx(db, () => {
        const info = db
          .prepare(
            `INSERT INTO agendas (title, description, acceptance_guard, state, revision, created_at, updated_at)
             VALUES (?, ?, ?, 'not_started', 0, ?, ?)`,
          )
          .run(title, description, guard, now, now);

        const id = Number(info.lastInsertRowid);
        if (notes.length > 0) {
          const stmt = db.prepare(
            `INSERT INTO tasks (agenda_id, task_order, note, state, created_at, updated_at)
             VALUES (?, ?, ?, 'not_started', ?, ?)`,
          );
          let order = 1;
          for (const note of notes) {
            stmt.run(id, order, note, now, now);
            order += 1;
          }
        }

        return id;
      });

      return ok(`created agenda id=${agendaId}`, { agendaId, taskCount: notes.length });
    },
  });

  registerAgendaTool(pi, {
    name: "agenda_list",
    label: "Agenda List",
    description: "List agendas (by default excludes completed unless all=true).",
    parameters: Type.Object({
      project: projectParam(),
      all: Type.Optional(Type.Boolean({ description: "Include completed agendas." })),
    }),
    execute(db, params) {
      const all  = Boolean(params.all);
      const rows = db
        .prepare(
          `SELECT id, title, description, acceptance_guard, state, revision, created_at, updated_at
           FROM agendas
           ${all ? "" : "WHERE state <> 'completed'"}
           ORDER BY id DESC`,
        )
        .all() as AgendaRow[];
      return ok(formatList(rows), { count: rows.length, rows });
    },
  });

  registerAgendaTool(pi, {
    name: "agenda_get",
    label: "Agenda Get",
    description: "Get one agenda with tasks and latest evaluation.",
    parameters: Type.Object({
      project: projectParam(),
      id: Type.Integer({ minimum: 1, description: "Agenda ID." }),
    }),
    execute(db, params) {
      const id        = toPositiveInt(params.id, "Agenda ID");
      const agenda    = getAgenda(db, id);
      const tasks     = getTasks(db, id);
      const latestEval = getLatestEvaluation(db, id);
      return ok(formatAgenda(agenda, tasks, latestEval), { agenda, tasks, latestEvaluation: latestEval });
    },
  });

  registerAgendaTool(pi, {
    name: "agenda_update",
    label: "Agenda Update",
    description: "Update agenda metadata and/or append task notes. Agenda must not be completed.",
    parameters: Type.Object({
      project: projectParam(),
      id: Type.Integer({ minimum: 1, description: "Agenda ID." }),
      title: Type.Optional(Type.String({ description: "New title." })),
      description: Type.Optional(Type.String({ description: "New description." })),
      acceptanceGuard: Type.Optional(Type.String({ description: "New agenda-level acceptance guard." })),
      appendTasks: Type.Optional(Type.Array(Type.String({ description: "Task notes to append." }))),
    }),
    execute(db, params) {
      const id              = toPositiveInt(params.id, "Agenda ID");
      const title           = typeof params.title === "string" ? params.title.trim() : undefined;
      const description     = typeof params.description === "string" ? params.description.trim() : undefined;
      const acceptanceGuard = typeof params.acceptanceGuard === "string" ? params.acceptanceGuard.trim() : undefined;
      const appendTasks     = normalizeNotes(params.appendTasks);

      if (title === undefined && description === undefined && acceptanceGuard === undefined && appendTasks.length === 0) {
        throw new Error("Nothing to update");
      }

      const agenda = getAgenda(db, id);
      if (agenda.state === "completed") throw new Error("Completed agendas are immutable");

      runTx(db, () => {
        const sets: string[]    = [];
        const values: unknown[] = [];

        if (title !== undefined) {
          if (!title) throw new Error("Title cannot be empty");
          sets.push("title = ?"); values.push(title);
        }
        if (description !== undefined) {
          sets.push("description = ?"); values.push(description);
        }
        if (acceptanceGuard !== undefined) {
          if (!acceptanceGuard) throw new Error("acceptanceGuard cannot be empty");
          sets.push("acceptance_guard = ?"); values.push(acceptanceGuard);
        }

        if (sets.length > 0) {
          sets.push("updated_at = ?"); values.push(nowIso());
          db.prepare(`UPDATE agendas SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
          bumpAgendaRevision(db, id);
        }

        if (appendTasks.length > 0) {
          const nextOrderRow = db
            .prepare(`SELECT COALESCE(MAX(task_order), 0) AS max_order FROM tasks WHERE agenda_id = ?`)
            .get(id) as { max_order?: number };
          let nextOrder = Number(nextOrderRow.max_order || 0) + 1;
          const stmt    = db.prepare(
            `INSERT INTO tasks (agenda_id, task_order, note, state, created_at, updated_at)
             VALUES (?, ?, ?, 'not_started', ?, ?)`,
          );
          const ts = nowIso();
          for (const note of appendTasks) {
            stmt.run(id, nextOrder, note, ts, ts);
            nextOrder += 1;
          }
          bumpAgendaRevision(db, id);
        }
      });

      return ok(`updated agenda id=${id}`, {
        agendaId: id,
        titleChanged: title !== undefined,
        descriptionChanged: description !== undefined,
        acceptanceGuardChanged: acceptanceGuard !== undefined,
        appendedTasks: appendTasks.length,
      });
    },
  });

  registerAgendaTool(pi, {
    name: "agenda_start",
    label: "Agenda Start",
    description: "Move agenda to in_progress (strict transition: not_started -> in_progress).",
    parameters: Type.Object({
      project: projectParam(),
      agendaId: Type.Integer({ minimum: 1, description: "Agenda ID." }),
    }),
    execute(db, params) {
      const agendaId = toPositiveInt(params.agendaId, "Agenda ID");
      const agenda   = getAgenda(db, agendaId);
      ensureState(agenda.state, AGENDA_STATES, "Agenda state");

      if (agenda.state !== "not_started") {
        throw new Error(`Invalid agenda transition: ${agenda.state} -> in_progress. Expected: not_started -> in_progress.`);
      }

      db.prepare(`UPDATE agendas SET state = 'in_progress', updated_at = ? WHERE id = ?`).run(nowIso(), agendaId);
      return ok(`agenda ${agendaId} marked as in_progress`, { agendaId, previousState: agenda.state, state: "in_progress" });
    },
  });

  registerAgendaTool(pi, {
    name: "agenda_pause",
    label: "Agenda Pause",
    description: "Pause an in_progress agenda (strict transition: in_progress -> paused).",
    parameters: Type.Object({
      project: projectParam(),
      agendaId: Type.Integer({ minimum: 1, description: "Agenda ID." }),
    }),
    execute(db, params) {
      const agendaId = toPositiveInt(params.agendaId, "Agenda ID");
      const agenda   = getAgenda(db, agendaId);
      ensureState(agenda.state, AGENDA_STATES, "Agenda state");

      if (agenda.state !== "in_progress") {
        throw new Error(`Invalid agenda transition: ${agenda.state} -> paused. Expected: in_progress -> paused.`);
      }

      db.prepare(`UPDATE agendas SET state = 'paused', updated_at = ? WHERE id = ?`).run(nowIso(), agendaId);
      return ok(`agenda ${agendaId} marked as paused`, { agendaId, previousState: agenda.state, state: "paused" });
    },
  });

  registerAgendaTool(pi, {
    name: "agenda_resume",
    label: "Agenda Resume",
    description: "Resume a paused agenda (strict transition: paused -> in_progress).",
    parameters: Type.Object({
      project: projectParam(),
      agendaId: Type.Integer({ minimum: 1, description: "Agenda ID." }),
    }),
    execute(db, params) {
      const agendaId = toPositiveInt(params.agendaId, "Agenda ID");
      const agenda   = getAgenda(db, agendaId);
      ensureState(agenda.state, AGENDA_STATES, "Agenda state");

      if (agenda.state !== "paused") {
        throw new Error(`Invalid agenda transition: ${agenda.state} -> in_progress (resume). Expected: paused -> in_progress.`);
      }

      db.prepare(`UPDATE agendas SET state = 'in_progress', updated_at = ? WHERE id = ?`).run(nowIso(), agendaId);
      return ok(`agenda ${agendaId} resumed to in_progress`, { agendaId, previousState: agenda.state, state: "in_progress" });
    },
  });

  registerAgendaTool(pi, {
    name: "agenda_task_start",
    label: "Agenda Task Start",
    description: "Mark a task as in_progress. Parent agenda must be in_progress.",
    parameters: Type.Object({
      project: projectParam(),
      agendaId: Type.Integer({ minimum: 1, description: "Agenda ID." }),
      taskNumber: Type.Integer({ minimum: 1, description: "Task number (1-based)." }),
    }),
    execute(db, params) {
      const agendaId   = toPositiveInt(params.agendaId, "Agenda ID");
      const taskNumber = toPositiveInt(params.taskNumber, "Task number");

      const agenda = getAgenda(db, agendaId);
      requireAgendaInProgress(agenda);
      const task = findTaskByOrder(db, agendaId, taskNumber);

      if (task.state !== "not_started") {
        throw new Error(
          `Invalid transition for task ${taskNumber}: ${task.state} -> in_progress. Expected path: not_started -> in_progress -> completed, reopen: completed -> in_progress.`,
        );
      }

      runTx(db, () => {
        db.prepare(`UPDATE tasks SET state = 'in_progress', updated_at = ? WHERE id = ?`).run(nowIso(), task.id);
        bumpAgendaRevision(db, agendaId);
      });

      return ok(`agenda ${agendaId}: task ${taskNumber} marked as in_progress`, {
        agendaId, taskNumber, previousState: task.state, state: "in_progress",
      });
    },
  });

  registerAgendaTool(pi, {
    name: "agenda_task_done",
    label: "Agenda Task Done",
    description: "Mark a task as completed. Parent agenda must be in_progress.",
    parameters: Type.Object({
      project: projectParam(),
      agendaId: Type.Integer({ minimum: 1, description: "Agenda ID." }),
      taskNumber: Type.Integer({ minimum: 1, description: "Task number (1-based)." }),
    }),
    execute(db, params) {
      const agendaId   = toPositiveInt(params.agendaId, "Agenda ID");
      const taskNumber = toPositiveInt(params.taskNumber, "Task number");

      const agenda = getAgenda(db, agendaId);
      requireAgendaInProgress(agenda);
      const task = findTaskByOrder(db, agendaId, taskNumber);

      if (task.state !== "in_progress") {
        throw new Error(
          `Invalid transition for task ${taskNumber}: ${task.state} -> completed. Expected path: not_started -> in_progress -> completed, reopen: completed -> in_progress.`,
        );
      }

      runTx(db, () => {
        db.prepare(`UPDATE tasks SET state = 'completed', updated_at = ? WHERE id = ?`).run(nowIso(), task.id);
        bumpAgendaRevision(db, agendaId);
      });

      return ok(`agenda ${agendaId}: task ${taskNumber} marked as completed`, {
        agendaId, taskNumber, previousState: task.state, state: "completed",
      });
    },
  });

  registerAgendaTool(pi, {
    name: "agenda_task_reopen",
    label: "Agenda Task Reopen",
    description: "Reopen a completed task back to in_progress. Parent agenda must be in_progress.",
    parameters: Type.Object({
      project: projectParam(),
      agendaId: Type.Integer({ minimum: 1, description: "Agenda ID." }),
      taskNumber: Type.Integer({ minimum: 1, description: "Task number (1-based)." }),
    }),
    execute(db, params) {
      const agendaId   = toPositiveInt(params.agendaId, "Agenda ID");
      const taskNumber = toPositiveInt(params.taskNumber, "Task number");

      const agenda = getAgenda(db, agendaId);
      requireAgendaInProgress(agenda);
      const task = findTaskByOrder(db, agendaId, taskNumber);

      if (task.state !== "completed") {
        throw new Error(
          `Invalid transition for task ${taskNumber}: ${task.state} -> in_progress (reopen). Expected path: not_started -> in_progress -> completed, reopen: completed -> in_progress.`,
        );
      }

      runTx(db, () => {
        db.prepare(`UPDATE tasks SET state = 'in_progress', updated_at = ? WHERE id = ?`).run(nowIso(), task.id);
        bumpAgendaRevision(db, agendaId);
      });

      return ok(`agenda ${agendaId}: task ${taskNumber} reopened to in_progress`, {
        agendaId, taskNumber, previousState: task.state, state: "in_progress",
      });
    },
  });

  registerAgendaTool(pi, {
    name: "agenda_evaluate",
    label: "Agenda Evaluate",
    description:
      "Record agenda-level acceptance-guard evaluation (Ralph-loop). agenda_complete requires latest verdict=pass at current revision.",
    parameters: Type.Object({
      project: projectParam(),
      agendaId: Type.Integer({ minimum: 1, description: "Agenda ID." }),
      evaluationSummary: Type.String({ description: "Natural-language evaluation summary." }),
      evidence: Type.Optional(Type.Array(Type.String({ description: "Evidence item." }))),
      verdict: Type.String({ description: "pass or fail" }),
    }),
    execute(db, params) {
      const agendaId = toPositiveInt(params.agendaId, "Agenda ID");
      const summary  = String(params.evaluationSummary ?? "").trim();
      const verdict  = String(params.verdict ?? "").trim();
      const evidence = normalizeNotes(params.evidence);

      if (!summary) throw new Error("evaluationSummary is required");
      if (verdict !== "pass" && verdict !== "fail") throw new Error("verdict must be 'pass' or 'fail'");

      const agenda = getAgenda(db, agendaId);
      if (agenda.state !== "in_progress") {
        throw new Error(`Agenda must be in_progress to evaluate. Current state: ${agenda.state}`);
      }

      const ts   = nowIso();
      const info = db
        .prepare(
          `INSERT INTO agenda_evaluations (agenda_id, revision, evaluation_summary, evidence_json, verdict, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(agendaId, agenda.revision, summary, JSON.stringify(evidence), verdict, ts);

      return ok(`agenda ${agendaId}: evaluation recorded (${verdict})`, {
        agendaId, evaluationId: Number(info.lastInsertRowid), revision: agenda.revision, verdict,
      });
    },
  });

  registerAgendaTool(pi, {
    name: "agenda_complete",
    label: "Agenda Complete",
    description:
      "Set agenda to completed. Requires state=in_progress, at least one task, and latest agenda_evaluate verdict=pass on current revision.",
    parameters: Type.Object({
      project: projectParam(),
      agendaId: Type.Integer({ minimum: 1, description: "Agenda ID." }),
    }),
    execute(db, params) {
      const agendaId = toPositiveInt(params.agendaId, "Agenda ID");
      const agenda   = getAgenda(db, agendaId);

      if (agenda.state === "completed") throw new Error("Agenda is already completed");
      if (agenda.state !== "in_progress") {
        throw new Error(`Agenda must be in_progress to complete. Current state: ${agenda.state}`);
      }

      const tasksCountRow  = db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE agenda_id = ?`).get(agendaId) as { count?: number };
      const tasksCount     = Number(tasksCountRow.count || 0);
      if (tasksCount < 1) throw new Error("Agenda cannot be completed without at least one task");

      const latest = getLatestEvaluation(db, agendaId);
      if (!latest) throw new Error("Agenda requires evaluation before completion. Run agenda_evaluate first.");
      if (latest.verdict !== "pass") throw new Error(`Latest evaluation verdict is '${latest.verdict}'. Completion requires 'pass'.`);
      if (latest.revision !== agenda.revision) {
        throw new Error(
          `Latest evaluation is stale (evaluated at revision ${latest.revision}, current revision ${agenda.revision}). Re-run agenda_evaluate.`,
        );
      }

      const pendingRow        = db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE agenda_id = ? AND state <> 'completed'`).get(agendaId) as { count?: number };
      const unfinishedTaskCount = Number(pendingRow.count || 0);

      db.prepare(`UPDATE agendas SET state = 'completed', updated_at = ? WHERE id = ?`).run(nowIso(), agendaId);

      return ok(`agenda ${agendaId} marked as completed`, {
        agendaId, state: "completed", unfinishedTaskCount,
        note: "Agenda may be completed with unfinished tasks when acceptance guard passes.",
      });
    },
  });

  registerAgendaTool(pi, {
    name: "agenda_search",
    label: "Agenda Search",
    description: "Search agendas by title/description/acceptance guard.",
    parameters: Type.Object({
      project: projectParam(),
      query: Type.String({ description: "Search term." }),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Max rows (default: 10)." })),
    }),
    execute(db, params) {
      const query = String(params.query ?? "").trim();
      if (!query) throw new Error("query is required");
      const limit = params.limit === undefined ? 10 : toPositiveInt(params.limit, "limit");
      const like  = `%${query.replace(/[%_]/g, "\\$&")}%`;

      const rows = db
        .prepare(
          `SELECT id, title, description, acceptance_guard, state, revision, created_at, updated_at
           FROM agendas
           WHERE title LIKE ? ESCAPE '\\'
              OR description LIKE ? ESCAPE '\\'
              OR acceptance_guard LIKE ? ESCAPE '\\'
           ORDER BY id DESC
           LIMIT ?`,
        )
        .all(like, like, like, limit) as AgendaRow[];

      return ok(formatList(rows), { count: rows.length, rows });
    },
  });

  registerAgendaTool(pi, {
    name: "agenda_delete",
    label: "Agenda Delete",
    description: "Delete agenda and all tasks/evaluations. Disallowed while in_progress.",
    parameters: Type.Object({
      project: projectParam(),
      agendaId: Type.Integer({ minimum: 1, description: "Agenda ID." }),
    }),
    execute(db, params) {
      const agendaId = toPositiveInt(params.agendaId, "Agenda ID");
      const agenda   = getAgenda(db, agendaId);
      if (agenda.state === "in_progress") {
        throw new Error("Cannot delete an in_progress agenda. Complete or keep it first.");
      }

      db.prepare(`DELETE FROM agendas WHERE id = ?`).run(agendaId);
      return ok(`deleted agenda id=${agendaId}`, { agendaId, previousState: agenda.state });
    },
  });
}
