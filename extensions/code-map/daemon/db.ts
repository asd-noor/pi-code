/**
 * SQLite-backed persistent store for code-map.
 * Replaces all in-memory Maps from CodeGraph.
 * Uses bun:sqlite (zero deps, built-in).
 */

import { Database } from "bun:sqlite";
import type { GraphNode, RefLocation } from "./graph.ts";
import { REF_KINDS } from "./graph.ts";

// ── DiagRow is defined here and re-exported from server.ts ─────────────────

export interface DiagRow {
  severity: string;
  language: string;
  file: string;
  line: number;
  col: number;
  source: string;
  message: string;
}

// ── Schema ────────────────────────────────────────────────────────────────────

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -65536;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS nodes (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  language   TEXT NOT NULL,
  file       TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end   INTEGER NOT NULL,
  col_start  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_file     ON nodes(file);
CREATE INDEX IF NOT EXISTS idx_nodes_language ON nodes(language);
CREATE INDEX IF NOT EXISTS idx_nodes_name     ON nodes(lower(name));

CREATE TABLE IF NOT EXISTS reverse_refs (
  node_id        TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  ref_file       TEXT NOT NULL,
  ref_line_start INTEGER NOT NULL,
  ref_line_end   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refs_node_id ON reverse_refs(node_id);

CREATE TABLE IF NOT EXISTS indexed_nodes (
  node_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS diagnostics (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  file     TEXT NOT NULL,
  language TEXT NOT NULL,
  severity TEXT NOT NULL,
  line     INTEGER NOT NULL,
  col      INTEGER NOT NULL,
  source   TEXT NOT NULL DEFAULT '',
  message  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diag_file     ON diagnostics(file);
CREATE INDEX IF NOT EXISTS idx_diag_language ON diagnostics(language);

CREATE TABLE IF NOT EXISTS file_meta (
  file     TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL
);
`;

// ── Row → GraphNode ───────────────────────────────────────────────────────────

function rowToNode(row: Record<string, unknown>): GraphNode {
  return {
    id:        row.id as string,
    name:      row.name as string,
    kind:      row.kind as string,
    language:  row.language as string,
    file:      row.file as string,
    lineStart: row.line_start as number,
    lineEnd:   row.line_end as number,
    colStart:  row.col_start as number,
  };
}

// ── REF_KINDS SQL fragment (safe: constant set, not user input) ───────────────

const REF_KINDS_SQL = [...REF_KINDS].map((k) => `'${k}'`).join(", ");

// ── CodeMapDB ─────────────────────────────────────────────────────────────────

export class CodeMapDB {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec(SCHEMA);
  }

  // ── Node writes ─────────────────────────────────────────────────────────────

  insertNodes(nodes: GraphNode[]): void {
    if (nodes.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO nodes (id, name, kind, language, file, line_start, line_end, col_start)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const run = this.db.transaction((ns: GraphNode[]) => {
      for (const n of ns) {
        stmt.run(n.id, n.name, n.kind, n.language, n.file, n.lineStart, n.lineEnd, n.colStart);
      }
    });
    run(nodes);
  }

  deleteFile(relFile: string): void {
    const run = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM nodes WHERE file = ?`).run(relFile);
      this.db.prepare(`DELETE FROM diagnostics WHERE file = ?`).run(relFile);
      this.db.prepare(`DELETE FROM file_meta WHERE file = ?`).run(relFile);
    });
    run();
  }

  deleteFiles(relFiles: string[]): void {
    if (relFiles.length === 0) return;
    const delNodes = this.db.prepare(`DELETE FROM nodes WHERE file = ?`);
    const delDiags = this.db.prepare(`DELETE FROM diagnostics WHERE file = ?`);
    const delMeta  = this.db.prepare(`DELETE FROM file_meta WHERE file = ?`);
    const run = this.db.transaction((files: string[]) => {
      for (const f of files) {
        delNodes.run(f);
        delDiags.run(f);
        delMeta.run(f);
      }
    });
    run(relFiles);
  }

  // ── Node reads ──────────────────────────────────────────────────────────────

  /**
   * Tiered name search, all filtered by language:
   *   1. Exact:            lower(name) = lower(?)
   *   2. Dot-suffix:       lower(name) LIKE '%.' || lower(?)
   *   3. Receiver-stripped: GLOB '(**).*' AND LIKE '%.' || lower(?)
   *   4. Substring fallback (only when 1-3 return nothing)
   */
  findByName(name: string, language: string): GraphNode[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT id, name, kind, language, file, line_start, line_end, col_start
      FROM nodes
      WHERE language = ?
        AND (
          lower(name) = lower(?)
          OR lower(name) LIKE '%.' || lower(?)
          OR (lower(name) GLOB '(**).*' AND lower(name) LIKE '%.' || lower(?))
        )
    `).all(language, name, name, name) as Record<string, unknown>[];

    if (rows.length > 0) return rows.map(rowToNode);

    // Tier 4: substring fallback
    const fallback = this.db.prepare(`
      SELECT id, name, kind, language, file, line_start, line_end, col_start
      FROM nodes
      WHERE language = ?
        AND lower(name) LIKE '%' || lower(?) || '%'
    `).all(language, name) as Record<string, unknown>[];

    return fallback.map(rowToNode);
  }

  getByFile(relFile: string): GraphNode[] {
    const rows = this.db.prepare(
      `SELECT id, name, kind, language, file, line_start, line_end, col_start
       FROM nodes WHERE file = ?`,
    ).all(relFile) as Record<string, unknown>[];
    return rows.map(rowToNode);
  }

  /** All nodes of REF_KINDS that have not yet been reverse-indexed. */
  getNodesForReverseRefs(refKinds: Set<string>): GraphNode[] {
    const kinds = [...refKinds].map((k) => `'${k}'`).join(", ");
    const rows = this.db.prepare(`
      SELECT id, name, kind, language, file, line_start, line_end, col_start
      FROM nodes
      WHERE kind IN (${kinds})
        AND id NOT IN (SELECT node_id FROM indexed_nodes)
    `).all() as Record<string, unknown>[];
    return rows.map(rowToNode);
  }

  // ── Reverse refs ────────────────────────────────────────────────────────────

  setReverseRefs(nodeId: string, refs: RefLocation[]): void {
    const insertRef = this.db.prepare(
      `INSERT INTO reverse_refs (node_id, ref_file, ref_line_start, ref_line_end) VALUES (?, ?, ?, ?)`,
    );
    const insertIndexed = this.db.prepare(
      `INSERT OR IGNORE INTO indexed_nodes (node_id) VALUES (?)`,
    );
    const run = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM reverse_refs WHERE node_id = ?`).run(nodeId);
      for (const r of refs) {
        insertRef.run(nodeId, r.file, r.lineStart, r.lineEnd);
      }
      insertIndexed.run(nodeId);
    });
    run();
  }

  getReverseRefs(nodeId: string): RefLocation[] {
    const rows = this.db.prepare(
      `SELECT ref_file, ref_line_start, ref_line_end FROM reverse_refs WHERE node_id = ?`,
    ).all(nodeId) as Record<string, unknown>[];
    return rows.map((r) => ({
      file:      r.ref_file as string,
      lineStart: r.ref_line_start as number,
      lineEnd:   r.ref_line_end as number,
    }));
  }

  isIndexed(nodeId: string): boolean {
    return this.db.prepare(
      `SELECT 1 FROM indexed_nodes WHERE node_id = ?`,
    ).get(nodeId) != null;
  }

  markIndexed(nodeId: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO indexed_nodes (node_id) VALUES (?)`).run(nodeId);
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────────

  setDiagnostics(relFile: string, language: string, diags: DiagRow[]): void {
    const insertDiag = this.db.prepare(
      `INSERT INTO diagnostics (file, language, severity, line, col, source, message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const run = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM diagnostics WHERE file = ?`).run(relFile);
      for (const d of diags) {
        insertDiag.run(d.file, d.language, d.severity, d.line, d.col, d.source, d.message);
      }
    });
    run();
  }

  getDiagnostics(file?: string, language?: string, minSeverity?: number): DiagRow[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (file) {
      conditions.push(`file = ?`);
      params.push(file);
    }
    if (language) {
      conditions.push(`language = ?`);
      params.push(language);
    }
    if (minSeverity && minSeverity > 0) {
      conditions.push(
        `CASE severity WHEN 'error' THEN 1 WHEN 'warning' THEN 2 WHEN 'info' THEN 3 WHEN 'hint' THEN 4 ELSE 99 END <= ?`,
      );
      params.push(minSeverity);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT file, language, severity, line, col, source, message
                 FROM diagnostics ${where} ORDER BY file, line`;

    return this.db.prepare(sql).all(...params) as DiagRow[];
  }

  // ── File metadata ───────────────────────────────────────────────────────────

  getMtime(relFile: string): number | undefined {
    const row = this.db.prepare(
      `SELECT mtime_ms FROM file_meta WHERE file = ?`,
    ).get(relFile) as Record<string, number> | null;
    return row?.mtime_ms;
  }

  setMtime(relFile: string, mtimeMs: number): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO file_meta (file, mtime_ms) VALUES (?, ?)`,
    ).run(relFile, mtimeMs);
  }

  getTrackedFiles(): Set<string> {
    const rows = this.db.prepare(`SELECT file FROM file_meta`).all() as Array<{ file: string }>;
    return new Set(rows.map((r) => r.file));
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  stats(): object {
    const count = (sql: string) =>
      (this.db.prepare(sql).get() as Record<string, number>).c;

    return {
      nodes:             count(`SELECT COUNT(*) AS c FROM nodes`),
      files:             count(`SELECT COUNT(DISTINCT file) AS c FROM nodes`),
      reverseRefsBuilt:  count(`SELECT COUNT(*) AS c FROM indexed_nodes`),
      reverseRefsTotal:  count(`SELECT COUNT(*) AS c FROM nodes WHERE kind IN (${REF_KINDS_SQL})`),
      diagnosticFiles:   count(`SELECT COUNT(DISTINCT file) AS c FROM diagnostics`),
    };
  }

  close(): void {
    this.db.close();
  }
}
