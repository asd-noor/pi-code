/**
 * parallel.ts — Parallel tool calling.
 *
 * Registers a single `parallel` tool that fans out multiple operations
 * (read, bash, write, edit, ptc) in one call, executing them concurrently via
 * Promise.all and returning all results together.
 *
 * Use when operations are independent of each other. For dependent operations,
 * use sequential individual tool calls.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

const execAsync     = promisify(exec);
const execFileAsync = promisify(execFile);
const SANDBOX_DIR   = "/tmp/pi-sandbox";

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
  tool:   Type.Literal("ptc"),
  type:   StringEnum(["python", "bash"] as const, {
    description: "Script type. Prefer python unless the task is pure shell.",
  }),
  script: Type.String({ description: "Full script content. Python scripts must include a PEP 723 metadata block." }),
  args:   Type.Optional(Type.Array(Type.String(), { description: "Command-line arguments passed to the script." })),
  stdin:  Type.Optional(Type.String({ description: "Data to pipe to the script's stdin." })),
});

const CallSpec = Type.Union([ReadCall, BashCall, WriteCall, EditCall, PtcCall]);

// ── Operation implementations ────────────────────────────────────────────────

function opRead(path: string, cwd: string, offset?: number, limit?: number): string {
  const fullPath = resolve(cwd, path);
  const lines = readFileSync(fullPath, "utf8").split("\n");
  const start = offset != null ? Math.max(0, offset - 1) : 0;
  const end   = limit  != null ? start + limit : lines.length;
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

async function opPtc(
  type: "python" | "bash",
  script: string,
  callKey: string,
  args?: string[],
  stdin?: string,
): Promise<string> {
  mkdirSync(SANDBOX_DIR, { recursive: true });
  const ext  = type === "python" ? "py" : "sh";
  const file = `${SANDBOX_DIR}/${callKey}.${ext}`;
  writeFileSync(file, script, { mode: 0o755 });
  const cmd  = type === "python" ? "uv" : "bash";
  const argv = type === "python" ? ["run", file, ...(args ?? [])] : [file, ...(args ?? [])];
  const result = await execFileAsync(cmd, argv, {
    input:     stdin,
    timeout:   120_000,
    maxBuffer: 10 * 1024 * 1024,
  } as any);
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim() || "(no output)";
}

// ── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTION = `
## Parallel tool calls

\`parallel\` is a meta tool. \`ptc\` remains the default for all work.

Reach for \`parallel\` when you have 2+ independent operations whose results don't need to be
combined or processed — just returned together. Supported ops:

- \`read\` / \`bash\` / \`write\` / \`edit\` — native ops, run directly
- \`ptc\` — run a Python or bash script as one slot in the parallel fan-out (same semantics as the \`ptc\` tool)

Typical pattern: fan out several \`read\` or \`ptc\` calls that are each independent, get all
results back in one shot, then decide what to do.

### edit safety
\`parallel\`'s \`edit\` op does **not** use the native mutation queue. Do not include two \`edit\`
calls targeting the same file in one \`parallel\` invocation — use the native \`edit\` tool for that instead.
`.trim();

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name:          "parallel",
    label:         "Parallel Calls",
    description:   `Fan out multiple operations (read, bash, write, edit, ptc) in one tool call. All run concurrently; results are returned together. Use when calls are independent of each other.`,
    promptSnippet: "Run multiple independent read/bash/write/edit/ptc operations concurrently in a single call.",
    parameters: Type.Object({
      calls: Type.Array(CallSpec, {
        description: "Operations to execute in parallel. Each item must specify a tool and its arguments.",
        minItems: 2,
      }),
    }),

    renderCall(args, theme, _context) {
      const toolNames = args.calls.map((call: any) => String(call.tool)).join(", ");
      let text = theme.fg("toolTitle", theme.bold("parallel "));
      text += theme.fg("accent", toolNames);
      return new Text(text, 0, 0);
    },

    renderResult(result, { isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);

      const toolNames = context.args.calls.map((call: any) => String(call.tool)).join(", ");
      const content = result.content.find((entry) => entry.type === "text");
      const rawText = content?.type === "text" ? content.text : "(no output)";
      const lines = rawText.split("\n");
      if (lines[0]?.startsWith("Parallel operations:")) lines.shift();
      const body = lines.join("\n").trim();

      let text = theme.fg("toolTitle", theme.bold("Parallel operations: "));
      text += theme.fg("accent", toolNames);
      if (body) text += `\n\n${theme.fg("toolOutput", body)}`;
      return new Text(text, 0, 0);
    },

    async execute(toolCallId, params, _signal, onUpdate, ctx) {
      const calls = params.calls as any[];

      const toolNames = calls.map((call) => String(call.tool)).join(", ");

      onUpdate?.({
        content: [{ type: "text", text: "Running..." }],
        details: undefined,
      });

      type CallResult = { tool: string; index: number; ok: boolean; output: string; error?: string };

      const results: CallResult[] = await Promise.all(
        calls.map(async (call, index): Promise<CallResult> => {
          try {
            let output: string;
            switch (call.tool) {
              case "read":  output = opRead(call.path, ctx.cwd, call.offset, call.limit); break;
              case "bash":  output = await opBash(call.command, call.timeout, call.stdin); break;
              case "write": output = opWrite(call.path, call.content, ctx.cwd); break;
              case "edit":  output = opEdit(call.path, call.edits, ctx.cwd); break;
              case "ptc":   output = await opPtc(call.type, call.script, `${toolCallId.slice(0, 8)}-${index}`, call.args, call.stdin); break;
              default:      throw new Error(`Unknown tool: ${call.tool}`);
            }
            return { tool: call.tool, index, ok: true, output };
          } catch (err: any) {
            return { tool: call.tool, index, ok: false, output: "", error: err.message ?? String(err) };
          }
        }),
      );

      const parts = results.map((r) => {
        const status = r.ok ? "" : " ❌ ERROR";
        const body   = r.ok ? r.output : r.error!;
        return `[${r.index}] ${r.tool}${status}\n${body}`;
      });

      const errorCount = results.filter((r) => !r.ok).length;
      const allFailed  = errorCount === results.length;
      const header     = `Parallel operations: ${toolNames}`;

      return {
        content:  [{ type: "text", text: `${header}\n\n${parts.join("\n\n---\n\n")}` }],
        details:  { totalCalls: calls.length, errors: errorCount, results },
        isError:  allFailed,
      };
    },
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${SYSTEM_INSTRUCTION}`,
  }));
}
