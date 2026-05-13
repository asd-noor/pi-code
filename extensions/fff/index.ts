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
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  Text,
  type AutocompleteItem,
  type AutocompleteProvider,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { FileFinder } from "@ff-labs/fff-node";
import type {
  GrepCursor,
  GrepMode,
  GrepResult,
  SearchResult,
  MixedItem,
} from "@ff-labs/fff-node";
import { buildQuery } from "./query.ts";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_GREP_LIMIT = 20;
const DEFAULT_FIND_LIMIT = 30;
const GREP_MAX_LINE      = 500;
const HOT_FRECENCY       = 25;
const WARM_FRECENCY      = 20;
const FIND_WEAK_SAMPLE   = 5;

// ── Mode system ───────────────────────────────────────────────────────────────

type FffMode = "tools-and-ui" | "tools-only" | "override";

const VALID_MODES: FffMode[] = ["tools-and-ui", "tools-only", "override"];

interface ToolNames {
  grep: string;
  find: string;
}

const FFF_TOOL_NAMES: ToolNames = {
  grep: "ffgrep",
  find: "fffind",
};

const OVERRIDE_TOOL_NAMES: ToolNames = {
  grep: "grep",
  find: "find",
};

function resolveToolNames(mode: FffMode): ToolNames {
  return mode === "override" ? OVERRIDE_TOOL_NAMES : FFF_TOOL_NAMES;
}

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

// ── Mention autocomplete helpers ──────────────────────────────────────────────

