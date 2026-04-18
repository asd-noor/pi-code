import { Type } from "@sinclair/typebox";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { AgendaRow, EvaluationRow, TaskRow } from "./types.ts";

export const DEFAULT_PROJECT = ".";

export type DbHandle = { db: DatabaseSync; dbPath: string; project: string };

export function nowIso(): string {
  return new Date().toISOString();
}

export function ensureState(value: string, allowed: readonly string[], label: string): void {
  if (!allowed.includes(value)) throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
}

function encodeProject(projectDir: string): string {
  return projectDir.replace(/[:\\/]+/g, "=");
}

function resolveProjectDir(project: string | undefined, cwd: string): string {
  return resolve(cwd, project?.trim() || DEFAULT_PROJECT);
}

function getDbPath(project: string | undefined, cwd: string): string {
  const projectDir = resolveProjectDir(project, cwd);
  return join(homedir(), ".pi", "cache", encodeProject(projectDir), "agenda.sqlite");
}

export function openDb(project: string | undefined, cwd: string): DbHandle {
  const dbPath = getDbPath(project, cwd);
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS agendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      acceptance_guard TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('not_started', 'in_progress', 'paused', 'completed')),
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agenda_id INTEGER NOT NULL REFERENCES agendas(id) ON DELETE CASCADE,
      task_order INTEGER NOT NULL,
      note TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('not_started', 'in_progress', 'completed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agenda_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agenda_id INTEGER NOT NULL REFERENCES agendas(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      evaluation_summary TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail')),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_agenda_order ON tasks(agenda_id, task_order);
    CREATE INDEX IF NOT EXISTS idx_eval_agenda_latest ON agenda_evaluations(agenda_id, id DESC);
  `);

  return { db, dbPath, project: project?.trim() || DEFAULT_PROJECT };
}

export function runTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw error;
  }
}

export function toPositiveInt(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} must be a positive integer`);
  return n;
}

export function normalizeNotes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const note = raw.trim();
    if (!note) continue;
    out.push(note);
  }
  return out;
}

export function getAgenda(db: DatabaseSync, agendaId: number): AgendaRow {
  const row = db
    .prepare(
      `SELECT id, title, description, acceptance_guard, state, revision, created_at, updated_at
       FROM agendas WHERE id = ?`,
    )
    .get(agendaId) as AgendaRow | undefined;
  if (!row) throw new Error(`Agenda not found: ${agendaId}`);
  return row;
}

export function getTasks(db: DatabaseSync, agendaId: number): TaskRow[] {
  return db
    .prepare(
      `SELECT id, agenda_id, task_order, note, state, created_at, updated_at
       FROM tasks WHERE agenda_id = ? ORDER BY task_order ASC, id ASC`,
    )
    .all(agendaId) as TaskRow[];
}

export function getLatestEvaluation(db: DatabaseSync, agendaId: number): EvaluationRow | null {
  const row = db
    .prepare(
      `SELECT id, agenda_id, revision, evaluation_summary, evidence_json, verdict, created_at
       FROM agenda_evaluations WHERE agenda_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(agendaId) as EvaluationRow | undefined;
  return row ?? null;
}

export function requireAgendaInProgress(agenda: AgendaRow): void {
  if (agenda.state !== "in_progress") {
    throw new Error(`Task state can be changed only when agenda is in_progress. Current state: ${agenda.state}`);
  }
}

export function bumpAgendaRevision(db: DatabaseSync, agendaId: number): void {
  db.prepare(`UPDATE agendas SET revision = revision + 1, updated_at = ? WHERE id = ?`).run(nowIso(), agendaId);
}

export function findTaskByOrder(db: DatabaseSync, agendaId: number, taskNumber: number): TaskRow {
  const task = db
    .prepare(
      `SELECT id, agenda_id, task_order, note, state, created_at, updated_at
       FROM tasks WHERE agenda_id = ? AND task_order = ?`,
    )
    .get(agendaId, taskNumber) as TaskRow | undefined;

  if (!task) throw new Error(`Task not found: agenda ${agendaId}, task ${taskNumber}`);
  return task;
}

export function projectParam() {
  return Type.Optional(Type.String({ description: `Project directory (default: ${DEFAULT_PROJECT}).` }));
}
