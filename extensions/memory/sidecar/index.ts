import { existsSync } from "node:fs";
import { connect } from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { arch } from "node:os";

/** Returns true when running on Apple Silicon — required for mlx-embeddings. */
export function isAppleSilicon(): boolean {
  return process.platform === "darwin" && arch() === "arm64";
}

/** Check if uv is available in PATH. */
export function isUvAvailable(): boolean {
  try {
    const r = spawnSync("uv", ["--version"], { timeout: 2000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Spawn the embedding sidecar.
 * Only call when isAppleSilicon() && isUvAvailable().
 */
export function spawnSidecar(
  embedScriptPath: string,
  sidecarSockPath: string,
  logFd: number,
): ChildProcess {
  return spawn("uv", ["run", "--script", embedScriptPath], {
    env: {
      ...process.env,
      MEMORY_MD_SIDECAR_SOCK: sidecarSockPath,
    },
    stdio: ["ignore", logFd, logFd],
    detached: false,
  });
}

/**
 * Poll until the sidecar socket appears (meaning the model is loaded).
 * Resolves true when ready, false on timeout.
 */
export function waitForSidecar(sockPath: string, timeoutMs = 30_000): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (existsSync(sockPath)) { resolve(true); return; }
      if (Date.now() >= deadline) { resolve(false); return; }
      setTimeout(check, 500);
    };
    check();
  });
}

/**
 * Send texts to the running sidecar and return embeddings.
 * Returns null if the sidecar socket is absent (FTS5-only fallback).
 */
export function embedTexts(
  sidecarSockPath: string,
  texts: string[],
): Promise<Float32Array[] | null> {
  if (!existsSync(sidecarSockPath)) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const socket = connect(sidecarSockPath);
    let buf = "";

    socket.on("connect", () => {
      socket.write(JSON.stringify({ Texts: texts }) + "\n");
    });

    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (!buf.includes("\n")) return;
      socket.destroy();
      try {
        const resp = JSON.parse(buf.trim());
        if (resp.Error) { reject(new Error(resp.Error)); return; }
        const arrays = (resp.Embeddings as number[][]).map((v) => new Float32Array(v));
        resolve(arrays);
      } catch (err) {
        reject(err);
      }
    });

    socket.on("error", () => resolve(null));
  });
}

/** Build the text string sent to the sidecar per section. */
export function sectionEmbedText(path: string, heading: string, content: string): string {
  return `${path} ${heading} ${content}`.slice(0, 2048);
}
