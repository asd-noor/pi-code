import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { SocketClient } from "./client.ts";

export function registerTools(pi: ExtensionAPI, getRoot: () => string | undefined): void {

  // ── outline ───────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "code_map_outline",
    label: "Code Map: Outline",
    description: "Get the structural outline of a file — every symbol the LSP knows: functions, classes, methods, interfaces, types, enums. Use before editing a file to understand its structure.",
    promptSnippet: "Get structural outline of a file (functions, classes, methods, types)",
    parameters: Type.Object({
      file:     Type.String({ description: "Absolute or relative path to the file." }),
      language: Type.String({ description: "Language id: typescript | javascript | python | go | zig | lua" }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = getRoot() ?? ctx.cwd;
      const client = new SocketClient(root);
      try {
        const rows = await client.query<any[]>("outline", { file: params.file, language: params.language });
        if (!rows.length) return text("(no symbols found)");
        return text(JSON.stringify(rows, null, 2));
      } catch (err: any) {
        return text(`Error: ${err.message}`);
      }
    },
  });

  // ── symbol ────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "code_map_symbol",
    label: "Code Map: Symbol",
    description: "Find every definition of a symbol across the whole workspace. Accepts plain names, qualified names (Store.FindImpact), and Go receiver syntax. Use source=true to include the source snippet.",
    promptSnippet: "Find symbol definitions across the workspace",
    parameters: Type.Object({
      name:     Type.String({ description: "Symbol name to find." }),
      source:   Type.Optional(Type.Boolean({ description: "Include source snippet. Default: false." })),
      language: Type.String({ description: "Language id: typescript | javascript | python | go | zig | lua" }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = getRoot() ?? ctx.cwd;
      const client = new SocketClient(root);
      try {
        const rows = await client.query<any[]>("symbol", { name: params.name, withSource: params.source ?? false, language: params.language });
        if (!rows.length) return text(`(no symbol found: ${params.name})`);
        return text(JSON.stringify(rows, null, 2));
      } catch (err: any) {
        return text(`Error: ${err.message}`);
      }
    },
  });

  // ── diagnostics ───────────────────────────────────────────────────────────

  pi.registerTool({
    name: "code_map_diagnostics",
    label: "Code Map: Diagnostics",
    description: "Get LSP diagnostics (type errors, warnings, hints) — the same errors the editor would show. Severity: 1=error, 2=warning, 3=info, 4=hint, 0=all (default).",
    promptSnippet: "Get LSP diagnostics (type errors, warnings) for the project or a file",
    parameters: Type.Object({
      file:     Type.Optional(Type.String({ description: "Filter to a specific file. Omit for all files." })),
      severity: Type.Optional(Type.Number({ description: "Minimum severity level (1=error, 2=warning, 3=info, 4=hint, 0=all). Default: 0." })),
      language: Type.String({ description: "Language id: typescript | javascript | python | go | zig | lua" }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = getRoot() ?? ctx.cwd;
      const client = new SocketClient(root);
      try {
        const rows = await client.query<any[]>("diagnostics", {
          ...(params.file ? { file: params.file } : {}),
          severity: params.severity ?? 0,
          language: params.language,
        });
        if (!rows.length) return text("(no diagnostics)");
        return text(JSON.stringify(rows, null, 2));
      } catch (err: any) {
        return text(`Error: ${err.message}`);
      }
    },
  });

  // ── impact ────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "code_map_impact",
    label: "Code Map: Impact",
    description: "Find every caller of a symbol — what breaks if you change it. Pulls from the pre-built reverse reference index (instant once background indexing reaches the symbol). Use before refactoring to understand blast radius.",
    promptSnippet: "Find callers of a symbol (blast radius analysis for refactoring)",
    parameters: Type.Object({
      name:     Type.String({ description: "Symbol name to find callers for." }),
      language: Type.String({ description: "Language id: typescript | javascript | python | go | zig | lua" }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const root = getRoot() ?? ctx.cwd;
      const client = new SocketClient(root);
      try {
        const rows = await client.query<any[]>("impact", { name: params.name, language: params.language });
        if (!rows.length) return text(`(no callers found for: ${params.name})`);
        return text(JSON.stringify(rows, null, 2));
      } catch (err: any) {
        return text(`Error: ${err.message}`);
      }
    },
  });
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: undefined };
}
