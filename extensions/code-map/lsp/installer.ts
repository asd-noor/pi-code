/**
 * LSP installer — discovers and installs language servers into
 * ~/.pi/cache/lsp/. No Bun APIs — pure Node.js.
 */

import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLspDir, ensureDir } from "../paths.ts";

// ── which replacement ─────────────────────────────────────────────────────────

function which(cmd: string): string | null {
  try {
    const out = execFileSync("which", [cmd], { stdio: "pipe", timeout: 3000 });
    return out.toString().trim() || null;
  } catch { return null; }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InstallRecipe {
  serverId: string;
  displayName: string;
  systemBinary: string;
  localBinary(): string;
  install(lspDir: string): Promise<void>;
  hint: string;
}

// ── Recipes ───────────────────────────────────────────────────────────────────

const RECIPES: Record<string, InstallRecipe> = {
  "typescript-language-server": {
    serverId: "typescript-language-server",
    displayName: "typescript-language-server (TypeScript/JavaScript)",
    systemBinary: "typescript-language-server",
    localBinary: () => join(getLspDir(), "node_modules", ".bin", "typescript-language-server"),
    hint: "npm install -g typescript-language-server typescript",
    install: async (lspDir) => { runNpm(lspDir, "typescript-language-server", "typescript"); },
  },
  "pyright-langserver": {
    serverId: "pyright-langserver",
    displayName: "pyright (Python)",
    systemBinary: "pyright-langserver",
    localBinary: () => join(getLspDir(), "node_modules", ".bin", "pyright-langserver"),
    hint: "npm install -g pyright",
    install: async (lspDir) => { runNpm(lspDir, "pyright"); },
  },
  "pylsp": {
    serverId: "pylsp",
    displayName: "pylsp (Python)",
    systemBinary: "pylsp",
    localBinary: () => join(getLspDir(), "pylsp", "bin", "pylsp"),
    hint: "pip install python-lsp-server",
    install: async (lspDir) => {
      const venv = join(lspDir, "pylsp");
      runSync("python3", ["-m", "venv", venv]);
      runSync(join(venv, "bin", "pip"), ["install", "python-lsp-server"]);
    },
  },
  "gopls": {
    serverId: "gopls",
    displayName: "gopls (Go)",
    systemBinary: "gopls",
    localBinary: () => join(getLspDir(), "go", "bin", "gopls"),
    hint: "go install golang.org/x/tools/gopls@latest",
    install: async (lspDir) => {
      const goPath = join(lspDir, "go");
      mkdirSync(goPath, { recursive: true });
      runSync("go", ["install", "golang.org/x/tools/gopls@latest"], {
        env: { ...process.env, GOPATH: goPath },
      });
    },
  },
};

// ── Public API ────────────────────────────────────────────────────────────────

export function getInstalledBinary(serverId: string): string | null {
  const recipe = RECIPES[serverId];
  if (!recipe) return which(serverId);
  const local = recipe.localBinary();
  if (existsSync(local)) return local;
  return which(recipe.systemBinary);
}

export function isInstalled(serverId: string): boolean {
  return getInstalledBinary(serverId) !== null;
}

export function getInstallHint(serverId: string): string {
  return RECIPES[serverId]?.hint ?? `install ${serverId} and make sure it is on your PATH`;
}

export async function installServer(
  serverId: string,
  log: (msg: string) => void = console.log
): Promise<void> {
  const recipe = RECIPES[serverId];
  if (!recipe) throw new Error(`No install recipe for server: ${serverId}`);
  const lspDir = ensureDir(getLspDir());
  log(`Installing ${recipe.displayName}…`);
  await recipe.install(lspDir);
  const binary = recipe.localBinary();
  if (!existsSync(binary)) {
    throw new Error(`Install appeared to succeed but binary not found at: ${binary}`);
  }
  log(`Installed → ${binary}`);
}

export function knownServerIds(): string[] { return Object.keys(RECIPES); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function runNpm(lspDir: string, ...packages: string[]) {
  if (which("npm")) {
    runSync("npm", ["install", "--prefix", lspDir, ...packages]);
  } else if (which("bun")) {
    runSync("bun", ["add", "--cwd", lspDir, ...packages]);
  } else {
    throw new Error("Neither npm nor bun found on PATH");
  }
}

function runSync(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", env: opts.env ?? process.env });
  if (result.status !== 0) {
    throw new Error(`Command failed (exit ${result.status}): ${cmd} ${args.join(" ")}`);
  }
}
