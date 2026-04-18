/**
 * Indexer — builds and incrementally updates the CodeGraph.
 *
 * Phase 1 (blocking, before "ready"):
 *   If a TreeSitterParser is available, each file is parsed synchronously
 *   with tree-sitter (fast — no LSP round-trips, no sleep).
 *   For files whose grammar is unavailable, falls back to LSP documentSymbol.
 *
 * Phase 2 (background, after "ready"):
 *   textDocument/references per fn/method/class → populate reverseRefs
 */

import { relative, resolve, extname } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { LspClient } from "../lsp/client.ts";
import type { TreeSitterParser } from "../tree-sitter/parser.ts";
import { CodeGraph, REF_KINDS, nodeId, type RefLocation, type GraphNode } from "./graph.ts";
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
    private client: LspClient,
    private graph: CodeGraph,
    private rootPath: string,
    private extensions: Set<string>,
    private log: Log,
  ) {}

  abort() { this.aborted = true; }

  // ── Phase 1 ───────────────────────────────────────────────────────────────

  async buildNodes(files: string[], tsParser?: TreeSitterParser): Promise<void> {
    const parser = tsParser ?? this.tsParser;
    this.log(`building node graph from ${files.length} files (${parser ? "tree-sitter" : "lsp"})...`);
    let count = 0;

    for (const absFile of files) {
      if (this.aborted) return;
      const relFile = relative(this.rootPath, absFile);

      if (parser) {
        // Tree-sitter path: synchronous, no sleep, no LSP open needed
        try {
          const nodes = parser.parseFile(absFile, relFile);
          if (nodes.length > 0) {
            for (const node of nodes) this.graph.addNode(node);
            count += nodes.length;
            continue;
          }
        } catch (_) {
          // fall through to LSP
        }
      }

      // LSP fallback — for files whose grammar is unavailable or on parse error
      try {
        this.client.openFile(absFile);
        const raw   = await this.client.documentSymbols(absFile);
        const nodes = flattenSymbols(raw, relFile);
        for (const node of nodes) this.graph.addNode(node);
        count += nodes.length;
      } catch (err) {
        this.log(`  skip ${relFile}: ${err}`);
      }
    }
    this.log(`node graph ready: ${count} symbols across ${files.length} files`);
  }

  snapshotDiagnostics(rawDiags: Map<string, Diagnostic[]>): void {
    for (const [uri, diags] of rawDiags) {
      const fp      = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
      const relFile = relative(this.rootPath, fp);
      this.graph.diagnostics.set(relFile, diags.map((d) => ({
        severity: SEVERITY_NAMES[d.severity ?? DiagnosticSeverity.Error] ?? "unknown",
        file:     relFile,
        line:     d.range.start.line + 1,
        col:      d.range.start.character + 1,
        source:   String(d.source ?? ""),
        message:  d.message,
      })));
    }
    this.log(`diagnostics snapshotted for ${this.graph.diagnostics.size} files`);
  }

  // ── Phase 2 ───────────────────────────────────────────────────────────────

  async buildReverseRefs(): Promise<void> {
    const targets = [...this.graph.nodes.values()].filter(
      (n) => REF_KINDS.has(n.kind) && !this.graph.indexed.has(n.id),
    );
    this.log(`building reverse refs for ${targets.length} symbols (background)...`);

    let done = 0;
    for (const node of targets) {
      if (this.aborted) return;
      const absFile = resolve(this.rootPath, node.file);
      try {
        const refs = await this.client.references(absFile, node.lineStart - 1, node.colStart, false);
        const locations: RefLocation[] = refs
          .map((r) => ({
            file:      relative(this.rootPath, r.uri.startsWith("file://") ? fileURLToPath(r.uri) : r.uri),
            lineStart: r.range.start.line + 1,
            lineEnd:   r.range.end.line + 1,
          }))
          .filter((r) => !(r.file === node.file && r.lineStart === node.lineStart));
        this.graph.setReverseRefs(node.id, locations);
      } catch (_) {
        this.graph.indexed.add(node.id);
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
    this.graph.removeFile(relFile);

    // ── Tree-sitter path: instant, synchronous symbol update ─────────────────
    if (this.tsParser) {
      try {
        const nodes = this.tsParser.parseFile(absFile, relFile);
        if (nodes.length > 0) {
          for (const node of nodes) this.graph.addNode(node);
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
    this.client.updateFile(absFile);
    await this.client.waitForQuietDiagnostics(600, 6000);

    try {
      const raw   = await this.client.documentSymbols(absFile);
      const nodes = flattenSymbols(raw, relFile);
      for (const node of nodes) this.graph.addNode(node);
      this.log(`  re-indexed ${nodes.length} symbols (lsp)`);
    } catch (err) {
      this.log(`  re-index symbols failed: ${err}`);
    }

    this.snapshotDiagnostics(
      this.client.getDiagnostics() as Map<string, Diagnostic[]>,
    );

    // Update reverse refs for new nodes (background, best-effort).
    void this._updateReverseRefsForFile(absFile, relFile);
  }

  /** Fire-and-forget LSP diagnostic + reverse-ref update after a tree-sitter re-index. */
  private async _lspReindexBackground(absFile: string, relFile: string): Promise<void> {
    try {
      this.client.updateFile(absFile);
      await this.client.waitForQuietDiagnostics(600, 6000);
      this.snapshotDiagnostics(
        this.client.getDiagnostics() as Map<string, Diagnostic[]>,
      );
    } catch (_) {}
    void this._updateReverseRefsForFile(absFile, relFile);
  }

  private async _updateReverseRefsForFile(absFile: string, relFile: string): Promise<void> {
    const newNodes = this.graph.byFile.get(relFile) ?? [];
    for (const node of newNodes.filter((n) => REF_KINDS.has(n.kind))) {
      if (this.aborted) return;
      try {
        const refs = await this.client.references(absFile, node.lineStart - 1, node.colStart, false);
        this.graph.setReverseRefs(node.id, refs
          .map((r) => ({
            file:      relative(this.rootPath, r.uri.startsWith("file://") ? fileURLToPath(r.uri) : r.uri),
            lineStart: r.range.start.line + 1,
            lineEnd:   r.range.end.line + 1,
          }))
          .filter((r) => !(r.file === node.file && r.lineStart === node.lineStart)),
        );
      } catch (_) {
        this.graph.indexed.add(node.id);
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
          file:      relFile,
          lineStart: sym.range.start.line + 1,
          lineEnd:   sym.range.end.line + 1,
          colStart:  sym.selectionRange.start.character,
        });
      }
      if (sym.children?.length) flattenSymbols(sym.children, relFile, out);
    }
  } else {
    for (const sym of raw as SymbolInformation[]) {
      if (!SKIP_KINDS.has(sym.kind)) {
        out.push({
          id:        nodeId(relFile, sym.name, SYMBOL_KIND_NAMES[sym.kind] ?? ""),
          name:      sym.name,
          kind:      SYMBOL_KIND_NAMES[sym.kind] ?? `kind${sym.kind}`,
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
