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

/** Relative path to the compiled native addon inside the cache dir. */
const NODE_ADDON_REL = join(
  "node_modules",
  "tree-sitter",
  "build",
  "Release",
  "tree_sitter_runtime_binding.node",
);

/**
 * Packages that ship no prebuilts and must be compiled from source.
 * Others (tree-sitter-go, -javascript, -python, -typescript) ship platform
 * prebuilts and work without recompilation.
 */
const PACKAGES_NEED_BUILD = [
  "tree-sitter",
  "tree-sitter-zig",
  "tree-sitter-lua",
];

export function isTreeSitterInstalled(): boolean {
  const dir = getTreeSitterDir();
  // Check for the compiled native addon — not just the package directory.
  // If the build failed (e.g. bun left a partial build), the .node file
  // won't exist and we must retry installation.
  return existsSync(join(dir, NODE_ADDON_REL));
}

export async function installTreeSitter(log: (msg: string) => void): Promise<void> {
  const dir = ensureDir(getTreeSitterDir());

  const packages = [
    "tree-sitter",
    "tree-sitter-typescript",
    "tree-sitter-javascript",
    "tree-sitter-python",
    "tree-sitter-go",
    "tree-sitter-zig",
    "tree-sitter-lua",
  ];

  runNpm(dir, packages, log);
  log(`tree-sitter packages installed → ${dir}`);

  // Verify all source-built packages produced their .node files.
  // (Packages with prebuilts — tree-sitter-go, -js, -py, -ts — are skipped;
  //  they're ABI-agnostic and always load fine.)
  // If any .node is missing (e.g. bun left a partial build, or npm's
  // node-gyp-build failed silently), run an explicit node-gyp rebuild.
  const failed = missingNodeFiles(dir);
  if (failed.length > 0) {
    log(`Native addon build incomplete for: ${failed.join(", ")} — running node-gyp rebuild…`);
    rebuildPackages(dir, failed, log);
    const stillFailed = missingNodeFiles(dir);
    if (stillFailed.length > 0) {
      throw new Error(
        `tree-sitter native addon failed to build for: ${stillFailed.join(", ")}. ` +
        "Ensure a C/C++ toolchain is installed (Xcode CLT on macOS, build-essential on Linux).",
      );
    }
    log("Native addons rebuilt successfully");
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function which(cmd: string): string | null {
  try {
    const out = execFileSync("which", [cmd], { stdio: "pipe", timeout: 3000 });
    return out.toString().trim() || null;
  } catch { return null; }
}

/**
 * Install npm packages for tree-sitter.
 *
 * IMPORTANT: always prefer npm over bun.
 * Tree-sitter ships a native Node.js addon that must be compiled against the
 * Node.js ABI.  Bun's native-addon build pipeline targets Bun's own runtime
 * and can leave the .node file absent or partially compiled.  npm runs the
 * standard node-gyp-build install hook which compiles correctly for Node.js.
 */
function runNpm(dir: string, packages: string[], log: (msg: string) => void): void {
  const env = buildEnv();
  if (which("npm")) {
    runSync("npm", ["install", "--prefix", dir, "--legacy-peer-deps", ...packages], { env });
  } else if (which("bun")) {
    log("Warning: npm not found; falling back to bun — native addon may need an explicit rebuild");
    runSync("bun", ["add", "--cwd", dir, ...packages], { env });
  } else {
    throw new Error("Neither npm nor bun found on PATH");
  }
}

/**
 * Returns the list of PACKAGES_NEED_BUILD entries whose .node file is absent.
 */
function missingNodeFiles(dir: string): string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  return PACKAGES_NEED_BUILD.filter((pkg) => {
    const releaseDir = join(dir, "node_modules", pkg, "build", "Release");
    if (!existsSync(releaseDir)) return true;
    try {
      return !readdirSync(releaseDir).some((f) => f.endsWith(".node"));
    } catch { return true; }
  });
}

/**
 * Run `node-gyp rebuild` in each failing package directory.
 * Uses `npx` which resolves node-gyp from npm's bundled copy without
 * requiring a global install.
 */
function rebuildPackages(
  dir: string,
  packages: string[],
  log: (msg: string) => void,
): void {
  const env = buildEnv();
  for (const pkg of packages) {
    const pkgDir = join(dir, "node_modules", pkg);
    log(`  rebuilding ${pkg}…`);
    try {
      runSync("npx", ["node-gyp", "rebuild"], { env, cwd: pkgDir });
    } catch (err) {
      log(`  node-gyp rebuild failed for ${pkg}: ${err}`);
      // Continue trying other packages; caller checks for still-missing files.
    }
  }
}

/**
 * Build environment for native addon compilation.
 * Prefer zig cc/c++ — ships a full LLVM toolchain, supports C++20 out of the box,
 * and avoids macOS Xcode toolchain version mismatches.
 * Fall back to system compiler with explicit -std=c++20 (required by Node ≥ v22 v8 headers).
 */
function buildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (which("zig")) {
    env.CC  = "zig cc";
    env.CXX = "zig c++";
  } else {
    env.CXXFLAGS = ((env.CXXFLAGS ?? "") + " -std=c++20").trim();
  }
  return env;
}

function runSync(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): void {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    env: opts.env ?? process.env,
    cwd: opts.cwd,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed (exit ${result.status}): ${cmd} ${args.join(" ")}`);
  }
}
