/**
 * parallel.ts — Parallel tool calling with inlined tool implementations.
 *
 * Registers a `parallel` meta tool that fans out multiple independent
 * operations concurrently via Promise.all and returns all results together.
 *
 * Supported operations:
 *   Native:  read, bash, write, edit
 *   Inlined: ptc
 *            mcporter
 *            code_map_outline, code_map_symbol, code_map_diagnostics, code_map_impact
 *            memory_list, memory_get, memory_search,
 *            memory_create_file, memory_delete_file, memory_validate_file
 *            agenda_create
 *            agenda_discovery_add, agenda_discovery_get,
 *            agenda_discovery_list, agenda_discovery_delete
 *            ffgrep, fffind  (via shared FileFinder from extensions/fff)
 *
 * Blacklisted (concurrent writes corrupt memory files):
 *            memory_new, memory_update, memory_delete
 *
 * No monkey-patching. All supported non-native tools are implemented directly
 * in this file, using the same logic as their respective extensions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { exec, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { SocketClient } from "./code-map/client.ts";
import {
  openDb,
  getAgenda,
  getDiscoveries,
  getDiscovery,
  normalizeNotes,
  requireAgendaInProgress,
  runTx,
  toPositiveInt as agendaToPositiveInt,
  nowIso,
} from "./agenda/db.ts";
import { DISCOVERY_CATEGORIES, DISCOVERY_OUTCOMES } from "./agenda/types.ts";
import { formatDiscovery, formatDiscoveryList } from "./agenda/format.ts";
import { AGENDA_DISCOVERY_TOOL_NAMES } from "./agenda/tools.ts";
import type { FileFinder, GrepCursor } from "@ff-labs/fff-node";
import { buildQuery } from "./fff/query.ts";

const execAsync     = promisify(exec);
const execFileAsync = promisify(execFile);
const SANDBOX_DIR   = "/tmp/pi-sandbox";

// ── fff state (shared FileFinder received from extensions/fff via pi.events) ──
let sharedFinder: FileFinder | null = null;

const fffGrepCursorCache = new Map<string, GrepCursor>();
let   fffGrepCursorCounter = 0;

interface FffFindCursor { query: string; pattern: string; pageSize: number; nextPageIndex: number; }
const fffFindCursorCache = new Map<string, FffFindCursor>();
let   fffFindCursorCounter = 0;

function fffStoreCursor(cursor: GrepCursor): string {
  const id = `fffp_c${++fffGrepCursorCounter}`;
  fffGrepCursorCache.set(id, cursor);
  if (fffGrepCursorCache.size > 200) {
    const first = fffGrepCursorCache.keys().next().value;
    if (first) fffGrepCursorCache.delete(first);
  }
  return id;
}

function fffStoreFindCursor(c: FffFindCursor): string {
  const id = `${++fffFindCursorCounter}`;
  fffFindCursorCache.set(id, c);
  if (fffFindCursorCache.size > 200) {
    const first = fffFindCursorCache.keys().next().value;
    if (first) fffFindCursorCache.delete(first);
  }
  return id;
}

const FFF_GREP_MAX_LINE = 500;
const FFF_HOT_FRECENCY  = 25;
const FFF_WARM_FRECENCY = 20;

function fffAnnotation(item: { gitStatus?: string; totalFrecencyScore?: number; accessFrecencyScore?: number }): string {
  const git = item.gitStatus;
  if (git && git !== "clean" && git !== "unknown" && git !== "") return `  [${git} in git]`;
  const score = item.totalFrecencyScore ?? item.accessFrecencyScore ?? 0;
  if (score >= FFF_HOT_FRECENCY)  return "  [VERY often touched file]";
  if (score >= FFF_WARM_FRECENCY) return "  [often touched file]";
  return "";
}

function fffFormatGrep(result: any): string {
  if (!result.items.length) return "No matches found";
  const lines: string[] = [];
  let currentFile = "";
  for (const match of result.items) {
    if (match.relativePath !== currentFile) {
      if (lines.length > 0) lines.push("");
      currentFile = match.relativePath;
      lines.push(`${currentFile}${fffAnnotation(match)}`);
    }
    (match.contextBefore ?? []).forEach((line: string, i: number) => {
      lines.push(` ${match.lineNumber - (match.contextBefore?.length ?? 0) + i}- ${line.trim().slice(0, FFF_GREP_MAX_LINE)}`);
    });
    lines.push(` ${match.lineNumber}: ${match.lineContent.trim().slice(0, FFF_GREP_MAX_LINE)}`);
    (match.contextAfter ?? []).forEach((line: string, i: number) => {
      lines.push(` ${match.lineNumber + 1 + i}- ${line.trim().slice(0, FFF_GREP_MAX_LINE)}`);
    });
  }
  return lines.join("\n");
}

// ── Memory helpers ───────────────────────────────────────────────────────────

function getMemoryDir(cwd: string): string {
  return process.env.MEMORY_MD_DIR ?? join(cwd, ".pi-memory");
}

/** Single-quote a string for safe shell interpolation. */
function q(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function memRun(
  memDir: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  try {
    const { stdout, stderr } = await execAsync(
      `MEMORY_MD_DIR=${q(memDir)} memory-md ${args.map(q).join(" ")}`,
      { timeout: 30_000 },
    );
    return { stdout, stderr: stderr ?? "", ok: true };
  } catch (err: any) {
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? err.message, ok: false };
  }
}

