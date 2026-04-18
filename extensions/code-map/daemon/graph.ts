/**
 * Pure types and constants for code-map.
 * CodeGraph has been removed — all storage is handled by CodeMapDB (daemon/db.ts).
 */

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
