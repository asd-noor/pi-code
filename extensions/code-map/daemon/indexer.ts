/**
 * Indexer — builds and incrementally updates the CodeMapDB.
 *
 * Phase 1 (blocking, before "ready"):
 *   If a TreeSitterParser is available, each file is parsed synchronously
 *   with tree-sitter (fast — no LSP round-trips, no sleep).
 *   For files whose grammar is unavailable, falls back to LSP documentSymbol.
 *   Incremental: files whose mtime matches file_meta are skipped entirely.
 *
 * Phase 2 (background, after "ready"):
 *   textDocument/references per fn/method/class → populate reverseRefs
 */

import { relative, resolve, extname } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { LspClient } from "../lsp/client.ts";
import type { TreeSitterParser } from "../tree-sitter/parser.ts";
import { REF_KINDS, nodeId, EXT_TO_LANG, type RefLocation, type GraphNode } from "./graph.ts";
import { type CodeMapDB } from "./db.ts";
import type { DiagRow } from "./db.ts";
import {
  SYMBOL_KIND_NAMES,
  SEVERITY_NAMES,
  DiagnosticSeverity,
  SymbolKind,
  type DocumentSymbol,
  type SymbolInformation,
  type Diagnostic,
} from "../lsp/protocol.ts";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "vendor", ".code-map",
  "target", "__pycache__", ".next", "build",
]);

const SKIP_KINDS = new Set([
  SymbolKind.File, SymbolKind.Variable, SymbolKind.String,
  SymbolKind.Number, SymbolKind.Boolean, SymbolKind.Array,
  SymbolKind.Object, SymbolKind.Key, SymbolKind.Null,
]);

type Log = (msg: string) => void;

export class Indexer {
  private aborted = false;
  /** Optional tree-sitter parser — set by runner after grammar load. */
  tsParser?: TreeSitterParser;
  /** Serialises concurrent file-change re-indexes so they never race. */
  private reindexQueue: Promise<void> = Promise.resolve();

  constructor(
    private clients: Map<string, LspClient>,
    private db: CodeMapDB,
    private rootPath: string,
    private extensions: Set<string>,
    private log: Log,
  ) {}

  abort() { this.aborted = true; }

  /** Returns the LspClient for a given absolute file path, or undefined. */
  private clientFor(absFile: string): LspClient | undefined {
    const ext = extname(absFile).toLowerCase();
    return this.clients.get(ext);
  }

  // ── Phase 1 ───────────────────────────────────────────────────────────────

  async buildNodes(files: string[], tsParser?: TreeSitterParser): Promise<void> {
    const parser = tsParser ?? this.tsParser;

    // ── Remove files that are in DB but no longer on disk ───────────────────
    const dbFiles  = this.db.getTrackedFiles();
    const diskFiles = new Set(files.map((f) => relative(this.rootPath, f)));
    const removedFiles = [...dbFiles].filter((f) => !diskFiles.has(f));
    if (removedFiles.length > 0) {
      this.log(`removing ${removedFiles.length} deleted files from DB...`);
      this.db.deleteFiles(removedFiles);
    }

    // ── Split files into stale (need re-index) and fresh (skip) ─────────────
    type StaleFile = { abs: string; mtimeMs: number };
    const staleFiles: StaleFile[] = [];
    let freshCount = 0;

    for (const absFile of files) {
      const relFile = relative(this.rootPath, absFile);
      try {
        const { mtimeMs } = statSync(absFile);
        if (this.db.getMtime(relFile) === mtimeMs) {
          freshCount++;
        } else {
          staleFiles.push({ abs: absFile, mtimeMs });
        }
      } catch (_) {
        // stat failed — treat as stale so it gets a proper error below
        try {
          staleFiles.push({ abs: absFile, mtimeMs: statSync(absFile).mtimeMs });
        } catch (_2) {}
      }
    }

    this.log(
      `building node graph from ${staleFiles.length} stale files ` +
      `(${freshCount} fresh, skipping)...`,
    );

    let count = 0;

    for (const { abs: absFile, mtimeMs } of staleFiles) {
      if (this.aborted) return;
      const relFile = relative(this.rootPath, absFile);

      if (parser) {
        // Tree-sitter path: synchronous, no sleep, no LSP open needed
        try {
          const nodes = parser.parseFile(absFile, relFile);
          if (nodes.length > 0) {
            this.db.insertNodes(nodes);
            this.db.setMtime(relFile, mtimeMs);
            count += nodes.length;
            continue;
          }
        } catch (_) {
          // fall through to LSP
        }
      }

      // LSP fallback — for files whose grammar is unavailable or on parse error
      const client = this.clientFor(absFile);
      if (!client) {
        this.log(`  skip ${relFile}: no LSP client for this file type`);
        continue;
      }

      const language = EXT_TO_LANG[extname(absFile).toLowerCase()] ?? "unknown";

      try {
        client.openFile(absFile);
        const raw   = await client.documentSymbols(absFile);
        const nodes = flattenSymbols(raw, relFile, language);
        this.db.insertNodes(nodes);
        this.db.setMtime(relFile, mtimeMs);
        count += nodes.length;
      } catch (err) {
        this.log(`  skip ${relFile}: ${err}`);
      }
    }

    this.log(
      `node graph ready: ${count} new symbols indexed across ${staleFiles.length} files`,
    );
  }