function memRunWithInput(memDir: string, args: string[], body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("memory-md", args, {
      env: { ...process.env, MEMORY_MD_DIR: memDir },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code: number | null) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Command failed: memory-md ${args.join(" ")}\n${stderr || stdout}`));
    });
    child.on("error", reject);
    child.stdin.write(body);
    child.stdin.end();
  });
}

// ── Call spec schemas ────────────────────────────────────────────────────────

const ReadCall = Type.Object({
  tool:   Type.Literal("read"),
  path:   Type.String({ description: "Path to file (relative or absolute)." }),
  offset: Type.Optional(Type.Number({ description: "Line to start from (1-indexed)." })),
  limit:  Type.Optional(Type.Number({ description: "Max lines to read." })),
});

const BashCall = Type.Object({
  tool:    Type.Literal("bash"),
  command: Type.String({ description: "One-shot bash command to execute. For non-trivial shell work, prefer a bash script through ptc instead." }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 120)." })),
  stdin:   Type.Optional(Type.String({ description: "Data to pipe to stdin." })),
});

const WriteCall = Type.Object({
  tool:    Type.Literal("write"),
  path:    Type.String({ description: "Path to write (creates parent dirs automatically)." }),
  content: Type.String({ description: "Content to write." }),
});

const EditEntry = Type.Object({
  oldText: Type.String({ description: "Exact text to replace. Must be unique in the file." }),
  newText: Type.String({ description: "Replacement text." }),
});

const EditCall = Type.Object({
  tool:  Type.Literal("edit"),
  path:  Type.String({ description: "Path to file to edit." }),
  edits: Type.Array(EditEntry, {
    description: "Exact text replacements. Each oldText must be unique and non-overlapping in the file.",
  }),
});

const PtcCall = Type.Object({
  tool:    Type.Literal("ptc"),
  purpose: Type.String({ description: "One-line description of what this script does. Shown in the UI when the tool runs." }),
  type:    StringEnum(["python", "bash"] as const, { description: "Script type. Prefer python unless the task is pure shell." }),
  script:  Type.String({ description: "Full script content. Python scripts must start with `#!/usr/bin/env -S uv run --script` and include PEP 723 metadata." }),
  args:    Type.Optional(Type.Array(Type.String(), { description: "Command-line arguments passed to the script." })),
  stdin:   Type.Optional(Type.String({ description: "Data to pipe to the script's stdin." })),
});

/**
 * Catch-all for inlined extension tools (code_map_*, memory_*).
 * The `tool` field names the tool; all other fields are passed as params.
 */
const McporterCall = Type.Object({
  tool:      Type.Literal("mcporter"),
  action:    StringEnum(["search", "describe", "call"] as const, { description: "Action to run: search tools, describe a tool schema, or call a tool." }),
  selector:  Type.Optional(Type.String({ description: "Tool selector in the form 'server.tool'. Required for describe and call." })),
  query:     Type.Optional(Type.String({ description: "Free-text query for search." })),
  limit:     Type.Optional(Type.Number({ description: "Maximum number of search matches (default 20, max 100).", maximum: 100, minimum: 1 })),
  args:      Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arguments object for call action." })),
  argsJson:  Type.Optional(Type.String({ description: "JSON object string for call arguments. Mutually exclusive with args." })),
  timeoutMs: Type.Optional(Type.Number({ description: "Per-call timeout in milliseconds (default 30000).", maximum: 300000, minimum: 1 })),
});

const ExtCall = Type.Object(
  {
    tool: Type.String({
      description:
        "Name of a supported inlined tool: " +
        "code_map_outline, code_map_symbol, code_map_diagnostics, code_map_impact, " +
        "memory_list, memory_get, memory_search, " +
        "memory_create_file, memory_delete_file, memory_validate_file. " +
        "agenda_create. " +
        "agenda_discovery_add, agenda_discovery_get, agenda_discovery_list, agenda_discovery_delete. " +
        "ffgrep, fffind (requires extensions/fff to be loaded — shares its FileFinder via pi.events). " +
        "NOT allowed (concurrent writes corrupt memory files): memory_new, memory_update, memory_delete — call these sequentially via the native tools. " +
        "Pass the tool's normal arguments as additional fields alongside `tool`.",
    }),
  },
  { additionalProperties: true },
);

