import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getProjectCacheDir } from "../_config/index.ts";

const _dir = dirname(fileURLToPath(import.meta.url));

export function getEmbedScriptPath(): string {
  return join(_dir, "sidecar", "embed.py");
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
