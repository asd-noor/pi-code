/**
 * Cache path helpers.
 * Layout: ~/.pi/cache/
 *   lsp/                            shared LSP binaries
 *   tree-sitter/                    shared tree-sitter grammar packages
 *   pi-code-projects/<sha256[:16]>/ per-project cache (code-map.db)
 *
 * Per-project directories are resolved via _config.getProjectCacheDir so that
 * all extensions share the same stable, collision-resistant path scheme.
 *
 * Daemon runtime files (socket, pid, status, log) now live in:
 *   /tmp/pi-code/<projectHash>/code-map/
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { getProjectCacheDir } from "../_config/index.ts";

const CACHE_BASE = join(homedir(), ".pi", "cache");

export function getCacheDir(): string          { return CACHE_BASE; }
export function getLspDir(): string            { return join(CACHE_BASE, "lsp"); }
export function getTreeSitterDir(): string     { return join(CACHE_BASE, "tree-sitter"); }

/**
 * Directory that contains all per-project cache subdirectories.
 * Equivalent to ~/.pi/cache/pi-code-projects/.
 */
export function getProjectsCacheDir(): string  { return join(CACHE_BASE, "pi-code-projects"); }

/**
 * Return (and initialise) the per-project cache directory for rootPath.
 * Delegates to _config.getProjectCacheDir which uses a SHA-256 hash of the
 * project root and validates dir.txt on every call.
 */
export function getProjectDir(rootPath: string): string {
  return getProjectCacheDir(rootPath);
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
