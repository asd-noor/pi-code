import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MemoryClient } from "./client.ts";

export function registerTools(pi: ExtensionAPI, getProjectRoot: () => string | undefined): void {
  function client(ctx: { cwd: string }): MemoryClient {
    const root = getProjectRoot() ?? ctx.cwd;
    return new MemoryClient(root);
  }

  pi.registerTool({
    name: "memory_list",
    label: "Memory: List",
    description: "List all memory files, or list all section paths within a named file (in document order).",
    promptSnippet: "List memory files or sections within a file",
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "File name (without .md) to list sections of. Omit to list all files." })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const c = client(ctx);
      const r = await c.send<{ Ok: boolean; Paths?: string[]; Files?: string[] }>({ Cmd: "list", Name: params.file ?? "" });
      const text = params.file
        ? ((r.Paths ?? []).join("\n") || "(no sections)")
        : ((r.Files ?? []).join("\n") || "(no files)");
      return { content: [{ type: "text" as const, text }], details: null };
    },
  });

  pi.registerTool({
    name: "memory_get",
    label: "Memory: Get",
    description: "Exact path lookup — retrieve a section by its full path.",
    promptSnippet: "Retrieve a memory section by exact path",
    parameters: Type.Object({
      path: Type.String({ description: "Full section path, e.g. auth/api-keys." }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const r = await client(ctx).send<{ Ok: boolean; Heading: string; Content: string }>({ Cmd: "get", Path: params.path });
      const text = `${r.Heading}\n\n${r.Content}`.trim();
      return { content: [{ type: "text" as const, text }], details: null };
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory: Search",
    description: "Search memories using hybrid FTS5 + vector search (vector when sidecar active).",
    promptSnippet: "Search memory using full-text + vector search",
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      top: Type.Optional(Type.Number({ description: "Max results. Default: 5.", minimum: 1 })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const r = await client(ctx).send<{ Ok: boolean; Results: Array<{ Path: string; Heading: string; Content: string }> }>({
        Cmd: "search", Query: params.query, Top: params.top ?? 5,
      });
      const text = r.Results
        .map((s) => `=== ${s.Path} ===\n${s.Heading}\n\n${s.Content}`)
        .join("\n\n") || "(no results)";
      return { content: [{ type: "text" as const, text }], details: null };
    },
  });

  pi.registerTool({
    name: "memory_new",
    label: "Memory: New",
    description: "Create a new memory section. File must exist (use memory_create_file first). Fails if section already exists.",
    promptSnippet: "Create a new memory section",
    parameters: Type.Object({
      path: Type.String({ description: "Full section path, e.g. auth/api-keys." }),
      body: Type.String({ description: "Body text for the section." }),
      heading: Type.Optional(Type.String({ description: "Human-readable heading. Defaults to last path segment." })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      await client(ctx).send({ Cmd: "new", Path: params.path, Heading: params.heading ?? "", Content: params.body });
      return { content: [{ type: "text" as const, text: `Section created: ${params.path}` }], details: null };
    },
  });

  pi.registerTool({
    name: "memory_update",
    label: "Memory: Update",
    description: "Replace the immediate body of an existing section. Child sections are preserved unchanged.",
    promptSnippet: "Update the body of an existing memory section",
    parameters: Type.Object({
      path: Type.String({ description: "Full section path to update." }),
      body: Type.String({ description: "New body text." }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      await client(ctx).send({ Cmd: "update", Path: params.path, Content: params.body });
      return { content: [{ type: "text" as const, text: `Section updated: ${params.path}` }], details: null };
    },
  });

  pi.registerTool({
    name: "memory_delete",
    label: "Memory: Delete",
    description: "Delete a section and all its children.",
    promptSnippet: "Delete a memory section and its children",
    parameters: Type.Object({
      path: Type.String({ description: "Full section path to delete." }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      await client(ctx).send({ Cmd: "delete", Path: params.path });
      return { content: [{ type: "text" as const, text: `Section deleted: ${params.path}` }], details: null };
    },
  });

  pi.registerTool({
    name: "memory_create_file",
    label: "Memory: Create File",
    description: "Create a new memory file (topic area). Must be done before adding sections with memory_new.",
    promptSnippet: "Create a new memory file (topic area) with title and optional description",
    parameters: Type.Object({
      name: Type.String({ description: "File name without .md extension, e.g. 'auth'." }),
      title: Type.String({ description: "Human-readable title written as the file's # heading." }),
      description: Type.Optional(Type.String({ description: "Optional description placed below the title." })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      await client(ctx).send({
        Cmd: "create-file", Name: params.name, Title: params.title, Description: params.description ?? "",
      });
      return { content: [{ type: "text" as const, text: `File created: ${params.name}.md` }], details: null };
    },
  });

  pi.registerTool({
    name: "memory_delete_file",
    label: "Memory: Delete File",
    description: "Delete an entire memory file and all its sections. This is permanent.",
    promptSnippet: "Delete an entire memory file and all its sections",
    parameters: Type.Object({
      name: Type.String({ description: "File name without .md extension." }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      await client(ctx).send({ Cmd: "delete-file", Name: params.name });
      return { content: [{ type: "text" as const, text: `File deleted: ${params.name}.md` }], details: null };
    },
  });

  pi.registerTool({
    name: "memory_validate_file",
    label: "Memory: Validate File",
    description: "Check structural rules of a memory file: duplicate paths, skipped heading levels, multiple title headings.",
    promptSnippet: "Validate the structure of a memory file",
    parameters: Type.Object({
      name: Type.String({ description: "File name without .md extension." }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const r = await client(ctx).send<{ Ok: boolean; Issues: string[] }>({ Cmd: "validate-file", Name: params.name });
      const text = r.Issues.length === 0 ? `${params.name}: ok` : r.Issues.join("\n");
      return { content: [{ type: "text" as const, text }], details: null };
    },
  });
}
