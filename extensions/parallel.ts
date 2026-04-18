/**
 * parallel.ts — Parallel tool calling with inlined tool implementations.
 *
 * Registers a `parallel` meta tool that fans out multiple independent
 * operations concurrently via Promise.all and returns all results together.
 *
 * Supported operations:
 *   Native:  read, bash, write, edit
 *   Inlined: ptc
 *            code_map_outline, code_map_symbol, code_map_diagnostics, code_map_impact
 *            memory_list, memory_get, memory_search, memory_new, memory_update,
 *            memory_delete, memory_create_file, memory_delete_file, memory_validate_file
 *
 * No monkey-patching. All supported non-native tools are implemented directly
 * in this file, using the same logic as their respective extensions.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { SocketClient } from "./code-map/client.ts";

const execAsync     = promisify(exec);
const execFileAsync = promisify(execFile);
const SANDBOX_DIR   = "/tmp/pi-sandbox";

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

// ── Call spec schemas ────────────────────────────────────────────────────────

const ReadCall = Type.Object({
  tool:   Type.Literal("read"),
  path:   Type.String({ description: "Path to file (relative or absolute)." }),
  offset: Type.Optional(Type.Number({ description: "Line to start from (1-indexed)." })),
  limit:  Type.Optional(Type.Number({ description: "Max lines to read." })),
});

const BashCall = Type.Object({
  tool:    Type.Literal("bash"),
  command: Type.String({ description: "Bash command to execute." }),
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
  script:  Type.String({ description: "Full script content. Python scripts must include a PEP 723 metadata block." }),
  args:    Type.Optional(Type.Array(Type.String(), { description: "Command-line arguments passed to the script." })),
  stdin:   Type.Optional(Type.String({ description: "Data to pipe to the script's stdin." })),
});

/**
 * Catch-all for inlined extension tools (code_map_*, memory_*).
 * The `tool` field names the tool; all other fields are passed as params.
 */
const ExtCall = Type.Object(
  {
    tool: Type.String({
      description:
        "Name of a supported inlined tool: " +
        "code_map_outline, code_map_symbol, code_map_diagnostics, code_map_impact, " +
        "memory_list, memory_get, memory_search, memory_validate_file. " +
        "Write tools (memory_new, memory_update, memory_delete, memory_create_file, memory_delete_file) " +
        "must be called sequentially — concurrent writes can corrupt the memory file. " +
        "Pass the tool's normal arguments as additional fields alongside `tool`.",
    }),
  },
  { additionalProperties: true },
);

const CallSpec = Type.Union([ReadCall, BashCall, WriteCall, EditCall, PtcCall, ExtCall]);

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

  const cmd  = call.type === "python" ? "uv" : "bash";
  const args = call.type === "python"
    ? ["run", file, ...(call.args ?? [])]
    : [file,        ...(call.args ?? [])];

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

// ── code_map implementations ─────────────────────────────────────────────────

async function opCodeMap(toolName: string, params: Record<string, any>, cwd: string): Promise<string> {
  const client = new SocketClient(cwd);
  switch (toolName) {
    case "code_map_outline": {
      const rows = await client.query<any[]>("outline", { file: params.file });
      return rows.length ? JSON.stringify(rows, null, 2) : "(no symbols found)";
    }
    case "code_map_symbol": {
      const rows = await client.query<any[]>("symbol", { name: params.name, withSource: params.source ?? false });
      return rows.length ? JSON.stringify(rows, null, 2) : `(no symbol found: ${params.name})`;
    }
    case "code_map_diagnostics": {
      const rows = await client.query<any[]>("diagnostics", {
        ...(params.file ? { file: params.file } : {}),
        severity: params.severity ?? 0,
      });
      return rows.length ? JSON.stringify(rows, null, 2) : "(no diagnostics)";
    }
    case "code_map_impact": {
      const rows = await client.query<any[]>("impact", { name: params.name });
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

// ── Extension tool dispatch ──────────────────────────────────────────────────

const CODE_MAP_TOOLS = new Set([
  "code_map_outline", "code_map_symbol", "code_map_diagnostics", "code_map_impact",
]);

/** Read-only memory tools safe for concurrent execution. */
const MEMORY_TOOLS = new Set([
  "memory_list", "memory_get", "memory_search", "memory_validate_file",
]);

/** Write memory tools that must NOT run concurrently — they can corrupt the file. */
const MEMORY_WRITE_TOOLS = new Set([
  "memory_new", "memory_update", "memory_delete",
  "memory_create_file", "memory_delete_file",
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
  if (CODE_MAP_TOOLS.has(toolName)) {
    return opCodeMap(toolName, params, cwd);
  }
  if (MEMORY_TOOLS.has(toolName)) {
    return opMemory(toolName, params, cwd);
  }
  if (MEMORY_WRITE_TOOLS.has(toolName)) {
    throw new Error(
      `"${toolName}" writes to the memory file and must not run concurrently — ` +
      `call it sequentially with the native memory tool instead.`,
    );
  }

  const supported = ["ptc", ...CODE_MAP_TOOLS, ...MEMORY_TOOLS].join(", ");
  throw new Error(`Unsupported tool in parallel: "${toolName}". Supported: ${supported}`);
}

// ── System prompt ────────────────────────────────────────────────────────────

const BASE_INSTRUCTION = `
## Parallel tool calls

\`parallel\` is a meta tool. \`ptc\` remains the default for all work.

Reach for \`parallel\` when you have 2+ independent operations whose results don't need to be
combined or processed — just returned together. Supported ops:

- \`read\` / \`bash\` / \`write\` / \`edit\` — native ops, run directly
- Any extension-provided tool (including \`ptc\`) — pass \`tool: "<name>"\` plus the tool's normal args as additional fields

Typical pattern: fan out several \`read\` or \`ptc\` calls that are each independent, get all
results back in one shot, then decide what to do.

### edit safety
\`parallel\`'s \`edit\` op does **not** use the native mutation queue. Do not include two \`edit\`
calls targeting the same file in one \`parallel\` invocation — use the native \`edit\` tool for that instead.
`.trim();

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name:  "parallel",
    label: "Parallel Calls",
    description:
      "Fan out multiple operations (read, bash, write, edit, ptc, or any supported extension tool) in one tool call. All run concurrently; results are returned together. Use when calls are independent of each other.",
    promptSnippet:
      "Run multiple independent read/bash/write/edit/ptc/extension-tool operations concurrently in a single call.",
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

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${BASE_INSTRUCTION}`,
  }));
}