function extractAtPrefix(textBeforeCursor: string): string | null {
  const match = textBeforeCursor.match(/(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/);
  return match?.[1] ?? null;
}

function buildAtCompletionValue(path: string): string {
  return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

function createFffMentionProvider(
  getItems: (query: string, signal: AbortSignal) => Promise<AutocompleteItem[]>,
): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const currentLine = lines[cursorLine] || "";
      const prefix = extractAtPrefix(currentLine.slice(0, cursorCol));
      if (!prefix || options.signal.aborted) return null;

      const query = prefix.startsWith('@"') ? prefix.slice(2) : prefix.slice(1);
      const items = await getItems(query, options.signal);
      return options.signal.aborted || items.length === 0
        ? null
        : { items, prefix };
    },
    applyCompletion(_lines, cursorLine, cursorCol, item, prefix) {
      const currentLine = _lines[cursorLine] || "";
      const before = currentLine.slice(0, cursorCol - prefix.length);
      const after = currentLine.slice(cursorCol);
      const newLine = before + item.value + after;
      const newCursorCol = cursorCol - prefix.length + item.value.length;
      return {
        lines: [
          ..._lines.slice(0, cursorLine),
          newLine,
          ..._lines.slice(cursorLine + 1),
        ],
        cursorLine,
        cursorCol: newCursorCol,
      };
    },
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

  // ── Singleton state (inside factory for flag/env access) ──────────────────

  let finder:        FileFinder | null          = null;
  let finderCwd:     string     | null          = null;
  let finderPromise: Promise<FileFinder> | null = null;
  let activeCwd = process.cwd();

  // ── Mode resolution: flag > env > default ─────────────────────────────────

  let currentMode: FffMode =
    (pi.getFlag("fff-mode") as FffMode) ??
    (process.env.PI_FFF_MODE as FffMode) ??
    "tools-and-ui";

  const toolNames = resolveToolNames(currentMode);

  // ── DB path resolution: flag > env > undefined ────────────────────────────

  const frecencyDbPath =
    (pi.getFlag("fff-frecency-db") as string | undefined) ??
    process.env.FFF_FRECENCY_DB ??
    undefined;

  const historyDbPath =
    (pi.getFlag("fff-history-db") as string | undefined) ??
    process.env.FFF_HISTORY_DB ??
    undefined;

  // ── Mode helpers ──────────────────────────────────────────────────────────

  function getMode(): FffMode {
    return currentMode;
  }

  function setMode(mode: FffMode): void {
    currentMode = mode;
  }

  function shouldEnableMentions(): boolean {
    return currentMode !== "tools-only";
  }

  // ── Finder lifecycle ──────────────────────────────────────────────────────

  function ensureFinder(cwd: string, onReady?: (f: FileFinder) => void): Promise<FileFinder> {
    if (finder && !finder.isDestroyed && finderCwd === cwd) {
      onReady?.(finder);
      return Promise.resolve(finder);
    }
    if (finderPromise) return finderPromise;

    finderPromise = (async () => {
      if (finder && !finder.isDestroyed) { finder.destroy(); finder = null; finderCwd = null; }
      const result = FileFinder.create({
        basePath: cwd,
        frecencyDbPath,
        historyDbPath,
        aiMode: true,
      });
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

  // ── Mention items ─────────────────────────────────────────────────────────

  async function getMentionItems(
    query: string,
    signal: AbortSignal,
  ): Promise<AutocompleteItem[]> {
    if (signal.aborted) return [];
    const f = await ensureFinder(activeCwd);
    if (signal.aborted) return [];

    const result = f.mixedSearch(query, { pageSize: 20 });
    if (!result.ok) return [];

    return result.value.items
      .slice(0, 20)
      .map((mixed: MixedItem) => {
        if (mixed.type === "directory") {
          return {
            value: buildAtCompletionValue(mixed.item.relativePath),
            label: mixed.item.dirName,
            description: mixed.item.relativePath,
          };
        }
        return {
          value: buildAtCompletionValue(mixed.item.relativePath),
          label: mixed.item.fileName,
          description: mixed.item.relativePath,
        };
      });
  }

  // ── FffEditor (defined inside factory to capture getMentionItems via closure) ──

  class FffEditor extends CustomEditor {
    private baseProvider: AutocompleteProvider | undefined;

    override setAutocompleteProvider(provider: AutocompleteProvider): void {
      this.baseProvider = provider;
      const mentionProvider = createFffMentionProvider(getMentionItems);
      const compositeProvider: AutocompleteProvider = {
        getSuggestions: async (lines, cursorLine, cursorCol, options) => {
          const mentionResult = await mentionProvider.getSuggestions(
            lines,
            cursorLine,
            cursorCol,
            options,
          );
          if (mentionResult) return mentionResult;
          return (
            this.baseProvider?.getSuggestions(
              lines,
              cursorLine,
              cursorCol,
              options,
            ) ?? null
          );
        },
        applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
          if (prefix?.startsWith("@")) {
            return mentionProvider.applyCompletion!(
              lines,
              cursorLine,
              cursorCol,
              item,
              prefix,
            );
          }
          return (
            this.baseProvider?.applyCompletion?.(
              lines,
              cursorLine,
              cursorCol,
              item,
              prefix,
            ) ?? { lines, cursorLine, cursorCol }
          );
        },
      };
      super.setAutocompleteProvider(compositeProvider);
    }
  }

  // ── applyEditorMode ───────────────────────────────────────────────────────

  function applyEditorMode(ctx: {
    ui: {
      setEditorComponent: (
        factory: ((tui: any, theme: any, keybindings: any) => any) | undefined,
      ) => void;
    };
  }) {
    if (!shouldEnableMentions()) {
      ctx.ui.setEditorComponent(undefined);
    } else {
      ctx.ui.setEditorComponent(
        (tui: any, theme: any, keybindings: any) =>
          new FffEditor(tui, theme, keybindings),
      );
    }
  }

  // ── Flags ─────────────────────────────────────────────────────────────────

  pi.registerFlag("fff-mode", {
    description: "FFF mode: tools-and-ui | tools-only | override",
    type: "string",
  });

  pi.registerFlag("fff-frecency-db", {
    description: "Path to the frecency database (overrides FFF_FRECENCY_DB env)",
    type: "string",
  });

  pi.registerFlag("fff-history-db", {
    description: "Path to the query history database (overrides FFF_HISTORY_DB env)",
    type: "string",
  });

  // ── Event bridge ──────────────────────────────────────────────────────────
  // parallel.ts (and any other extension) can emit "fff:request" to receive the
  // current finder. Registration here runs once at extension load time.
  pi.events.on("fff:request", () => {
    if (finder && !finder.isDestroyed && finderCwd) {
      pi.events.emit("fff:finder", { finder, cwd: finderCwd });
    }
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    try {
      activeCwd = ctx.cwd;
      if (shouldEnableMentions()) applyEditorMode(ctx);
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

  // ── Shared render helper ──────────────────────────────────────────────────

  const renderTextResult = (
    result: { content?: { type: string; text?: string }[] },
    options: { expanded?: boolean },
    theme: any,
    context: any,
    maxLines = 15,
  ) => {
    const text =
      (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    const output =
      result.content?.find((c) => c.type === "text")?.text?.trim() ?? "";
    if (!output) {
      text.setText(theme.fg("muted", "No output"));
      return text;
    }

    const lines = output.split("\n");
    const displayLines = lines.slice(
      0,
      options.expanded ? lines.length : maxLines,
    );
    let content = `\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
    if (lines.length > displayLines.length) {
      content += theme.fg(
        "muted",
        `\n... (${lines.length - displayLines.length} more lines)`,
      );
    }
    text.setText(content);
    return text;
  };

  // ── ffgrep ────────────────────────────────────────────────────────────────

  pi.registerTool({
    name:          toolNames.grep,
    label:         toolNames.grep,
    description:   `Grep file contents. Smart-case, auto-detects regex vs literal, git-aware. Results are ranked by frecency (most-accessed files first); matches within a file stay in source order. Default limit ${DEFAULT_GREP_LIMIT}.`,
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

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const pattern = args?.pattern ?? "";
      const path = args?.path ?? ".";
      let content =
        theme.fg("toolTitle", theme.bold(toolNames.grep))
        + " " + theme.fg("accent", `/${pattern}/`)
        + theme.fg("toolOutput", ` in ${path}`);
      if (args?.limit !== undefined) content += theme.fg("toolOutput", ` limit ${args.limit}`);
      if (args?.cursor) content += theme.fg("muted", ` (page)`);
      text.setText(content);
      return text;
    },

    renderResult(result, options, theme, context) {
      return renderTextResult(result, options, theme, context, 15);
    },
  });

  // ── fffind ────────────────────────────────────────────────────────────────

  pi.registerTool({
    name:          toolNames.find,
    label:         toolNames.find,
    description:   `Fuzzy path search and glob search. Matches against the whole repo-relative path, not just the filename. Frecency-ranked, git-aware. Multi-word = narrower (AND). Default limit ${DEFAULT_FIND_LIMIT}.`,
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

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const pattern = args?.pattern ?? "";
      const path = args?.path ?? ".";
      let content =
        theme.fg("toolTitle", theme.bold(toolNames.find))
        + " " + theme.fg("accent", pattern)
        + theme.fg("toolOutput", ` in ${path}`);
      if (args?.limit !== undefined) content += theme.fg("toolOutput", ` (limit ${args.limit})`);
      if (args?.cursor) content += theme.fg("muted", ` (page)`);
      text.setText(content);
      return text;
    },

    renderResult(result, options, theme, context) {
      return renderTextResult(result, options, theme, context, 20);
    },
  });

  // ── Commands ──────────────────────────────────────────────────────────────

  pi.registerCommand("fff-mode", {
    description: "Show or set FFF mode: /fff-mode [tools-and-ui | tools-only | override]",
    handler: async (args, ctx) => {
      const arg = (args || "").trim();

      // No args — show current mode
      if (!arg) {
        const mode = getMode();
        const flag = pi.getFlag("fff-mode") ?? "unset";
        const env  = process.env.PI_FFF_MODE ?? "unset";
        ctx.ui.notify(`Current mode: '${mode}'\nFlag: ${flag}, Env: ${env}`, "info");
        return;
      }

      // Validate and set mode
      if (!VALID_MODES.includes(arg as FffMode)) {
        ctx.ui.notify(`Usage: /fff-mode [${VALID_MODES.join(" | ")}]`, "warning");
        return;
      }

      const newMode = arg as FffMode;
      const oldMode = getMode();
      setMode(newMode);
      applyEditorMode(ctx);

      const note =
        (oldMode === "override") !== (newMode === "override")
          ? " (tool name change requires restart)"
          : "";
      ctx.ui.notify(`Mode changed: '${oldMode}' → '${newMode}'${note}`, "info");
    },
  });

  pi.registerCommand("fff-health", {
    description: "Show FFF file finder health and status",
    handler: async (_args, ctx) => {
      if (!finder || finder.isDestroyed) { ctx.ui.notify("FFF not initialized", "warning"); return; }
      const health = finder.healthCheck();
      if (!health.ok) { ctx.ui.notify(`Health check failed: ${health.error}`, "error"); return; }
      const h = health.value;
      const lines = [
        `FFF v${h.version}`,
        `Mode: ${getMode()}`,
        `Git: ${h.git.repositoryFound ? `yes (${h.git.workdir ?? "unknown"})` : "no"}`,
        `Picker: ${h.filePicker.initialized ? `${h.filePicker.indexedFiles ?? 0} files` : "not initialized"}`,
        `Frecency: ${h.frecency.initialized ? "active" : "disabled"}`,
        `Query tracker: ${h.queryTracker.initialized ? "active" : "disabled"}`,
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

  // ── System prompt instructions ────────────────────────────────────────────

  const FFF_INSTRUCTION = `
## fff — file search and grep

\`ffgrep\` and \`fffind\` are the primary tools for exploring and searching the codebase.

### When to use each

- **\`fffind\`** — first step whenever you need to locate files. Prefer over \`ls\`, \`find\`, or \`bash\` for any file discovery task. Frecency-ranked (most-accessed files surface first).
- **\`ffgrep\`** — first step whenever you need to search file contents. Prefer over \`bash\` + ripgrep/grep. Auto-detects regex vs literal; falls back to fuzzy when no exact matches found.

### Usage rules

- After 1–2 greps, \`read\` the top match rather than grepping more.
- Use \`path\` to scope (\`src/\`, \`*.ts\`) and \`exclude\` to cut noise (\`test/\`, \`*.min.js\`).
- \`caseSensitive: true\` only when exact case matters — smart-case is the default.
- Multi-word \`fffind\` queries narrow results (AND, order-independent).

### Editor features

- **@-mention autocomplete**: type \`@\` in the prompt editor to fuzzy-search and insert file paths.
- **\`/fff-mode [tools-and-ui|tools-only|override]\`**: switch modes at runtime (\`override\` registers tools as \`grep\`/\`find\` — requires restart).
- **\`/fff-health\`**: check indexing status, version, frecency, and git state.
`.trim();

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${FFF_INSTRUCTION}`,
  }));
}
