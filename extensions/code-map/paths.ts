/**
 * Cache path helpers.
 * Layout: ~/.pi/cache/code-map/
 *   lsp/                       shared LSP binaries
 *   <encoded-project-path>/    per-project state (daemon.sock, daemon.pid, …)
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const CACHE_BASE = join(homedir(), ".pi", "cache", "code-map");

export function getCacheDir(): string { return CACHE_BASE; }
export function getLspDir(): string   { return join(CACHE_BASE, "lsp"); }

export function encodeProjectPath(rootPath: string): string {
  return rootPath.replace(/\//g, "=");
}

export function getProjectDir(rootPath: string): string {
  return join(CACHE_BASE, encodeProjectPath(rootPath));
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
