/**
 * In-memory code graph.
 *
 * Nodes   — every symbol extracted from documentSymbol responses
 * byFile  — fast lookup: relFile → Node[]
 * byName  — fast lookup: normalized name → Node[]
 * reverseRefs — callee nodeId → RefLocation[] (populated by background indexer)
 * diagnostics — relFile → DiagRow[]
 */

import type { DiagRow } from "./server.ts";

/** Extension → language id (canonical mapping shared across the codebase) */
export const EXT_TO_LANG: Record<string, string> = {
  ".ts":  "typescript",
  ".tsx": "typescript",
  ".js":  "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py":  "python",
  ".go":  "go",
  ".zig": "zig",
  ".lua": "lua",
};

/** All language ids supported by tree-sitter */
export const SUPPORTED_LANGUAGES: Set<string> = new Set(Object.values(EXT_TO_LANG));

export interface GraphNode {
  id: string;       // sha256(file:name:kind)[:16]
  name: string;
  kind: string;     // function | method | class | interface | …
  language: string; // typescript | javascript | python | go | zig | lua
  file: string;     // relative to rootPath
  lineStart: number;
  lineEnd: number;
  colStart: number;
}

export interface RefLocation {
  file: string;     // relative to rootPath
  lineStart: number;
  lineEnd: number;
}

/** Kinds we build reverseRefs for (skip fields/vars/constants — too noisy) */
export const REF_KINDS = new Set([
  "function", "method", "constructor", "class",
  "interface", "struct", "enum", "typeParam",
]);

export class CodeGraph {
  /** All nodes, keyed by id */
  readonly nodes = new Map<string, GraphNode>();

  /** file (relative) → nodes defined in that file */
  readonly byFile = new Map<string, GraphNode[]>();

  /** normalized lower-case name → nodes (handles "Store.FindImpact" → "findimpact") */
  readonly byName = new Map<string, GraphNode[]>();

  /** callee node id → list of reference locations (callers) */
  readonly reverseRefs = new Map<string, RefLocation[]>();

  /** relFile → diagnostic rows */
  readonly diagnostics = new Map<string, DiagRow[]>();

  /** Set of node ids whose reverseRefs have been computed */
  readonly indexed = new Set<string>();

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);

    const fileList = this.byFile.get(node.file) ?? [];
    fileList.push(node);
    this.byFile.set(node.file, fileList);

    // Index under all name variants:
    //   "(*Store).FindImpact" → "findimpact", "store.findimpact", "(*store).findimpact"
    for (const key of nameKeys(node.name)) {
      const list = this.byName.get(key) ?? [];
      list.push(node);
      this.byName.set(key, list);
    }
  }

  removeFile(relFile: string): void {
    const nodes = this.byFile.get(relFile) ?? [];
    for (const node of nodes) {
      this.nodes.delete(node.id);
      this.reverseRefs.delete(node.id);
      this.indexed.delete(node.id);
      for (const key of nameKeys(node.name)) {
        const list = this.byName.get(key);
        if (list) {
          const filtered = list.filter((n) => n.id !== node.id);
          if (filtered.length > 0) this.byName.set(key, filtered);
          else this.byName.delete(key);
        }
      }
    }
    this.byFile.delete(relFile);
    this.diagnostics.delete(relFile);
    // Also clear reverseRefs entries that point INTO this file
    for (const [id, refs] of this.reverseRefs) {
      const filtered = refs.filter((r) => r.file !== relFile);
      if (filtered.length !== refs.length) this.reverseRefs.set(id, filtered);
    }
  }

  setReverseRefs(nodeId: string, refs: RefLocation[]): void {
    this.reverseRefs.set(nodeId, refs);
    this.indexed.add(nodeId);
  }

  findByName(name: string): GraphNode[] {
    const results = new Map<string, GraphNode>();
    for (const key of nameKeys(name)) {
      for (const node of this.byName.get(key) ?? []) {
        results.set(node.id, node);
      }
    }
    // Also partial substring match
    const lower = name.toLowerCase();
    if (results.size === 0) {
      for (const [key, nodes] of this.byName) {
        if (key.includes(lower)) {
          for (const n of nodes) results.set(n.id, n);
        }
      }
    }
    return [...results.values()];
  }

  stats(): object {
    return {
      nodes: this.nodes.size,
      files: this.byFile.size,
      reverseRefsBuilt: this.indexed.size,
      reverseRefsTotal: [...this.nodes.values()].filter((n) => REF_KINDS.has(n.kind)).length,
      diagnosticFiles: this.diagnostics.size,
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

/** Produce all name keys for a symbol name */
function nameKeys(name: string): string[] {
  const keys = new Set<string>();
  const lower = name.toLowerCase();
  keys.add(lower);
  // "Store.FindImpact" → "findimpact"
  const dot = lower.split(".").pop();
  if (dot) keys.add(dot);
  // "(*Store).FindImpact" → strip receiver → "findimpact"
  const stripped = lower.replace(/^\(\*?\w+\)\./, "");
  if (stripped) keys.add(stripped);
  return [...keys];
}

/** Deterministic node id: first 16 hex chars of sha256(file:name:kind) */
export function nodeId(file: string, name: string, kind: string): string {
  // Simple djb2-style hash (no crypto dep needed)
  const input = `${file}:${name}:${kind}`;
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
    h = h >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
