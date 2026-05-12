/**
 * extensions/fff/index.ts — First-party fff extension.
 *
 * Owns the FileFinder singleton, registers `ffgrep` and `fffind` tools, and
 * bridges the instance to other extensions (e.g. parallel.ts) via pi.events:
 *
 *   "fff:finder"  — emitted with { finder, cwd } once the finder is ready.
 *                   Subscribers should update their cached reference.
 *   "fff:request" — emit this (any payload) to request an immediate re-emit
 *                   of "fff:finder" if the finder is already initialised.
 *
 * Replaces @ff-labs/pi-fff. Uses @ff-labs/fff-node directly.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FileFinder } from "@ff-labs/fff-node";
import type { GrepCursor, GrepMode, GrepResult, SearchResult } from "@ff-labs/fff-node";
import { buildQuery } from "./query.ts";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_GREP_LIMIT  = 20;
const DEFAULT_FIND_LIMIT  = 30;
const GREP_MAX_LINE       = 500;
const HOT_FRECENCY        = 25;
const WARM_FRECENCY       = 20;
const FIND_WEAK_SAMPLE    = 5;

// ── Singleton state ──────────────────────────────────────────────────────────

let finder:        FileFinder | null         = null;
let finderCwd:     string     | null         = null;
let finderPromise: Promise<FileFinder> | null = null;
let activeCwd = process.cwd();

// ── Cursor caches ─────────────────────────────────────────────────────────────

const grepCursorCache = new Map<string, GrepCursor>();
let   grepCursorCounter = 0;

interface FindCursor { query: string; pattern: string; pageSize: number; nextPageIndex: number; }
const findCursorCache = new Map<string, FindCursor>();
let   findCursorCounter = 0;

function storeCursor(cursor: GrepCursor): string {
  const id = `fff_c${++grepCursorCounter}`;
  grepCursorCache.set(id, cursor);
  if (grepCursorCache.size > 200) {
    const first = grepCursorCache.keys().next().value;
    if (first) grepCursorCache.delete(first);
  }
  return id;
}

function getCursor(id: string): GrepCursor | undefined {
  return grepCursorCache.get(id);
}

function storeFindCursor(c: FindCursor): string {
  const id = `${++findCursorCounter}`;
  findCursorCache.set(id, c);
  if (findCursorCache.size > 200) {
    const first = findCursorCache.keys().next().value;
    if (first) findCursorCache.delete(first);
  }
  return id;
}

function getFindCursor(id: string): FindCursor | undefined {
  return findCursorCache.get(id);
}

// ── Finder lifecycle ─────────────────────────────────────────────────────────

function ensureFinder(cwd: string, onReady?: (f: FileFinder) => void): Promise<FileFinder> {
  if (finder && !finder.isDestroyed && finderCwd === cwd) {
    onReady?.(finder);
    return Promise.resolve(finder);
  }
  if (finderPromise) return finderPromise;

  finderPromise = (async () => {
    if (finder && !finder.isDestroyed) { finder.destroy(); finder = null; finderCwd = null; }
    const result = FileFinder.create({ basePath: cwd, aiMode: true });
    if (!result.ok) throw new Error(`FileFinder.create failed: ${result.error}`);
    finder    = result.value;
    finderCwd = cwd;
    await finder.waitForScan(15_000);
    onReady?.(finder);
    return finder;
  })().finally(() => { finderPromise = null; });

  return finderPromise;
}

function destroyFinder() {
  if (finder && !finder.isDestroyed) { finder.destroy(); finder = null; finderCwd = null; }
}

// ── Output formatting ────────────────────────────────────────────────────────

export function fileAnnotation(item: {
  gitStatus?: string;
  totalFrecencyScore?: number;
  accessFrecencyScore?: number;
}): string {
  const git = item.gitStatus;
  if (git && git !== "clean" && git !== "unknown" && git !== "") return `  [${git} in git]`;
  const score = item.totalFrecencyScore ?? item.accessFrecencyScore ?? 0;
  if (score >= HOT_FRECENCY)  return "  [VERY often touched file]";
  if (score >= WARM_FRECENCY) return "  [often touched file]";
  return "";
}

function formatGrepOutput(result: GrepResult): string {
  if (result.items.length === 0) return "No matches found";
  const lines: string[] = [];
  let currentFile = "";
  for (const match of result.items) {
    if (match.relativePath !== currentFile) {
      if (lines.length > 0) lines.push("");
      currentFile = match.relativePath;
      lines.push(`${currentFile}${fileAnnotation(match)}`);
    }
    (match.contextBefore ?? []).forEach((line: string, i: number) => {
      const ln = match.lineNumber - (match.contextBefore?.length ?? 0) + i;
      lines.push(` ${ln}- ${line.trim().slice(0, GREP_MAX_LINE)}`);
    });
    lines.push(` ${match.lineNumber}: ${match.lineContent.trim().slice(0, GREP_MAX_LINE)}`);
    (match.contextAfter ?? []).forEach((line: string, i: number) => {
      lines.push(` ${match.lineNumber + 1 + i}- ${line.trim().slice(0, GREP_MAX_LINE)}`);
    });
  }
  return lines.join("\n");
}

function formatFindOutput(
  result: SearchResult,
  limit: number,
  pattern: string,
): { output: string; weak: boolean; shownCount: number } {
  if (result.items.length === 0) {
    return { output: "No files found matching pattern", weak: false, shownCount: 0 };
  }
  const topScore = result.scores[0]?.total ?? 0;
  const weak     = topScore < Math.floor((pattern.length * 12 * 50) / 100);
  const cap      = weak ? Math.min(FIND_WEAK_SAMPLE, limit) : limit;
  const shown    = result.items.slice(0, cap);
  return {
    output:     shown.map(item => `${item.relativePath}${fileAnnotation(item)}`).join("\n"),
    weak,
    shownCount: shown.length,
  };
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const grepSchema = Type.Object({
  pattern: Type.String({
    description: "Search pattern (literal text or regex)",
  }),
  path: Type.Optional(Type.String({
    description:
      "Repo-relative path constraint. Directory prefix (src/ or src/foo/), bare filename with extension (main.rs), or glob (*.ts, src/**/*.cc, {src,lib}/**). Applied to the full repo-relative path.",
  })),
  exclude: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], {
    description:
      "Exclude paths (comma/space-separated or array). Same syntax as path. A leading '!' is optional. Example: 'test/,*.min.js,!vendor/'.",
  })),
  caseSensitive: Type.Optional(Type.Boolean({
    description: "Force case-sensitive matching. Default uses smart-case.",
  })),
  context: Type.Optional(Type.Number({
    description: "Context lines before+after each match",
  })),
  limit: Type.Optional(Type.Number({
    description: `Max matches (default ${DEFAULT_GREP_LIMIT})`,
  })),
  cursor: Type.Optional(Type.String({
    description: "Pagination cursor from previous result",
  })),
});

const findSchema = Type.Object({
  pattern: Type.String({
    description:
      "Fuzzy filename search and glob search. Frecency-ranked, git-aware. Multi-word = narrower (AND). Prefer this over ls/find/bash as the first exploration step.",
  }),
  path: Type.Optional(Type.String({
    description:
      "Repo-relative path constraint. Directory prefix, bare filename, or glob.",
  })),
  exclude: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], {
    description: "Exclude paths (comma/space-separated or array). Example: 'test/,*.min.js'.",
  })),
  limit: Type.Optional(Type.Number({
    description: `Max results per page (default ${DEFAULT_FIND_LIMIT})`,
  })),
  cursor: Type.Optional(Type.String({
    description: "Pagination cursor from previous result",
  })),
});

// ── Extension ─────────────────────────────────────────────────────────────────

export default function fffExtension(pi: ExtensionAPI) {

  // ── Event bridge ────────────────────────────────────────────────────────────
  // parallel.ts (and any other extension) can emit "fff:request" to receive the
  // current finder. Registration here runs once at extension load time.
  pi.events.on("fff:request", () => {
    if (finder && !finder.isDestroyed && finderCwd) {
      pi.events.emit("fff:finder", { finder, cwd: finderCwd });
    }
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    try {
      activeCwd = ctx.cwd;
      await ensureFinder(activeCwd, (f) => {
        pi.events.emit("fff:finder", { finder: f, cwd: activeCwd });
      });
    } catch (e: unknown) {
      ctx.ui.notify(
        `FFF init failed: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    }
  });

  pi.on("session_shutdown", async () => { destroyFinder(); });

  // ── ffgrep ───────────────────────────────────────────────────────────────────

  pi.registerTool({
    name:        "ffgrep",
    label:       "ffgrep",
    description: `Grep file contents. Smart-case, auto-detects regex vs literal, git-aware. Results are ranked by frecency (most-accessed files first); matches within a file stay in source order. Default limit ${DEFAULT_GREP_LIMIT}.`,
    promptSnippet: "Grep contents",
    promptGuidelines: [
      "Prefer bare identifiers as patterns. Literal queries are most efficient.",
      "Use path for include ('src/', '*.ts') and exclude for noise ('test/,*.min.js').",
      "caseSensitive: true when you need exact case (smart-case otherwise).",
      "After 1-2 greps, read the top match instead of more greps.",
    ],
    parameters: grepSchema,

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const f = await ensureFinder(activeCwd);
      const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
      const query = buildQuery(params.path, params.pattern, params.exclude, activeCwd);

      const hasRegex = params.pattern !== params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      let mode: GrepMode = hasRegex ? "regex" : "plain";
      if (mode === "regex") { try { new RegExp(params.pattern); } catch { mode = "plain"; } }

      const p = params.pattern.trim();
      const isWildcardOnly =
        hasRegex &&
        /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/.test(p);
      if (isWildcardOnly) {
        return {
          content: [{ type: "text", text: `Pattern '${params.pattern}' matches everything — grep needs a concrete substring or identifier.` }],
          details: { totalMatched: 0, totalFiles: 0 },
        };
      }

      const smartCase  = params.caseSensitive !== true;
      const grepResult = f.grep(query, {
        mode,
        smartCase,
        maxMatchesPerFile: Math.min(effectiveLimit, 50),
        cursor:        (params.cursor ? getCursor(params.cursor) : null) ?? null,
        beforeContext: params.context ?? 0,
        afterContext:  params.context ?? 0,
        classifyDefinitions: true,
      });
      if (!grepResult.ok) throw new Error(grepResult.error);

      let result      = grepResult.value;
      let fuzzyNotice: string | null = null;

      if (result.items.length === 0 && !params.cursor && mode !== "regex") {
        const fuzzy = f.grep(params.pattern, {
          mode: "fuzzy", smartCase,
          maxMatchesPerFile: Math.min(effectiveLimit, 50),
          cursor: null, beforeContext: 0, afterContext: 0,
          classifyDefinitions: true,
        });
        if (fuzzy.ok && fuzzy.value.items.length > 0) {
          fuzzyNotice = "0 exact matches. Maybe you meant this?";
          result = fuzzy.value;
        }
      }

      let output = formatGrepOutput(result);
      const notices: string[] = [];
      if (result.regexFallbackError) notices.push(`Invalid regex: ${result.regexFallbackError}, used literal match`);
      if (result.nextCursor)         notices.push(`Continue with cursor="${storeCursor(result.nextCursor)}"`);
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
      if (fuzzyNotice) output = `[${fuzzyNotice}]\n${output}`;

      return {
        content: [{ type: "text", text: output }],
        details: { totalMatched: result.totalMatched, totalFiles: result.totalFiles },
      };
    },
  });

  // ── fffind ────────────────────────────────────────────────────────────────────

  pi.registerTool({
    name:        "fffind",
    label:       "fffind",
    description: `Fuzzy path search and glob search. Matches against the whole repo-relative path, not just the filename. Frecency-ranked, git-aware. Multi-word = narrower (AND). Default limit ${DEFAULT_FIND_LIMIT}.`,
    promptSnippet: "Find files by path or glob",
    promptGuidelines: [
      "Matches the WHOLE path, not just the filename — `profile` hits `chrome/browser/profiles/x.cc` too.",
      "Keep queries to 1-2 terms; extra words narrow.",
      "Use for paths, not content. Use grep for content.",
      "For exact path matches use a glob in `path` — e.g. path: '**/profile.h' for exact filename, or path: 'src/**/profile.h' scoped to a subtree. Bare patterns are fuzzy.",
      "To list everything inside a directory, pass path: 'dir/**' with an empty or wildcard pattern instead of using pattern alone.",
      "Use exclude: 'test/,*.min.js' to cut noise in large repos.",
    ],
    parameters: findSchema,

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const f = await ensureFinder(activeCwd);

      const resumed        = params.cursor ? getFindCursor(params.cursor) : undefined;
      const effectiveLimit = resumed ? resumed.pageSize : Math.max(1, params.limit ?? DEFAULT_FIND_LIMIT);
      const query          = resumed ? resumed.query   : buildQuery(params.path, params.pattern, params.exclude, activeCwd);
      const pattern        = resumed ? resumed.pattern : params.pattern;
      const pageIndex      = resumed?.nextPageIndex ?? 0;

      const searchResult = f.fileSearch(query, { pageIndex, pageSize: effectiveLimit });
      if (!searchResult.ok) throw new Error(searchResult.error);

      const result    = searchResult.value;
      const formatted = formatFindOutput(result, effectiveLimit, pattern);
      let output      = formatted.output;

      const shownSoFar = pageIndex * effectiveLimit + result.items.length;
      const hasMore    = result.items.length >= effectiveLimit && result.totalMatched > shownSoFar;

      const notices: string[] = [];
      if (formatted.weak && formatted.shownCount > 0) {
        notices.push(`Query "${pattern}" produced only weak scattered fuzzy matches. Output capped at ${formatted.shownCount}/${result.totalMatched}.`);
      }
      if (!formatted.weak && hasMore) {
        const remaining = result.totalMatched - shownSoFar;
        const cursorId  = storeFindCursor({ query, pattern, pageSize: effectiveLimit, nextPageIndex: pageIndex + 1 });
        notices.push(`${remaining} more match${remaining === 1 ? "" : "es"} available. cursor="${cursorId}" to continue`);
      }
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

      return {
        content: [{ type: "text", text: output }],
        details: { totalMatched: result.totalMatched, totalFiles: result.totalFiles, pageIndex, hasMore },
      };
    },
  });

  // ── Commands ──────────────────────────────────────────────────────────────────

  pi.registerCommand("fff-health", {
    description: "Show FFF file finder health and status",
    handler: async (_args, ctx) => {
      if (!finder || finder.isDestroyed) { ctx.ui.notify("FFF not initialized", "warning"); return; }
      const health = finder.healthCheck();
      if (!health.ok) { ctx.ui.notify(`Health check failed: ${health.error}`, "error"); return; }
      const h = health.value;
      const lines = [
        `Git: ${h.git.repositoryFound ? `yes (${h.git.workdir ?? "unknown"})` : "no"}`,
        `Picker: ${h.filePicker.initialized ? `${h.filePicker.indexedFiles ?? 0} files` : "not initialized"}`,
        `Frecency: ${h.frecency.initialized ? "active" : "disabled"}`,
      ];
      const progress = finder.getScanProgress();
      if (progress.ok) {
        lines.push(`Scanning: ${progress.value.isScanning ? "yes" : "no"} (${progress.value.scannedFilesCount} files)`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("fff-rescan", {
    description: "Trigger FFF to rescan files",
    handler: async (_args, ctx) => {
      if (!finder || finder.isDestroyed) { ctx.ui.notify("FFF not initialized", "warning"); return; }
      const result = finder.scanFiles();
      if (!result.ok) { ctx.ui.notify(`Rescan failed: ${result.error}`, "error"); return; }
      ctx.ui.notify("FFF rescan triggered", "info");
    },
  });
}
