import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getInstalledBinary } from "./installer.ts";

export interface LspServerDef {
  command: string;
  args: string[];
  languageId: string;
  extensions: string[];
  installId: string;
}

function which(cmd: string): string | null {
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
    detect: (r) => existsSync(join(r, "go.mod")),
    server: () => ({
      command: resolveCmd("gopls"),
      args: [],
      languageId: "go",
      extensions: [".go"],
      installId: "gopls",
    }),
  },
  {
    detect: (r) => existsSync(join(r, "Cargo.toml")),
    server: () => ({
      command: resolveCmd("rust-analyzer"),
      args: [],
      languageId: "rust",
      extensions: [".rs"],
      installId: "rust-analyzer",
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
    detect: (r) => existsSync(join(r, ".luarc.json")) || existsSync(join(r, ".luacheckrc")),
    server: () => ({
      command: resolveCmd("lua-language-server"),
      args: [],
      languageId: "lua",
      extensions: [".lua"],
      installId: "lua-language-server",
    }),
  },
];

export function detectServer(rootPath: string): LspServerDef {
  for (const rule of SERVER_DEFS) {
    if (rule.detect(rootPath)) return rule.server();
  }
  return {
    command: resolveCmd("typescript-language-server"),
    args: ["--stdio"],
    languageId: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    installId: "typescript-language-server",
  };
}
