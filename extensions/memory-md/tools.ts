import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ExecFn = ExtensionAPI["exec"];

// ── Shell helpers ─────────────────────────────────────────────────────────────

/** Single-quote a string for safe shell interpolation. */
function q(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Run a memory-md subcommand via bash with MEMORY_MD_DIR set. */
async function run(
  memDir: string,
  args: string[],
  exec: ExecFn,
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; code: number; ok: boolean }> {
  const cmd    = `MEMORY_MD_DIR=${q(memDir)} memory-md ${args.map(q).join(" ")}`;
  const result = await exec("bash", ["-c", cmd], { timeout: timeoutMs });
  return { ...result, ok: result.code === 0 };
}

/** Run a memory-md subcommand that reads the body from stdin (new / update). */
async function runWithInput(memDir: string, args: string[], body: string): Promise<string> {
  const result = await execFileAsync("memory-md", args, {
    input:   body,
    env:     { ...process.env, MEMORY_MD_DIR: memDir },
    timeout: 15_000,
  });
  return result.stdout;
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t.trim() || "(no output)" }] };
}

// ── Tool registration ─────────────────────────────────────────────────────────

export function registerTools(pi: ExtensionAPI, getDir: () => string | undefined): void {

  // ── memory_list ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name:        "memory_list",
    label:       "Memory: List",
    description: "List all memory files, or list all section paths within a named file (in document order). Use to browse what's stored before getting or searching.",
    promptSnippet: "List memory files or sections within a file",
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "File name (without .md) to list sections of. Omit to list all files." })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const dir = getDir() ?? ctx.cwd;
      const args = params.file ? ["list", params.file] : ["list"];
      const res  = await run(dir, args, pi.exec.bind(pi));
      return text(res.ok ? res.stdout : `Error: ${res.stderr || res.stdout}`);
    },
  });

  // ── memory_get ──────────────────────────────────────────────────────────────

  pi.registerTool({
    name:        "memory_get",
    label:       "Memory: Get",
    description: "Exact path lookup — retrieve a section by its full path (e.g. auth/api-keys/rotation-policy). Use when you know the exact path. Use memory_search when unsure.",
    promptSnippet: "Retrieve a memory section by exact path",
    parameters: Type.Object({
      path: Type.String({ description: "Full section path, e.g. auth/api-keys or auth/api-keys/rotation-policy." }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const dir = getDir() ?? ctx.cwd;
      const res = await run(dir, ["get", params.path], pi.exec.bind(pi));
      return text(res.ok ? res.stdout : `Error: ${res.stderr || res.stdout}`);
    },
  });

  // ── memory_search ───────────────────────────────────────────────────────────

  pi.registerTool({
    name:        "memory_search",
    label:       "Memory: Search",
    description: "Hybrid FTS5 + vector search across all stored memories. Use when you don't know the exact path or want to find semantically related sections. Returns up to top-N results.",
    promptSnippet: "Search memory using full-text + vector search",
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      top:   Type.Optional(Type.Number({ description: "Max results to return. Default: 5.", minimum: 1 })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const dir  = getDir() ?? ctx.cwd;
      const args = ["search", params.query, "--top", String(params.top ?? 5)];
      const res  = await run(dir, args, pi.exec.bind(pi));
      return text(res.ok ? res.stdout : `Error: ${res.stderr || res.stdout}`);
    },
  });

  // ── memory_new ──────────────────────────────────────────────────────────────

  pi.registerTool({
    name:        "memory_new",
    label:       "Memory: New",
    description: "Create a new memory section. The file must already exist (use memory_create_file first). Fails if the section already exists — use memory_update to overwrite. The heading level is derived automatically from path depth.",
    promptSnippet: "Create a new memory section",
    parameters: Type.Object({
      path:    Type.String({ description: "Full section path, e.g. auth/api-keys." }),
      body:    Type.String({ description: "Body content for the section." }),
      heading: Type.Optional(Type.String({ description: "Human-readable heading. Defaults to the last path segment." })),
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      const dir  = getDir();
      if (!dir) return text("Error: memory-md directory not configured.");
      const args = ["new", params.path];
      if (params.heading) args.push("--heading", params.heading);
      try {
        const out = await runWithInput(dir, args, params.body);
        return text(out || "Section created.");
      } catch (err: any) {
        return text(`Error: ${err.message}`);
      }
    },
  });

  // ── memory_update ───────────────────────────────────────────────────────────

  pi.registerTool({
    name:        "memory_update",
    label:       "Memory: Update",
    description: "Replace the body of an existing section. Child sections are preserved. Use when correcting or updating stored information.",
    promptSnippet: "Update the body of an existing memory section",
    parameters: Type.Object({
      path: Type.String({ description: "Full section path to update." }),
      body: Type.String({ description: "New body content." }),
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      const dir = getDir();
      if (!dir) return text("Error: memory-md directory not configured.");
      try {
        const out = await runWithInput(dir, ["update", params.path], params.body);
        return text(out || "Section updated.");
      } catch (err: any) {
        return text(`Error: ${err.message}`);
      }
    },
  });

  // ── memory_delete ───────────────────────────────────────────────────────────

  pi.registerTool({
    name:        "memory_delete",
    label:       "Memory: Delete",
    description: "Delete a section and all its children. Use when removing outdated or incorrect information.",
    promptSnippet: "Delete a memory section and its children",
    parameters: Type.Object({
      path: Type.String({ description: "Full section path to delete." }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const dir = getDir() ?? ctx.cwd;
      const res = await run(dir, ["delete", params.path], pi.exec.bind(pi));
      return text(res.ok ? "Section deleted." : `Error: ${res.stderr || res.stdout}`);
    },
  });

  // ── memory_create_file ──────────────────────────────────────────────────────

  pi.registerTool({
    name:        "memory_create_file",
    label:       "Memory: Create File",
    description: "Create a new empty memory file (topic area). Must be done before adding sections with memory_new. Name must not contain '/', must not start with '.', and must not include '.md'.",
    promptSnippet: "Create a new memory file (topic area)",
    parameters: Type.Object({
      name: Type.String({ description: "File name without .md extension, e.g. 'auth' or 'infra'." }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const dir = getDir() ?? ctx.cwd;
      const res = await run(dir, ["create-file", params.name], pi.exec.bind(pi));
      return text(res.ok ? `File '${params.name}.md' created.` : `Error: ${res.stderr || res.stdout}`);
    },
  });

  // ── memory_delete_file ──────────────────────────────────────────────────────

  pi.registerTool({
    name:        "memory_delete_file",
    label:       "Memory: Delete File",
    description: "Delete an entire memory file and all its sections. This is permanent.",
    promptSnippet: "Delete an entire memory file and all its sections",
    parameters: Type.Object({
      name: Type.String({ description: "File name without .md extension." }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const dir = getDir() ?? ctx.cwd;
      const res = await run(dir, ["delete-file", params.name], pi.exec.bind(pi));
      return text(res.ok ? `File '${params.name}.md' deleted.` : `Error: ${res.stderr || res.stdout}`);
    },
  });

  // ── memory_validate_file ───────────────────────────────────────────────────────

  pi.registerTool({
    name:          "memory_validate_file",
    label:         "Memory: Validate File",
    description:   "Check structural rules of a memory file: duplicate paths, skipped heading levels, multiple title headings. Use after bulk writes or before trusting a file's structure.",
    promptSnippet: "Validate the structure of a memory file",
    parameters: Type.Object({
      name: Type.String({ description: "File name without .md extension." }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const dir = getDir() ?? ctx.cwd;
      const res = await run(dir, ["validate-file", params.name], pi.exec.bind(pi));
      return text(res.stdout || res.stderr || "(no output)");
    },
  });
}
