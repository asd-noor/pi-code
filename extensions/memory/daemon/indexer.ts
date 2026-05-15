import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { parseFile, flattenSections } from "../markdown/parser.ts";
import type { MemoryDB } from "./db.ts";
import { embedTexts, sectionEmbedText } from "../sidecar/index.ts";

export class Indexer {
  constructor(
    private memDir: string,
    private db: MemoryDB,
    private sidecarSockPath: string,
    private log: (msg: string) => void,
  ) {}

  /**
   * Walk memDir root level, re-index all .md files that have changed.
   * Subdirectories (e.g. snapshot-*) are ignored.
   */
  async indexAll(): Promise<void> {
    if (!existsSync(this.memDir)) return;

    const entries = readdirSync(this.memDir);
    const mdFiles = entries.filter(
      (e) => extname(e) === ".md" && statSync(join(this.memDir, e)).isFile(),
    );

    // Remove DB entries for files no longer on disk
    const dbFiles = new Set(this.db.listFiles());
    for (const fileName of dbFiles) {
      if (!mdFiles.some((f) => basename(f, ".md") === fileName)) {
        this.log(`removing deleted file: ${fileName}.md`);
        this.db.deleteFile(fileName);
      }
    }

    for (const mdFile of mdFiles) {
      await this.indexFile(join(this.memDir, mdFile));
    }
  }

  /** Index a single file. Skips if mtime unchanged. */
  async indexFile(filePath: string): Promise<void> {
    const fileName = basename(filePath, ".md");

    let mtime: number;
    try {
      mtime = statSync(filePath).mtimeMs;
    } catch {
      this.db.deleteFile(fileName);
      return;
    }

    if (this.db.getMtime(fileName) === mtime) return;

    this.log(`indexing ${fileName}.md`);

    const content = readFileSync(filePath, "utf8");
    const parsed = parseFile(content, fileName);
    const flat = flattenSections(parsed.sections);

    // Batch-embed all sections
    let embeddings: Float32Array[] = [];
    if (flat.length > 0) {
      const texts = flat.map((s) => sectionEmbedText(s.path, s.heading, s.content));
      const result = await embedTexts(this.sidecarSockPath, texts);
      if (result) {
        embeddings = result;
        this.log(`  embedded ${result.length} sections`);
      }
    }

    this.db.upsertFile({
      fileName,
      mtimeMs: mtime,
      title: parsed.title,
      description: parsed.description,
    });

    this.db.replaceFileSections(
      fileName,
      flat.map((s, i) => ({
        path: s.path,
        heading: s.heading,
        level: s.level,
        content: s.content,
        position: i,
        headingLine: s.headingLine,
        bodyStartLine: s.bodyStartLine,
        bodyEndLine: s.bodyEndLine,
        sectionEndLine: s.sectionEndLine,
      })),
      embeddings,
    );
  }
}
