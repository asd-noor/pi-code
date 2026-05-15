import { createRequire } from "node:module";

// better-sqlite3 and sqlite-vec are CJS packages that use the `bindings`
// helper internally. When loaded as ESM (via jiti), `bindings` loses its
// __dirname context and searches from the wrong directory. Loading them
// through createRequire preserves the CJS module resolution.
const _require = createRequire(import.meta.url);
const Database  = _require("better-sqlite3") as typeof import("better-sqlite3");
const sqliteVec = _require("sqlite-vec") as typeof import("sqlite-vec");

export interface SectionRow {
  id: number;
  fileName: string;
  path: string;
  heading: string;
  level: number;
  content: string;
  position: number;
  headingLine: number;
  bodyStartLine: number;
  bodyEndLine: number;
  sectionEndLine: number;
}

export interface FileRow {
  fileName: string;
  mtimeMs: number;
  title: string;
  description: string;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS files (
  file_name   TEXT PRIMARY KEY,
  mtime_ms    INTEGER NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sections (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name         TEXT    NOT NULL REFERENCES files(file_name) ON DELETE CASCADE,
  path              TEXT    NOT NULL UNIQUE,
  heading           TEXT    NOT NULL,
  level             INTEGER NOT NULL,
  content           TEXT    NOT NULL,
  position          INTEGER NOT NULL,
  heading_line      INTEGER NOT NULL DEFAULT 0,
  body_start_line   INTEGER NOT NULL DEFAULT 0,
  body_end_line     INTEGER NOT NULL DEFAULT 0,
  section_end_line  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sections_file ON sections(file_name);
CREATE INDEX IF NOT EXISTS idx_sections_path ON sections(path);

-- FTS5 content table
CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(
  path, heading, content,
  content=sections,
  content_rowid=id,
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS sections_ai AFTER INSERT ON sections BEGIN
  INSERT INTO sections_fts(rowid, path, heading, content)
  VALUES (new.id, new.path, new.heading, new.content);
END;
CREATE TRIGGER IF NOT EXISTS sections_ad AFTER DELETE ON sections BEGIN
  INSERT INTO sections_fts(sections_fts, rowid, path, heading, content)
  VALUES ('delete', old.id, old.path, old.heading, old.content);
END;
CREATE TRIGGER IF NOT EXISTS sections_au AFTER UPDATE ON sections BEGIN
  INSERT INTO sections_fts(sections_fts, rowid, path, heading, content)
  VALUES ('delete', old.id, old.path, old.heading, old.content);
  INSERT INTO sections_fts(rowid, path, heading, content)
  VALUES (new.id, new.path, new.heading, new.content);
END;

-- vec0 virtual table for 384-dim embeddings
CREATE VIRTUAL TABLE IF NOT EXISTS sections_vec USING vec0(
  embedding float[384]
);
`;

export class MemoryDB {
  private db: ReturnType<typeof Database>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    sqliteVec.load(this.db);
    this.db.exec(SCHEMA);
  }

  // ── File metadata ──────────────────────────────────────────────────────

  getFile(fileName: string): FileRow | undefined {
    return this.db
      .prepare("SELECT file_name AS fileName, mtime_ms AS mtimeMs, title, description FROM files WHERE file_name = ?")
      .get(fileName) as FileRow | undefined;
  }

  upsertFile(row: FileRow): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO files (file_name, mtime_ms, title, description)
                VALUES (@fileName, @mtimeMs, @title, @description)`)
      .run(row);
  }

  deleteFile(fileName: string): void {
    const ids = (this.db
      .prepare("SELECT id FROM sections WHERE file_name = ?")
      .all(fileName) as Array<{ id: number }>)
      .map((r) => r.id);

    this.db.transaction(() => {
      for (const id of ids) {
        this.db.prepare("DELETE FROM sections_vec WHERE rowid = ?").run(id);
      }
      this.db.prepare("DELETE FROM files WHERE file_name = ?").run(fileName);
    })();
  }

  listFiles(): string[] {
    return (this.db.prepare("SELECT file_name FROM files ORDER BY file_name").all() as Array<{ file_name: string }>)
      .map((r) => r.file_name);
  }

  getMtime(fileName: string): number | undefined {
    const row = this.db
      .prepare("SELECT mtime_ms FROM files WHERE file_name = ?")
      .get(fileName) as { mtime_ms: number } | undefined;
    return row?.mtime_ms;
  }

  // ── Section writes ────────────────────────────────────────────────────

  replaceFileSections(
    fileName: string,
    sections: Omit<SectionRow, "id" | "fileName">[],
    embeddings: Float32Array[],
  ): void {
    const existingIds = (this.db
      .prepare("SELECT id FROM sections WHERE file_name = ?")
      .all(fileName) as Array<{ id: number }>)
      .map((r) => r.id);

    const insert = this.db.prepare(`
      INSERT INTO sections
        (file_name, path, heading, level, content, position,
         heading_line, body_start_line, body_end_line, section_end_line)
      VALUES
        (@fileName, @path, @heading, @level, @content, @position,
         @headingLine, @bodyStartLine, @bodyEndLine, @sectionEndLine)
    `);
    const insertVec = this.db.prepare(
      "INSERT OR REPLACE INTO sections_vec (rowid, embedding) VALUES (?, ?)",
    );

    this.db.transaction(() => {
      for (const id of existingIds) {
        this.db.prepare("DELETE FROM sections_vec WHERE rowid = ?").run(id);
      }
      this.db.prepare("DELETE FROM sections WHERE file_name = ?").run(fileName);

      for (let i = 0; i < sections.length; i++) {
        const s = sections[i];
        const result = insert.run({ fileName, ...s });
        const newId = result.lastInsertRowid as number;
        if (embeddings[i]?.length === 384) insertVec.run(newId, embeddings[i]);
      }
    })();
  }

  updateLineNumbers(
    fileName: string,
    lineNums: Array<{
      path: string;
      headingLine: number;
      bodyStartLine: number;
      bodyEndLine: number;
      sectionEndLine: number;
    }>,
  ): void {
    const stmt = this.db.prepare(`
      UPDATE sections
      SET heading_line     = @headingLine,
          body_start_line  = @bodyStartLine,
          body_end_line    = @bodyEndLine,
          section_end_line = @sectionEndLine
      WHERE file_name = @fileName AND path = @path
    `);
    this.db.transaction(() => {
      for (const n of lineNums) stmt.run({ fileName, ...n });
    })();
  }

  // ── Section reads ─────────────────────────────────────────────────────

  getSection(path: string): SectionRow | undefined {
    return this.db
      .prepare(`
        SELECT id, file_name AS fileName, path, heading, level, content, position,
               heading_line AS headingLine, body_start_line AS bodyStartLine,
               body_end_line AS bodyEndLine, section_end_line AS sectionEndLine
        FROM sections WHERE path = ?
      `)
      .get(path) as SectionRow | undefined;
  }

  getSectionsByFile(fileName: string): SectionRow[] {
    return this.db
      .prepare(`
        SELECT id, file_name AS fileName, path, heading, level, content, position,
               heading_line AS headingLine, body_start_line AS bodyStartLine,
               body_end_line AS bodyEndLine, section_end_line AS sectionEndLine
        FROM sections WHERE file_name = ? ORDER BY position
      `)
      .all(fileName) as SectionRow[];
  }

  // ── Search ────────────────────────────────────────────────────────────

  /**
   * Hybrid search: FTS5 BM25 + vec0 KNN, fused with RRF (k=60).
   * Falls back to FTS5-only when queryVec is undefined (no sidecar).
   */
  search(query: string, queryVec: Float32Array | undefined, top: number): SectionRow[] {
    const K = 60;
    const candidate = top * 5;

    const ftsRows = this.db.prepare(`
      SELECT s.id, rank
      FROM sections_fts f
      JOIN sections s ON s.id = f.rowid
      WHERE sections_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, candidate) as Array<{ id: number; rank: number }>;

    const scores = new Map<number, number>();

    ftsRows.forEach(({ id }, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (K + i + 1));
    });

    if (queryVec) {
      const vecRows = this.db.prepare(`
        SELECT rowid AS id
        FROM sections_vec
        WHERE embedding MATCH ?
          AND k = ?
      `).all(queryVec, candidate) as Array<{ id: number }>;

      vecRows.forEach(({ id }, i) => {
        scores.set(id, (scores.get(id) ?? 0) + 1 / (K + i + 1));
      });
    }

    const topIds = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([id]) => id);

    if (topIds.length === 0) return [];

    const placeholders = topIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT id, file_name AS fileName, path, heading, level, content, position,
             heading_line AS headingLine, body_start_line AS bodyStartLine,
             body_end_line AS bodyEndLine, section_end_line AS sectionEndLine
      FROM sections WHERE id IN (${placeholders})
    `).all(...topIds) as SectionRow[];

    const idOrder = new Map(topIds.map((id, i) => [id, i]));
    return rows.sort((a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0));
  }

  getPathsForFile(fileName: string): Array<{ path: string; level: number }> {
    return this.db
      .prepare("SELECT path, level FROM sections WHERE file_name = ? ORDER BY position")
      .all(fileName) as Array<{ path: string; level: number }>;
  }

  close(): void {
    this.db.close();
  }
}
