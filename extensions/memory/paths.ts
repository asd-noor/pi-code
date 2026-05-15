import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const _dir = dirname(fileURLToPath(import.meta.url));

export function getEmbedScriptPath(): string {
  return join(_dir, "sidecar", "embed.py");
}

// All per-session files live under a pre-resolved cacheDir.
// Callers compute cacheDir via getProjectCacheDir() or getDetachedCacheDir().
export function getSocketPath(cacheDir: string): string {
  return join(cacheDir, "memory-channel.sock");
}

export function getSidecarSocketPath(cacheDir: string): string {
  return join(cacheDir, "memory-sidecar.sock");
}

export function getDbPath(cacheDir: string): string {
  return join(cacheDir, "memory-cache.db");
}

export function getLogPath(cacheDir: string): string {
  return join(cacheDir, "memory-daemon.log");
}

export function getPidPath(cacheDir: string): string {
  return join(cacheDir, "memory-daemon.pid");
}

export function getStatusPath(cacheDir: string): string {
  return join(cacheDir, "memory-daemon.status");
}