const CallSpec = Type.Union([ReadCall, BashCall, WriteCall, EditCall, PtcCall, McporterCall, ExtCall]);

// ── Native op implementations ────────────────────────────────────────────────

function opRead(path: string, cwd: string, offset?: number, limit?: number): string {
  const fullPath = resolve(cwd, path);
  const lines    = readFileSync(fullPath, "utf8").split("\n");
  const start    = offset != null ? Math.max(0, offset - 1) : 0;
  const end      = limit  != null ? start + limit : lines.length;
  return lines.slice(start, end).join("\n");
}

async function opBash(command: string, timeout?: number, stdin?: string): Promise<string> {
  const result = await execAsync(command, {
    timeout:   (timeout ?? 120) * 1000,
    maxBuffer: 10 * 1024 * 1024,
    input:     stdin,
  } as any);
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim() || "(no output)";
}

function opWrite(path: string, content: string, cwd: string): string {
  const fullPath = resolve(cwd, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
  return `Written: ${fullPath}`;
}

function opEdit(path: string, edits: Array<{ oldText: string; newText: string }>, cwd: string): string {
  const fullPath = resolve(cwd, path);
  let content = readFileSync(fullPath, "utf8");
  for (const { oldText, newText } of edits) {
    const count = content.split(oldText).length - 1;
    if (count === 0) throw new Error(`oldText not found: ${JSON.stringify(oldText.slice(0, 80))}`);
    if (count > 1)  throw new Error(`oldText not unique (${count} occurrences): ${JSON.stringify(oldText.slice(0, 80))}`);
    content = content.replace(oldText, newText);
  }
  writeFileSync(fullPath, content, "utf8");
  return `Edited ${edits.length} replacement(s) in ${fullPath}`;
}

// ── ptc implementation ───────────────────────────────────────────────────────

async function opPtc(
  call: { purpose: string; type: "python" | "bash"; script: string; args?: string[]; stdin?: string },
  toolCallId: string,
  index: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  mkdirSync(SANDBOX_DIR, { recursive: true });
  const ext  = call.type === "python" ? "py" : "sh";
  const file = `${SANDBOX_DIR}/${toolCallId.slice(0, 8)}-${index}.${ext}`;
  writeFileSync(file, call.script, { mode: 0o755 });

  const cmd  = call.type === "python" ? file : "bash";
  const args = call.type === "python"
    ? [...(call.args ?? [])]
    : [file, ...(call.args ?? [])];

  const scriptName = basename(file);
  const header     = `ptc: ${scriptName}\nPurpose: ${call.purpose}`;

  try {
    const result = await execFileAsync(cmd, args, {
      input:     call.stdin,
      timeout:   120_000,
      signal,
      maxBuffer: 10 * 1024 * 1024,
    } as any);
    const out = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    return `${header}\n${out || "(no output)"}`;
  } catch (err: any) {
    const out  = [err.stdout ?? "", err.stderr ?? ""].filter(Boolean).join("\n").trim();
    const code = err.code ?? 1;
    return `${header}\nExit ${code}:\n${out || err.message}`;
  }
}

// ── mcporter implementation ──────────────────────────────────────────────────

async function opMcporter(params: Record<string, any>): Promise<string> {
  const timeout = params.timeoutMs ?? 30_000;

  switch (params.action) {
    case "search": {
      const cliArgs = ["list", "--schema", "--json"];
      if (params.query) cliArgs.splice(1, 0, params.query);
      try {
        const { stdout, stderr } = await execFileAsync("mcporter", cliArgs, { timeout, maxBuffer: 5 * 1024 * 1024 });
        return stdout.trim() || stderr.trim() || "(no output)";
      } catch (err: any) {
        return [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").trim();
      }
    }
    case "describe": {
      if (!params.selector) throw new Error("mcporter describe: selector is required");
      const server = params.selector.split(".")[0];
      try {
        const { stdout, stderr } = await execFileAsync("mcporter", ["list", server, "--schema", "--json"], { timeout, maxBuffer: 5 * 1024 * 1024 });
        return stdout.trim() || stderr.trim() || "(no output)";
      } catch (err: any) {
        return [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").trim();
      }
    }
    case "call": {
      if (!params.selector) throw new Error("mcporter call: selector is required");
      const cliArgs = ["call", params.selector, "--output", "json"];
      if (params.argsJson) {
        cliArgs.push("--args", params.argsJson);
      } else if (params.args) {
        cliArgs.push("--args", JSON.stringify(params.args));
      }
      try {
        const { stdout, stderr } = await execFileAsync("mcporter", cliArgs, { timeout, maxBuffer: 10 * 1024 * 1024 });
        return stdout.trim() || stderr.trim() || "(no output)";
      } catch (err: any) {
        return [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").trim();
      }
    }
    default:
      throw new Error(`mcporter: unknown action "${params.action}"`);
  }
}

// ── code_map implementations ──────────────────────────────────────────────────

async function opCodeMap(toolName: string, params: Record<string, any>, cwd: string): Promise<string> {
  const client = new SocketClient(cwd);
  const lang   = params.language ?? "";
  switch (toolName) {
    case "code_map_outline": {
      const rows = await client.query<any[]>("outline", { file: params.file, language: lang });
      return rows.length ? JSON.stringify(rows, null, 2) : "(no symbols found)";
    }
    case "code_map_symbol": {
      const rows = await client.query<any[]>("symbol", { name: params.name, withSource: params.source ?? false, language: lang });
      return rows.length ? JSON.stringify(rows, null, 2) : `(no symbol found: ${params.name})`;
    }
    case "code_map_diagnostics": {
      const rows = await client.query<any[]>("diagnostics", {
        ...(params.file ? { file: params.file } : {}),
        language: lang,
        severity: params.severity ?? 0,
      });
      return rows.length ? JSON.stringify(rows, null, 2) : "(no diagnostics)";
    }
    case "code_map_impact": {
      const rows = await client.query<any[]>("impact", { name: params.name, language: lang });
      return rows.length ? JSON.stringify(rows, null, 2) : `(no callers found for: ${params.name})`;
    }
    default:
      throw new Error(`Unknown code_map tool: ${toolName}`);
  }
}

// ── memory implementations ───────────────────────────────────────────────────

async function opMemory(toolName: string, params: Record<string, any>, cwd: string): Promise<string> {
  const dir = getMemoryDir(cwd);

  switch (toolName) {
    case "memory_list": {
      const args = params.file ? ["list", params.file] : ["list"];
      const res  = await memRun(dir, args);
      return res.ok ? (res.stdout.trim() || "(no output)") : `Error: ${res.stderr || res.stdout}`;
    }
    case "memory_get": {
      const res = await memRun(dir, ["get", params.path]);
      return res.ok ? (res.stdout.trim() || "(no output)") : `Error: ${res.stderr || res.stdout}`;
    }
    case "memory_search": {
      const res = await memRun(dir, ["search", params.query, "--top", String(params.top ?? 5)]);
      return res.ok ? (res.stdout.trim() || "(no output)") : `Error: ${res.stderr || res.stdout}`;
    }
    case "memory_new": {
      const args = ["new", params.path];
      if (params.heading) args.push("--heading", params.heading);
      try {
        const out = await memRunWithInput(dir, args, params.body);
        return out.trim() || `Section created: ${params.path}`;
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    }
    case "memory_update": {
      try {
        const out = await memRunWithInput(dir, ["update", params.path], params.body);
        return out.trim() || `Section updated: ${params.path}`;
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    }
    case "memory_delete": {
      const res = await memRun(dir, ["delete", params.path]);
      return res.ok ? `Section deleted: ${params.path}` : `Error: ${res.stderr || res.stdout}`;
    }
    case "memory_create_file": {
      const args = ["create-file", params.name, params.title];
      if (params.description) args.push(params.description);
      const res = await memRun(dir, args);
      return res.ok ? `File created: ${params.name}.md` : `Error: ${res.stderr || res.stdout}`;
    }
    case "memory_delete_file": {
      const res = await memRun(dir, ["delete-file", params.name]);
      return res.ok ? `File deleted: ${params.name}.md` : `Error: ${res.stderr || res.stdout}`;
    }
    case "memory_validate_file": {
      const res = await memRun(dir, ["validate-file", params.name]);
      return res.ok
        ? `${params.name}.md: ${res.stdout.trim() || "no issues found"}`
        : res.stdout.trim() || res.stderr.trim() || "(no output)";
    }
    default:
      throw new Error(`Unknown memory tool: ${toolName}`);
  }
}

// ── fff tool implementations ─────────────────────────────────────────────────

async function opFfgrep(params: Record<string, any>, cwd: string): Promise<string> {
  if (!sharedFinder || sharedFinder.isDestroyed)
    throw new Error("fff finder not available — is extensions/fff loaded?");

  const effectiveLimit = Math.max(1, params.limit ?? 20);
  const query          = buildQuery(params.path, params.pattern, params.exclude, cwd);
  const hasRegex       = params.pattern !== params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let mode: "plain" | "regex" | "fuzzy" = hasRegex ? "regex" : "plain";
  if (mode === "regex") { try { new RegExp(params.pattern); } catch { mode = "plain"; } }

  const p = params.pattern.trim();
  if (hasRegex && /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/.test(p))
    return `Pattern '${params.pattern}' matches everything — grep needs a concrete substring.`;

  const smartCase  = params.caseSensitive !== true;
  const grepResult = sharedFinder.grep(query, {
    mode,
    smartCase,
    maxMatchesPerFile:   Math.min(effectiveLimit, 50),
    cursor:              (params.cursor ? fffGrepCursorCache.get(params.cursor) : null) ?? null,
    beforeContext:       params.context ?? 0,
    afterContext:        params.context ?? 0,
    classifyDefinitions: true,
  });
  if (!grepResult.ok) throw new Error(grepResult.error);

  let result      = grepResult.value;
  let fuzzyNotice: string | null = null;

  if (result.items.length === 0 && !params.cursor && mode !== "regex") {
    const fuzzy = sharedFinder.grep(params.pattern, {
      mode: "fuzzy", smartCase,
      maxMatchesPerFile: Math.min(effectiveLimit, 50),
      cursor: null, beforeContext: 0, afterContext: 0, classifyDefinitions: true,
    });
    if (fuzzy.ok && fuzzy.value.items.length > 0) { fuzzyNotice = "0 exact matches. Maybe you meant this?"; result = fuzzy.value; }
  }

  let output = fffFormatGrep(result);
  const notices: string[] = [];
  if (result.regexFallbackError) notices.push(`Invalid regex: ${result.regexFallbackError}, used literal match`);
  if (result.nextCursor)         notices.push(`Continue with cursor="${fffStoreCursor(result.nextCursor)}"`);
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
  if (fuzzyNotice)        output  = `[${fuzzyNotice}]\n${output}`;
  return output;
}

async function opFfffind(params: Record<string, any>, cwd: string): Promise<string> {
  if (!sharedFinder || sharedFinder.isDestroyed)
    throw new Error("fff finder not available — is extensions/fff loaded?");

  const resumed        = params.cursor ? fffFindCursorCache.get(params.cursor) : undefined;
  const effectiveLimit = resumed ? resumed.pageSize : Math.max(1, params.limit ?? 30);
  const query          = resumed ? resumed.query    : buildQuery(params.path, params.pattern, params.exclude, cwd);
  const pattern        = resumed ? resumed.pattern  : params.pattern;
  const pageIndex      = resumed?.nextPageIndex ?? 0;

  const r = sharedFinder.fileSearch(query, { pageIndex, pageSize: effectiveLimit });
  if (!r.ok) throw new Error(r.error);

  const result     = r.value;
  const topScore   = result.scores[0]?.total ?? 0;
  const weak       = topScore < Math.floor((pattern.length * 12 * 50) / 100);
  const cap        = weak ? Math.min(5, effectiveLimit) : effectiveLimit;
  const shown      = result.items.slice(0, cap);
  let output       = shown.length === 0
    ? "No files found matching pattern"
    : shown.map((item: any) => `${item.relativePath}${fffAnnotation(item)}`).join("\n");

  const shownSoFar = pageIndex * effectiveLimit + result.items.length;
  const hasMore    = result.items.length >= effectiveLimit && result.totalMatched > shownSoFar;
  const notices: string[] = [];
  if (weak && shown.length > 0) {
    notices.push(`Query "${pattern}" produced only weak scattered fuzzy matches. Output capped at ${shown.length}/${result.totalMatched}.`);
  }
  if (!weak && hasMore) {
    const remaining = result.totalMatched - shownSoFar;
    const cursorId  = fffStoreFindCursor({ query, pattern, pageSize: effectiveLimit, nextPageIndex: pageIndex + 1 });
    notices.push(`${remaining} more match${remaining === 1 ? "" : "es"} available. cursor="${cursorId}" to continue`);
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
  return output;
}

// ── agenda_create implementation ────────────────────────────────────────────

async function opAgendaCreate(params: Record<string, any>, cwd: string): Promise<string> {
  const project = typeof params.project === "string" ? params.project : undefined;
  const handle  = openDb(project, cwd);
  try {
    const title       = String(params.title ?? "").trim();
    const description = String(params.description ?? "").trim();
    const guard       = String(params.acceptanceGuard ?? "").trim();
    if (!title) throw new Error("Title is required");
    if (!guard) throw new Error("acceptanceGuard is required");

    const notes          = normalizeNotes(params.tasks);
    const rawDiscoveries = Array.isArray(params.discoveries) ? params.discoveries : [];
    const now            = nowIso();
    let discoveryCount   = 0;

    const agendaId = runTx(handle.db, () => {
      const info = handle.db
        .prepare(
          `INSERT INTO agendas (title, description, acceptance_guard, state, revision, created_at, updated_at)
           VALUES (?, ?, ?, 'not_started', 0, ?, ?)`,
        )
        .run(title, description, guard, now, now);

      const id = Number(info.lastInsertRowid);

      if (notes.length > 0) {
        const stmt = handle.db.prepare(
          `INSERT INTO tasks (agenda_id, task_order, note, state, created_at, updated_at)
           VALUES (?, ?, ?, 'not_started', ?, ?)`,
        );
        let order = 1;
        for (const note of notes) {
          stmt.run(id, order, note, now, now);
          order += 1;
        }
      }

      if (rawDiscoveries.length > 0) {
        const dstmt = handle.db.prepare(
          `INSERT INTO agenda_discoveries (agenda_id, category, title, detail, outcome, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        const validCategories = new Set(DISCOVERY_CATEGORIES);
        const validOutcomes   = new Set(DISCOVERY_OUTCOMES);
        for (const d of rawDiscoveries) {
          const cat     = String(d.category ?? "").trim();
          const dtitle  = String(d.title ?? "").trim();
          const detail  = String(d.detail ?? "").trim();
          const outcome = String(d.outcome ?? "neutral").trim();
          const source  = String(d.source ?? "").trim();
          if (!validCategories.has(cat as any)) throw new Error(`Invalid discovery category: ${cat}. Must be one of: code, web, library, finding`);
          if (!dtitle) throw new Error("Discovery title is required");
          if (!validOutcomes.has(outcome as any)) throw new Error(`Invalid discovery outcome: ${outcome}. Must be one of: expected, unexpected, neutral`);
          dstmt.run(id, cat, dtitle, detail, outcome, source, now);
          discoveryCount += 1;
        }
      }

      return id;
    });

    return `created agenda id=${agendaId} (tasks=${notes.length}, discoveries=${discoveryCount})`;
  } finally {
    handle.db.close();
  }
}

// ── agenda_discovery implementations ───────────────────────────────────────

async function opAgendaDiscovery(toolName: string, params: Record<string, any>, cwd: string): Promise<string> {
  const project = typeof params.project === "string" ? params.project : undefined;
  const handle  = openDb(project, cwd);
  try {
    switch (toolName) {
      case "agenda_discovery_add": {
        const agendaId = agendaToPositiveInt(params.agendaId, "Agenda ID");
        const agenda   = getAgenda(handle.db, agendaId);
        requireAgendaInProgress(agenda);
        const cat     = String(params.category ?? "").trim();
        const title   = String(params.title ?? "").trim();
        const detail  = String(params.detail ?? "").trim();
        const outcome = String(params.outcome ?? "neutral").trim();
        const source  = String(params.source ?? "").trim();
        if (!(DISCOVERY_CATEGORIES as readonly string[]).includes(cat))
          throw new Error(`Invalid category: ${cat}. Must be one of: code, web, library, finding`);
        if (!title) throw new Error("title is required");
        if (!(DISCOVERY_OUTCOMES as readonly string[]).includes(outcome))
          throw new Error(`Invalid outcome: ${outcome}. Must be one of: expected, unexpected, neutral`);
        const info = handle.db
          .prepare(
            `INSERT INTO agenda_discoveries (agenda_id, category, title, detail, outcome, source, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(agendaId, cat, title, detail, outcome, source, nowIso());
        return `agenda ${agendaId}: discovery added (id=${Number(info.lastInsertRowid)})`;
      }
      case "agenda_discovery_get": {
        const agendaId    = agendaToPositiveInt(params.agendaId, "Agenda ID");
        const discoveryId = agendaToPositiveInt(params.discoveryId, "Discovery ID");
        return formatDiscovery(getDiscovery(handle.db, discoveryId, agendaId));
      }
      case "agenda_discovery_list": {
        const agendaId = agendaToPositiveInt(params.agendaId, "Agenda ID");
        getAgenda(handle.db, agendaId);
        const cat = typeof params.category === "string" ? params.category.trim() : undefined;
        if (cat !== undefined && !(DISCOVERY_CATEGORIES as readonly string[]).includes(cat))
          throw new Error(`Invalid category: ${cat}. Must be one of: code, web, library, finding`);
        return formatDiscoveryList(getDiscoveries(handle.db, agendaId, cat as any));
      }
      case "agenda_discovery_delete": {
        const agendaId    = agendaToPositiveInt(params.agendaId, "Agenda ID");
        const discoveryId = agendaToPositiveInt(params.discoveryId, "Discovery ID");
        const agenda      = getAgenda(handle.db, agendaId);
        if (agenda.state === "completed") throw new Error("Completed agendas are immutable — cannot delete discoveries");
        getDiscovery(handle.db, discoveryId, agendaId);
        handle.db.prepare(`DELETE FROM agenda_discoveries WHERE id = ?`).run(discoveryId);
        return `agenda ${agendaId}: discovery ${discoveryId} deleted`;
      }
      default:
        throw new Error(`Unknown agenda discovery tool: ${toolName}`);
    }
  } finally {
    handle.db.close();
  }
}

// ── Extension tool dispatch ──────────────────────────────────────────────────

const CODE_MAP_TOOLS = new Set([
  "code_map_outline", "code_map_symbol", "code_map_diagnostics", "code_map_impact",
]);

/**
 * Memory tools that mutate files — blacklisted from parallel to prevent corruption.
 * Concurrent writes to the same markdown file can produce duplicate sections or
 * interleaved content. Call these sequentially via the native tools instead.
 */
const MEMORY_WRITE_BLACKLIST = new Set([
  "memory_new", "memory_update", "memory_delete",
]);

/** agenda_create — safe for parallel (SQLite WAL serialises writes). */
const AGENDA_CREATE_TOOLS = new Set(["agenda_create"]);

/** Agenda discovery tools — safe for parallel (SQLite WAL serialises writes). */
const AGENDA_DISCOVERY_TOOLS = AGENDA_DISCOVERY_TOOL_NAMES;

/** fff search tools — share the FileFinder singleton from extensions/fff via pi.events. */
const FFF_TOOLS = new Set(["ffgrep", "fffind"]);

/** Memory tools safe for concurrent execution (read-only or independent file ops). */
const MEMORY_TOOLS = new Set([
  "memory_list", "memory_get", "memory_search",
  "memory_create_file", "memory_delete_file", "memory_validate_file",
]);

async function opExtension(
  toolName: string,
  call: Record<string, any>,
  toolCallId: string,
  index: number,
  signal: AbortSignal | undefined,
  cwd: string,
): Promise<string> {
  const { tool: _name, ...params } = call;

  if (toolName === "ptc") {
    return opPtc(params as any, toolCallId, index, signal);
  }
  if (toolName === "mcporter") {
    return opMcporter(params);
  }
  if (CODE_MAP_TOOLS.has(toolName)) {
    return opCodeMap(toolName, params, cwd);
  }
  if (AGENDA_CREATE_TOOLS.has(toolName)) {
    return opAgendaCreate(params, cwd);
  }
  if (AGENDA_DISCOVERY_TOOLS.has(toolName)) {
    return opAgendaDiscovery(toolName, params, cwd);
  }
  if (MEMORY_WRITE_BLACKLIST.has(toolName)) {
    throw new Error(
      `"${toolName}" is not allowed inside parallel — concurrent writes corrupt memory files. ` +
      `Call ${toolName} sequentially using the native tool instead.`,
    );
  }
  if (MEMORY_TOOLS.has(toolName)) {
    return opMemory(toolName, params, cwd);
  }

  if (FFF_TOOLS.has(toolName)) {
    if (toolName === "ffgrep") return opFfgrep(params, cwd);
    return opFfffind(params, cwd);
  }

  const supported = ["ptc", "mcporter", ...CODE_MAP_TOOLS, ...MEMORY_TOOLS, ...AGENDA_CREATE_TOOLS, ...AGENDA_DISCOVERY_TOOLS, ...FFF_TOOLS].join(", ");
  throw new Error(`Unsupported tool in parallel: "${toolName}". Supported: ${supported}`);
}

// ── System prompt ────────────────────────────────────────────────────────────

const BASE_INSTRUCTION = `
## Parallel tool calls

\`parallel\` is a meta tool. \`ptc\` remains the default tool.

Prefer creating scripts and executing them with \`ptc\` — including bash scripts for shell-heavy work — whenever the task would otherwise take multiple tool calls. Use a raw \`bash\` slot only when that command is genuinely one-shot.

Reach for \`parallel\` when you have 2+ independent operations to fan out in one call. Results come
back together, and you can combine or process them after the call. For Python \`ptc\` slots, prefer
Python + uv by default and only choose bash when the task is clearly pure shell; require
\`#!/usr/bin/env -S uv run --script\` at the top of Python scripts. Supported ops:

- Common native ops: \`read\` / \`bash\` / \`write\` / \`edit\` (use raw \`bash\` only for one-shot commands)
- Any supported extension tool (including \`ptc\`, \`mcporter\`) — pass \`tool: "<name>"\` plus the tool's normal args as additional fields
- Python \`ptc\` slots execute the saved script file directly so the shebang triggers \`uv run --script\`
- Prefer uv-backed Python scripts because uv is robust at dependency management and its cache makes repeated runs very fast
- \`ffgrep\` and \`fffind\` are supported when the fff extension is loaded

Typical pattern: fan out several independent \`read\`, \`ptc\`, or other extension-tool calls, get all
results back in one shot, then decide what to do. Use a raw \`bash\` slot only for a one-shot shell command; otherwise prefer a bash script via \`ptc\`.

### edit safety
\`parallel\`'s \`edit\` op does **not** use the native mutation queue. Do not include two \`edit\`
calls targeting the same file in one \`parallel\` invocation — use the native \`edit\` tool for that instead.

### memory write safety
\`memory_new\`, \`memory_update\`, and \`memory_delete\` are **not allowed** inside \`parallel\`.
Concurrent writes corrupt the markdown-backed memory files (duplicate sections, interleaved content).
Call them sequentially via the native memory tools instead.

### agenda_create
\`agenda_create\` is supported inside \`parallel\`. SQLite WAL mode safely serialises concurrent writes.

### agenda discovery tools
\`agenda_discovery_add\`, \`agenda_discovery_get\`, \`agenda_discovery_list\`, and \`agenda_discovery_delete\` are supported inside \`parallel\`.
SQLite WAL mode safely serialises concurrent writes, so all four tools can be fanned out freely.
`.trim();

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name:  "parallel",
    label: "Parallel Calls",
    description:
      "Fan out multiple independent operations in one tool call. Common slots are read, bash, write, edit, and ptc; any supported extension tool can also be inlined. Prefer ptc scripts by default — including bash scripts for shell-heavy work — and use a raw bash slot only when the command is genuinely one-shot. Prefer Python + uv for ptc scripts by default: uv-backed Python scripts are executed directly by file path, must start with `#!/usr/bin/env -S uv run --script`, and benefit from robust dependency management plus fast cached reruns. All calls run concurrently and results are returned together.",
    promptSnippet:
      "Run multiple independent operations concurrently in a single call, including ptc slots and other supported extension tools. Prefer ptc scripts by default — including bash scripts for shell-heavy work — and use a raw bash slot only when the command is genuinely one-shot. Prefer Python + uv for ptc scripts by default. Uv-backed Python ptc scripts execute directly by file path and must start with `#!/usr/bin/env -S uv run --script`.",
    parameters: Type.Object({
      calls: Type.Array(CallSpec, {
        description:
          "Operations to execute in parallel. Each item must specify a tool and its arguments.",
        minItems: 2,
      }),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const calls     = params.calls as any[];
      const toolNames = calls.map((c) => String(c.tool)).join(", ");

      onUpdate?.({ content: [{ type: "text", text: "Running..." }], details: undefined });

      type CallResult = { tool: string; index: number; ok: boolean; output: string };

      const results: CallResult[] = await Promise.all(
        calls.map(async (call, index): Promise<CallResult> => {
          try {
            let output: string;
            switch (call.tool) {
              case "read":  output = opRead(call.path, ctx.cwd, call.offset, call.limit); break;
              case "bash":  output = await opBash(call.command, call.timeout, call.stdin); break;
              case "write": output = opWrite(call.path, call.content, ctx.cwd); break;
              case "edit":  output = opEdit(call.path, call.edits, ctx.cwd); break;
              default:      output = await opExtension(call.tool, call, toolCallId, index, signal, ctx.cwd); break;
            }
            return { tool: call.tool, index, ok: true, output };
          } catch (err: any) {
            return { tool: call.tool, index, ok: false, output: err.message ?? String(err) };
          }
        }),
      );

      const parts = results.map((r) => {
        const status = r.ok ? "" : " ❌ ERROR";
        return `[${r.index}] ${r.tool}${status}\n${r.output}`;
      });

      const errorCount = results.filter((r) => !r.ok).length;
      const header     = `parallel: ${calls.length} tools\nRunning: ${toolNames}`;

      return {
        content: [{ type: "text", text: `${header}\n\n${parts.join("\n\n---\n\n")}` }],
        details: { totalCalls: calls.length, errors: errorCount, results },
        isError: errorCount === results.length,
      };
    },
  });

  // Receive the shared FileFinder from extensions/fff
  pi.events.on("fff:finder", (data: any) => {
    sharedFinder = data.finder as FileFinder;
  });

  // Request the finder on session start (in case fff initialised before us)
  pi.on("session_start", async () => {
    pi.events.emit("fff:request", null);
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${BASE_INSTRUCTION}`,
  }));
}
