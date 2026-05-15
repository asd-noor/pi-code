import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getInstalledBinary } from "./installer.ts";

function readdirSyncSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

export interface LspServerDef {
  command: string;
  args: string[];
  languageId: string;
  extensions: string[];
  installId: string;
}

export function which(cmd: string): string | null {
  try {
    const out = execFileSync("which", [cmd], { stdio: "pipe", timeout: 3000 });
    return out.toString().trim() || null;
  } catch { return null; }
}

function resolveCmd(...serverIds: string[]): string {
  for (const id of serverIds) {
    const found = getInstalledBinary(id);
    if (found) return found;
  }
  return serverIds[0];
}

const SERVER_DEFS: Array<{ detect: (root: string) => boolean; server: () => LspServerDef }> = [
  {
    detect: (r) => existsSync(join(r, "tsconfig.json")) || existsSync(join(r, "package.json")),
    server: () => ({
      command: resolveCmd("typescript-language-server"),
      args: ["--stdio"],
      languageId: "typescript",
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
      installId: "typescript-language-server",
    }),
  },
  {
    detect: (r) => existsSync(join(r, "go.mod")) || existsSync(join(r, "go.work")),
    server: () => ({
      command: resolveCmd("gopls"),
      args: [],
      languageId: "go",
      extensions: [".go"],
      installId: "gopls",
    }),
  },
  {
    detect: (r) =>
      existsSync(join(r, "pyproject.toml")) ||
      existsSync(join(r, "setup.py")) ||
      existsSync(join(r, "requirements.txt")) ||
      existsSync(join(r, "setup.cfg")),
    server: () => {
      const cmd = resolveCmd("pyright-langserver", "pylsp");
      const isPyright = cmd.endsWith("pyright-langserver") || cmd === "pyright-langserver";
      return {
        command: cmd,
        args: isPyright ? ["--stdio"] : [],
        languageId: "python",
        extensions: [".py"],
        installId: isPyright ? "pyright-langserver" : "pylsp",
      };
    },
  },
  {
    detect: (r) =>
      existsSync(join(r, "compile_commands.json")) ||
      existsSync(join(r, "CMakeLists.txt")) ||
      existsSync(join(r, "build.zig")) ||
      readdirSyncSafe(r).some((f) => f.endsWith(".c") || f.endsWith(".h")),
    server: () => ({
      command: resolveCmd("clangd"),
      args: [],
      languageId: "c",
      extensions: [".c", ".h"],
      installId: "clangd",
    }),
  },
];


/**
 * Returns ALL matching server defs for the given project root.
 * An empty array means no LSP markers were found (tree-sitter-only mode).
 */
export function detectServers(rootPath: string): LspServerDef[] {
  return SERVER_DEFS.filter((rule) => rule.detect(rootPath)).map((rule) => rule.server());
}