  snapshotDiagnostics(rawDiags: Map<string, Diagnostic[]>): void {
    let fileCount = 0;
    for (const [uri, diags] of rawDiags) {
      const fp       = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
      const relFile  = relative(this.rootPath, fp);
      const language = EXT_TO_LANG[extname(fp).toLowerCase()] ?? "unknown";
      const rows: DiagRow[] = diags.map((d) => ({
        severity: SEVERITY_NAMES[d.severity ?? DiagnosticSeverity.Error] ?? "unknown",
        language,
        file:     relFile,
        line:     d.range.start.line + 1,
        col:      d.range.start.character + 1,
        source:   String(d.source ?? ""),
        message:  d.message,
      }));
      this.db.setDiagnostics(relFile, language, rows);
      fileCount++;
    }
    this.log(`diagnostics snapshotted for ${fileCount} files`);
  }

  // ── Phase 2 ───────────────────────────────────────────────────────────────

  async buildReverseRefs(): Promise<void> {
    const targets = this.db.getNodesForReverseRefs(REF_KINDS);
    this.log(`building reverse refs for ${targets.length} symbols (background)...`);

    let done = 0;
    for (const node of targets) {
      if (this.aborted) return;
      const absFile = resolve(this.rootPath, node.file);
      const client = this.clientFor(absFile);
      if (!client) {
        this.db.markIndexed(node.id);
        done++;
        if (done % 10 === 0 || done === targets.length) {
          this.log(`  reverse refs: ${done}/${targets.length}`);
        }
        continue;
      }
      try {
        const refs = await client.references(absFile, node.lineStart - 1, node.colStart, false);
        const locations: RefLocation[] = refs
          .map((r) => ({
            file:      relative(this.rootPath, r.uri.startsWith("file://") ? fileURLToPath(r.uri) : r.uri),
            lineStart: r.range.start.line + 1,
            lineEnd:   r.range.end.line + 1,
          }))
          .filter((r) => !(r.file === node.file && r.lineStart === node.lineStart));
        this.db.setReverseRefs(node.id, locations);
      } catch (_) {
        this.db.markIndexed(node.id);
      }
      done++;
      if (done % 10 === 0 || done === targets.length) {
        this.log(`  reverse refs: ${done}/${targets.length}`);
      }
    }
    this.log("reverse refs complete");
  }

  // ── Incremental re-index ──────────────────────────────────────────────────

  /** Public entry-point: queues re-indexes so concurrent watcher events never race. */
  reindexFile(absFile: string): Promise<void> {
    const task = this.reindexQueue.then(() =>
      this.aborted ? Promise.resolve() : this._reindexFile(absFile),
    );
    this.reindexQueue = task.catch(() => {});
    return task;
  }

  private async _reindexFile(absFile: string): Promise<void> {
    const relFile = relative(this.rootPath, absFile);
    this.log(`re-indexing: ${relFile}`);
    this.db.deleteFile(relFile);

    // ── Tree-sitter path: instant, synchronous symbol update ─────────────────
    if (this.tsParser) {
      try {
        const nodes = this.tsParser.parseFile(absFile, relFile);
        if (nodes.length > 0) {
          this.db.insertNodes(nodes);
          this.db.setMtime(relFile, statSync(absFile).mtimeMs);
          this.log(`  re-indexed ${nodes.length} symbols (tree-sitter)`);

          // Notify LSP async — diagnostics update in background, don't block.
          void this._lspReindexBackground(absFile, relFile);
          return;
        }
      } catch (_) {
        // fall through to LSP path
      }
    }

    // ── LSP fallback path (no tree-sitter grammar for this file type) ─────────
    const client = this.clientFor(absFile);
    if (!client) {
      this.log(`  skip LSP re-index for ${relFile}: no client for this file type`);
      return;
    }

    const language = EXT_TO_LANG[extname(absFile).toLowerCase()] ?? "unknown";

    client.updateFile(absFile);
    await client.waitForQuietDiagnostics(600, 6000);

    try {
      const raw   = await client.documentSymbols(absFile);
      const nodes = flattenSymbols(raw, relFile, language);
      this.db.insertNodes(nodes);
      this.db.setMtime(relFile, statSync(absFile).mtimeMs);
      this.log(`  re-indexed ${nodes.length} symbols (lsp)`);
    } catch (err) {
      this.log(`  re-index symbols failed: ${err}`);
    }

    this.snapshotDiagnostics(
      client.getDiagnostics() as Map<string, Diagnostic[]>,
    );

    // Update reverse refs for new nodes (background, best-effort).
    void this._updateReverseRefsForFile(absFile, relFile);
  }

