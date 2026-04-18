/**
 * _parallel.ts — Parallel tool calling with dynamic extension tool support.
 *
 * Named with a leading underscore so it is loaded before other extensions
 * (alphabetical order: `_` sorts before any letter). This ensures the
 * monkey-patch on `pi.registerTool` is in place before other extensions
 * register their tools, letting us capture every extension-provided
 * execute function.
 *
 * Registers a single `parallel` tool that fans out multiple operations
 * (read, bash, write, edit, ptc, or any extension-registered tool) in one
 * call, executing them concurrently via Promise.all and returning all results
 * together.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ── Extension tool registry ──────────────────────────────────────────────────

type ToolExecuteFn = (
  toolCallId: string,
  params: any,
  signal: AbortSignal | undefined,
  onUpdate: ((update: any) => void) | undefined,
  ctx: any,
) => Promise<any>;

/**
 * Captured execute functions from extension-registered tools.
 * Populated via the monkey-patch on pi.registerTool below.
 */
const extensionTools = new Map<string, ToolExecuteFn>();

/** Tools implemented natively in this file — never delegated to extensionTools. */
const NATIVE_TOOLS = new Set(["read", "bash", "write", "edit", "parallel"]);

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

/**
 * Catch-all for any extension-registered tool.
 * The `tool` field names the tool; all other fields are passed as params.
 * The LLM already knows each extension tool's parameter schema from the
 * system prompt — it should use that schema directly, adding a `tool` field.
 */
const ExtCall = Type.Object(
  {
    tool: Type.String({
      description:
        "Name of an extension-provided tool available in this session (e.g. 'memory_new', 'agenda_create'). " +
        "Pass the tool's normal arguments as additional fields alongside `tool`.",
    }),
  },
  { additionalProperties: true },
);

const CallSpec = Type.Union([ReadCall, BashCall, WriteCall, EditCall, ExtCall]);

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

async function opExtension(
  toolName: string,
  call: Record<string, any>,
  toolCallId: string,
  index: number,
  signal: AbortSignal | undefined,
  ctx: any,
): Promise<string> {
  const fn = extensionTools.get(toolName);
  if (!fn) {
    const available = [...extensionTools.keys()].join(", ") || "none";
    throw new Error(`Unknown tool: "${toolName}". Available extension tools: ${available}`);
  }
  // Strip the 'tool' discriminator field; pass remaining fields as the tool's params.
  const { tool: _name, ...params } = call;
  const result = await fn(`${toolCallId}-${index}`, params, signal, undefined, ctx);
  // Extract text content from the result.
  const text = (result?.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text as string)
    .join("\n");
  return text || JSON.stringify(result?.content ?? result ?? "(no output)");
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
  // ── Monkey-patch pi.registerTool to capture extension execute functions ──
  //
  // Because _parallel.ts is loaded first (underscore sorts before letters),
  // this patch is in place before any other extension's factory function runs.
  // Every subsequent pi.registerTool() call passes through here, letting us
  // stash the execute function for later dispatch.
  const _origRegisterTool = pi.registerTool.bind(pi);
  (pi as any).registerTool = function (def: any) {
    if (def?.name && typeof def.execute === "function" && !NATIVE_TOOLS.has(def.name)) {
      extensionTools.set(def.name, def.execute);
    }
    return _origRegisterTool(def);
  };

  // ── Register the parallel tool ──────────────────────────────────────────
  pi.registerTool({
    name:  "parallel",
    label: "Parallel Calls",
    description:
      "Fan out multiple operations (read, bash, write, edit, or any extension-provided tool) in one tool call. All run concurrently; results are returned together. Use when calls are independent of each other.",
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
      const calls = params.calls as any[];
      const toolNames = calls.map((c) => String(c.tool)).join(", ");

      onUpdate?.({ content: [{ type: "text", text: "Running..." }], details: undefined });

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
              default:      output = await opExtension(call.tool, call, toolCallId, index, signal, ctx); break;
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
      const header = `parallel: ${calls.length} tools\nRunning: ${toolNames}`;

      return {
        content: [{ type: "text", text: `${header}\n\n${parts.join("\n\n---\n\n")}` }],
        details: { totalCalls: calls.length, errors: errorCount, results },
        isError: allFailed,
      };
    },
  });

  // ── Inject system prompt instruction ────────────────────────────────────
  pi.on("before_agent_start", async (event) => {
    // Build the extension tool list at turn-start time — captures any tools
    // registered late (e.g. via commands like /add-echo-tool).
    const extNames = [...extensionTools.keys()];
    const extLine  = extNames.length > 0
      ? `\nCurrently available extension tools for use in \`parallel\`: ${extNames.join(", ")}`
      : "";

    return {
      systemPrompt: `${event.systemPrompt}\n\n${BASE_INSTRUCTION}${extLine}`,
    };
  });
}
