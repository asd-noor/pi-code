import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDaemonSocketPath, getProjectTempDir } from "../_config/index.ts";

const _dir = dirname(fileURLToPath(import.meta.url));

export function getEmbedScriptPath(): string {
  return join(_dir, "sidecar", "embed.py");
}

// All per-session runtime files (sockets, pid, status, log) live under
// /tmp/pi-code/<projectHash>/memory/
// The cache DB lives under the cacheDir provided by callers.

export function getSocketPath(cwd: string): string {
  return getDaemonSocketPath("memory", cwd);
}

export function getSidecarSocketPath(cwd: string): string {
  const extDir = join(getProjectTempDir(cwd), "memory");
  return join(extDir, "sidecar.sock");
}

export function getLogPath(cwd: string): string {
  const extDir = join(getProjectTempDir(cwd), "memory");
  return join(extDir, "logfile.log");
}

export function getPidPath(cwd: string): string {
  const extDir = join(getProjectTempDir(cwd), "memory");
  return join(extDir, "daemon.pid");
}

export function getStatusPath(cwd: string): string {
  const extDir = join(getProjectTempDir(cwd), "memory");
  return join(extDir, "daemon.status");
}

// Cache DB path is provided by the caller (via getProjectCacheDir or getDetachedCacheDir)
export function getDbPath(cacheDir: string): string {
  return join(cacheDir, "memory-cache.db");
}