  /** Fire-and-forget LSP diagnostic + reverse-ref update after a tree-sitter re-index. */
  private async _lspReindexBackground(absFile: string, relFile: string): Promise<void> {
    const client = this.clientFor(absFile);
    if (!client) return;
    try {
      client.updateFile(absFile);
      await client.waitForQuietDiagnostics(600, 6000);
      this.snapshotDiagnostics(
        client.getDiagnostics() as Map<string, Diagnostic[]>,
      );
    } catch (_) {}
    void this._updateReverseRefsForFile(absFile, relFile);
  }

  private async _updateReverseRefsForFile(absFile: string, relFile: string): Promise<void> {
    const client = this.clientFor(absFile);
    if (!client) return;
    const newNodes = this.db.getByFile(relFile);
    for (const node of newNodes.filter((n) => REF_KINDS.has(n.kind))) {
      if (this.aborted) return;
      try {
        const refs = await client.references(absFile, node.lineStart - 1, node.colStart, false);
        this.db.setReverseRefs(node.id, refs
          .map((r) => ({
            file:      relative(this.rootPath, r.uri.startsWith("file://") ? fileURLToPath(r.uri) : r.uri),
            lineStart: r.range.start.line + 1,
            lineEnd:   r.range.end.line + 1,
          }))
          .filter((r) => !(r.file === node.file && r.lineStart === node.lineStart)),
        );
      } catch (_) {
        this.db.markIndexed(node.id);
      }
    }
  }

  // ── File collection ───────────────────────────────────────────────────────

  collectFiles(limit: number): string[] {
    const found: string[] = [];
    this.walkDir(this.rootPath, found, limit);
    return found;
  }

  private walkDir(dir: string, found: string[], limit: number): void {
    if (found.length >= limit) return;
    try {
      for (const entry of readdirSync(dir)) {
        if (found.length >= limit) break;
        if (SKIP_DIRS.has(entry)) continue;
        const full = resolve(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) this.walkDir(full, found, limit);
        else if (this.extensions.has(extname(entry))) found.push(full);
      }
    } catch (_) {}
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function flattenSymbols(
  raw: DocumentSymbol[] | SymbolInformation[],
  relFile: string,
  language: string,
  out: GraphNode[] = [],
): GraphNode[] {
  if (!raw.length) return out;
  const isHierarchical = "selectionRange" in raw[0] || "children" in raw[0];

  if (isHierarchical) {
    for (const sym of raw as DocumentSymbol[]) {
      if (!SKIP_KINDS.has(sym.kind)) {
        out.push({
          id:        nodeId(relFile, sym.name, SYMBOL_KIND_NAMES[sym.kind] ?? ""),
          name:      sym.name,
          kind:      SYMBOL_KIND_NAMES[sym.kind] ?? `kind${sym.kind}`,
          language,
          file:      relFile,
          lineStart: sym.range.start.line + 1,
          lineEnd:   sym.range.end.line + 1,
          colStart:  sym.selectionRange.start.character,
        });
      }
      if (sym.children?.length) flattenSymbols(sym.children, relFile, language, out);
    }
  } else {
    for (const sym of raw as SymbolInformation[]) {
      if (!SKIP_KINDS.has(sym.kind)) {
        out.push({
          id:        nodeId(relFile, sym.name, SYMBOL_KIND_NAMES[sym.kind] ?? ""),
          name:      sym.name,
          kind:      SYMBOL_KIND_NAMES[sym.kind] ?? `kind${sym.kind}`,
          language,
          file:      relFile,
          lineStart: sym.location.range.start.line + 1,
          lineEnd:   sym.location.range.end.line + 1,
          colStart:  sym.location.range.start.character,
        });
      }
    }
  }
  return out;
}
