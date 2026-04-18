/**
 * TreeSitterParser — wraps tree-sitter and converts parse trees into GraphNode[].
 *
 * Language detection:
 *   parseFile()   — infers language from file extension
 *   parseSource() — caller supplies a language id (e.g. "typescript")
 *
 * Kind extraction:
 *   Each query uses captures named "@def_KIND" where KIND is the graph node kind
 *   (function | method | constructor | class | interface | struct | enum | typeParam).
 *   The parser reads the kind from the capture name suffix.
 *   Special case: method named "constructor" → kind override to "constructor".
 */

import { readFileSync } from "node:fs";
import { extname } from "node:path";

import type { LoadedGrammars } from "./loader.ts";
import { QUERIES } from "./queries.ts";
import { nodeId, EXT_TO_LANG, type GraphNode } from "../daemon/graph.ts";

/** Language id → extension for language lookup in LoadedGrammars.languages */
const LANG_TO_EXT: Record<string, string> = {
  typescript: ".ts",
  javascript: ".js",
  python:     ".py",
  go:         ".go",
  zig:        ".zig",
  lua:        ".lua",
};

export class TreeSitterParser {
  /** Compiled queries keyed by language id */
  private queryCache = new Map<string, any>();

  constructor(private grammars: LoadedGrammars) {}

  /**
   * Parse a file from disk.  Returns an empty array on any error (missing
   * grammar, read failure, parse failure) so callers can fall back to LSP.
   */
  parseFile(absPath: string, relPath: string): GraphNode[] {
    const ext    = extname(absPath).toLowerCase();
    const langId = EXT_TO_LANG[ext];
    if (!langId) return [];

    let source: string;
    try { source = readFileSync(absPath, "utf8"); }
    catch { return []; }

    return this.parseSource(source, relPath, langId, langId);
  }

  /**
   * Parse source text for a given language id.
   * Returns [] if the grammar is unavailable or the query fails.
   */
  parseSource(source: string, relPath: string, langId: string, language?: string): GraphNode[] {
    const ext      = LANG_TO_EXT[langId] ?? `.${langId}`;
    const lang     = this.grammars.languages.get(ext);
    if (!lang) return [];

    const queryDef = QUERIES[langId];
    if (!queryDef) return [];

    const resolvedLanguage = language ?? langId;

    try {
      const parser = new this.grammars.Parser();
      parser.setLanguage(lang);
      const tree    = parser.parse(source);
      const query   = this.getQuery(langId, lang, queryDef.query);
      if (!query) return [];
      const matches = query.matches(tree.rootNode);
      return this.matchesToNodes(matches, relPath, resolvedLanguage);
    } catch {
      return [];
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private getQuery(langId: string, language: any, queryStr: string): any | null {
    if (this.queryCache.has(langId)) return this.queryCache.get(langId)!;
    try {
      const q = language.query(queryStr);
      this.queryCache.set(langId, q);
      return q;
    } catch {
      return null;
    }
  }

  private matchesToNodes(
    matches: Array<{ pattern: number; captures: Array<{ name: string; node: any }> }>,
    relPath: string,
    language: string,
  ): GraphNode[] {
    const nodes: GraphNode[] = [];
    /** Deduplicate: "lineStart:name" → true (first match wins) */
    const seen = new Set<string>();

    for (const match of matches) {
      let nameText  = "";
      let kind      = "";
      let defNode: any = null;
      let nameNode: any = null;

      for (const cap of match.captures) {
        if (cap.name === "name") {
          nameText = cap.node.text;
          nameNode = cap.node;
        } else if (cap.name.startsWith("def_")) {
          kind    = cap.name.slice(4); // "function", "class", "method", …
          defNode = cap.node;
        }
      }

      if (!nameText || !kind || !defNode) continue;

      // Flatten multiline Lua method names (Obj:method → Obj:method is already text)
      const name = nameText;

      // Constructor override
      if (kind === "method" && name === "constructor") kind = "constructor";

      const lineStart = defNode.startPosition.row + 1;
      const lineEnd   = defNode.endPosition.row + 1;
      const colStart  = nameNode
        ? nameNode.startPosition.column
        : defNode.startPosition.column;

      const key = `${lineStart}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      nodes.push({
        id: nodeId(relPath, name, kind),
        name,
        kind,
        language,
        file:      relPath,
        lineStart,
        lineEnd,
        colStart,
      });
    }

    return nodes;
  }
}
