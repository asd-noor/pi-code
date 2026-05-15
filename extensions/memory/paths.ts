import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { getProjectCacheDir } from "../_config/index.ts";

// Extension-level shared dir — embed.py lives here, shared across all projects.
const EXTENSION_DIR = join(homedir(), ".pi", "cache", "memory");

export function getExtensionDir(): string { return EXTENSION_DIR; }
export function getEmbedScriptPath(): string { return join(EXTENSION_DIR, "embed.py"); }

export function ensureExtensionDir(): string {
  mkdirSync(EXTENSION_DIR, { recursive: true });
  return EXTENSION_DIR;
}

// All per-project files live under _config.getProjectCacheDir(projectRoot).
export function getSocketPath(projectRoot: string): string {
  return join(getProjectCacheDir(projectRoot), "memory-channel.sock");
}

export function getSidecarSocketPath(projectRoot: string): string {
  return join(getProjectCacheDir(projectRoot), "memory-sidecar.sock");
}

export function getDbPath(projectRoot: string): string {
  return join(getProjectCacheDir(projectRoot), "memory-cache.db");
}

export function getLogPath(projectRoot: string): string {
  return join(getProjectCacheDir(projectRoot), "memory-daemon.log");
}

export function getPidPath(projectRoot: string): string {
  return join(getProjectCacheDir(projectRoot), "memory-daemon.pid");
}

export function getStatusPath(projectRoot: string): string {
  return join(getProjectCacheDir(projectRoot), "memory-daemon.status");
}
