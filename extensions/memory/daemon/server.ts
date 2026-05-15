import { createServer, type Server, type Socket } from "node:net";
import { existsSync, readdirSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import type { MemoryDB } from "./db.ts";
import { Indexer } from "./indexer.ts";
import {
  newSection, updateSection, deleteSection, createFile,
} from "../markdown/writer.ts";
import { embedTexts } from "../sidecar/index.ts";
import { validateFile } from "../markdown/validator.ts";

export class DaemonServer {
  private server: Server;
  private activeSockets = new Set<Socket>();
  private indexing = false;
  /** Per-file promise chains — serialises concurrent writes to the same file. */
  private writeLocks = new Map<string, Promise<void>>();

  constructor(
    private sockPath: string,
    private memDir: string,
    private db: MemoryDB,
    private indexer: Indexer,
    private sidecarSockPath: string,
    private onShutdown: () => void,
  ) {
    this.server = createServer((s) => this.handleConnection(s));
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.sockPath, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((res) => {
      for (const s of this.activeSockets) s.destroy();
      const t = setTimeout(() => res(), 2000);
      this.server.close(() => { clearTimeout(t); res(); });
    });
  }

  isIndexing(): boolean { return this.indexing; }

  private handleConnection(socket: Socket): void {
    this.activeSockets.add(socket);
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.length > 1_000_000) { socket.destroy(); return; }
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (t) void this.handleLine(t, socket);
      }
    });
    socket.on("close", () => this.activeSockets.delete(socket));
    socket.on("error", () => {});
  }

  private async handleLine(line: string, socket: Socket): Promise<void> {
    let req: { id: number; Cmd: string; [k: string]: unknown };
    try { req = JSON.parse(line); }
    catch { this.send(socket, { Ok: false, Error: "invalid JSON" }); return; }

    try {
      const result = await this.dispatch(req);
      this.send(socket, { ...result, id: req.id });
    } catch (err) {
      this.send(socket, { id: req.id, Ok: false, Error: (err as Error).message });
    }
  }

  private send(socket: Socket, payload: unknown): void {
    try { socket.write(JSON.stringify(payload) + "\n"); } catch (_) {}
  }

  private async dispatch(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (req.Cmd) {

      case "status": return {
        Ok: true,
        Sidecar: existsSync(this.sidecarSockPath),
        Indexing: this.indexing,
        MemDir: this.memDir,
      };

      case "list": {
        const name = req.Name as string | undefined;
        if (name) {
          const rows = this.db.getSectionsByFile(name);
          return { Ok: true, Paths: rows.map((r) => r.path) };
        }
        return { Ok: true, Files: this.db.listFiles() };
      }

      case "get": {
        const row = this.db.getSection(req.Path as string);
        if (!row) throw new Error(`section not found: ${req.Path}`);
        const fullHeading = row.updatedAt ? `${row.heading} | ${row.updatedAt}` : row.heading;
        return { Ok: true, Heading: fullHeading, Content: row.content };
      }

      case "search": {
        const query = req.Query as string;
        const top   = (req.Top as number) || 5;

        let queryVec: Float32Array | undefined;
        if (existsSync(this.sidecarSockPath)) {
          const result = await embedTexts(this.sidecarSockPath, [query]);
          if (result?.[0]) queryVec = result[0];
        }

        const rows = this.db.search(query, queryVec, top);
        return {
          Ok: true,
          Results: rows.map((r) => ({
            Path:    r.path,
            Heading: r.updatedAt ? `${r.heading} | ${r.updatedAt}` : r.heading,
            Content: r.content,
          })),
        };
      }

      case "new": {
        const sectionPath = req.Path as string;
        const fileName = sectionPath.split("/")[0];
        const filePath = join(this.memDir, `${fileName}.md`);
        if (!existsSync(filePath)) throw new Error(`file not found: ${fileName}`);
        return this.withFileLock(filePath, async () => {
          newSection(filePath, fileName, sectionPath, req.Heading as string, req.Content as string, this.db);
          await this.reindexFile(filePath);
          const issues = this.runValidation(filePath, fileName);
          if (issues.length > 0) throw new Error(`validation failed:\n${issues.join("\n")}`);
          return { Ok: true };
        });
      }

      case "update": {
        const sectionPath = req.Path as string;
        const fileName = sectionPath.split("/")[0];
        const filePath = join(this.memDir, `${fileName}.md`);
        return this.withFileLock(filePath, async () => {
          updateSection(filePath, fileName, sectionPath, req.Content as string, this.db);
          await this.reindexFile(filePath);
          const issues = this.runValidation(filePath, fileName);
          if (issues.length > 0) throw new Error(`validation failed:\n${issues.join("\n")}`);
          return { Ok: true };
        });
      }

      case "delete": {
        const sectionPath = req.Path as string;
        const fileName = sectionPath.split("/")[0];
        const filePath = join(this.memDir, `${fileName}.md`);
        return this.withFileLock(filePath, async () => {
          deleteSection(filePath, fileName, sectionPath, this.db);
          await this.reindexFile(filePath);
          return { Ok: true };
        });
      }

      case "create-file": {
        mkdirSync(this.memDir, { recursive: true });
        const filePath = join(this.memDir, `${req.Name}.md`);
        return this.withFileLock(filePath, async () => {
          createFile(this.memDir, req.Name as string, req.Title as string, (req.Description as string) || "");
          await this.reindexFile(filePath);
          return { Ok: true };
        });
      }

      case "delete-file": {
        const filePath = join(this.memDir, `${req.Name}.md`);
        return this.withFileLock(filePath, async () => {
          if (existsSync(filePath)) unlinkSync(filePath);
          this.db.deleteFile(req.Name as string);
          return { Ok: true };
        });
      }

      case "validate-file": {
        const filePath = join(this.memDir, `${req.Name}.md`);
        const issues = this.runValidation(filePath, req.Name as string);
        return { Ok: issues.length === 0, Issues: issues };
      }

      case "shutdown":
        setTimeout(() => this.onShutdown(), 100);
        return { Ok: true };

      default:
        throw new Error(`unknown command: ${req.Cmd}`);
    }
  }

  /**
   * Serialises all writes to a given file path.
   * Concurrent callers queue behind the running operation and execute in turn.
   */
  private withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLocks.get(filePath) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    this.writeLocks.set(filePath, gate);
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release();
        if (this.writeLocks.get(filePath) === gate) this.writeLocks.delete(filePath);
      }
    });
  }

  /** Re-index a single file after a mutation. Forces re-index by clearing mtime. */
  private async reindexFile(filePath: string): Promise<void> {
    this.indexing = true;
    try {
      const fileName = basename(filePath, ".md");
      const file = this.db.getFile(fileName);
      if (file) this.db.upsertFile({ ...file, mtimeMs: 0 });
      await this.indexer.indexFile(filePath);
    } finally {
      this.indexing = false;
    }
  }

  private runValidation(filePath: string, fileName: string): string[] {
    try {
      const content = readFileSync(filePath, "utf8");
      return validateFile(content, fileName);
    } catch {
      return [];
    }
  }
}
