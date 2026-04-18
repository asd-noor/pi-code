/**
 * Tree-sitter installer — installs tree-sitter + 6 grammar packages to
 * ~/.pi/cache/tree-sitter/ on demand.
 * Mirrors lsp/installer.ts — no bundled deps, pure runtime install.
 *
 * Supported languages: TypeScript, JavaScript, Python, Go, Lua, Zig
 */

import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getTreeSitterDir, ensureDir } from "../paths.ts";

// ── Public API ────────────────────────────────────────────────────────────────

export { getTreeSitterDir };

export function isTreeSitterInstalled(): boolean {
  const dir = getTreeSitterDir();
  return existsSync(join(dir, "node_modules", "tree-sitter"));
}

export async function installTreeSitter(log: (msg: string) => void): Promise<void> {
  const dir = ensureDir(getTreeSitterDir());
  log(`Installing tree-sitter packages to ${dir}…`);

  const packages = [
    "tree-sitter",
    "tree-sitter-typescript",
    "tree-sitter-javascript",
    "tree-sitter-python",
    "tree-sitter-go",
    "tree-sitter-zig",
    "tree-sitter-lua",
  ];

  runNpm(dir, packages);
  log(`tree-sitter packages installed → ${dir}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function which(cmd: string): string | null {
  try {
    const out = execFileSync("which", [cmd], { stdio: "pipe", timeout: 3000 });
    return out.toString().trim() || null;
  } catch { return null; }
}

function runNpm(dir: string, packages: string[]): void {
  if (which("bun")) {
    runSync("bun", ["add", "--cwd", dir, ...packages]);
  } else if (which("npm")) {
    runSync("npm", ["install", "--prefix", dir, "--legacy-peer-deps", ...packages]);
  } else {
    throw new Error("Neither bun nor npm found on PATH");
  }
}

function runSync(cmd: string, args: string[]): void {
  const result = spawnSync(cmd, args, { stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    throw new Error(`Command failed (exit ${result.status}): ${cmd} ${args.join(" ")}`);
  }
}
