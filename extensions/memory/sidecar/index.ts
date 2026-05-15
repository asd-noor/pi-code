import { writeFileSync, existsSync } from "node:fs";
import { connect } from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { arch } from "node:os";

export const EMBED_PY = `# /// script
# dependencies = ["mlx-embeddings"]
# ///
"""
Embedding sidecar for memory-md.

Listens on a Unix socket (path from MEMORY_MD_SIDECAR_SOCK env var),
accepts newline-delimited JSON requests, returns embeddings.

Protocol:
  Request:  {"Texts": ["text1", "text2", ...]}\n
  Response: {"Embeddings": [[0.1, ...], ...]}\n
  Error:    {"Error": "message"}\n
"""

import json
import os
import signal
import socket
import sys

SOCK_PATH  = os.environ.get("MEMORY_MD_SIDECAR_SOCK", "sidecar.sock")
MODEL_NAME = os.environ.get("MEMORY_MD_EMBED_MODEL", "mlx-community/bge-small-en-v1.5-8bit")


def load_model():
    from mlx_embeddings.utils import load
    return load(MODEL_NAME)


def embed(model, tokenizer, texts):
    inputs = tokenizer.batch_encode_plus(
        texts, return_tensors="mlx", padding=True, truncation=True, max_length=512,
    )
    outputs = model(inputs["input_ids"], attention_mask=inputs["attention_mask"])
    return outputs.text_embeds.tolist()


def handle(conn, model, tokenizer):
    with conn.makefile("r") as f:
        line = f.readline()
    if not line:
        return
    try:
        req  = json.loads(line)
        embs = embed(model, tokenizer, req.get("Texts", []))
        resp = json.dumps({"Embeddings": embs})
    except Exception as exc:
        resp = json.dumps({"Error": str(exc)})
    try:
        conn.sendall((resp + "\\n").encode())
    except (BrokenPipeError, OSError):
        pass


def main():
    try:
        os.unlink(SOCK_PATH)
    except FileNotFoundError:
        pass

    print(f"Loading model {MODEL_NAME}...", file=sys.stderr, flush=True)
    model, tokenizer = load_model()
    print("Model loaded. Listening on", SOCK_PATH, file=sys.stderr, flush=True)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCK_PATH)
    server.listen(8)

    def shutdown(signum, frame):
        server.close()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    try:
        while True:
            try:
                conn, _ = server.accept()
            except OSError:
                break
            try:
                handle(conn, model, tokenizer)
            finally:
                conn.close()
    finally:
        server.close()
        try:
            os.unlink(SOCK_PATH)
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    main()
`;

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
 * Write embed.py to the extension dir and spawn the sidecar.
 * Only call when isAppleSilicon() && isUvAvailable().
 */
export function spawnSidecar(
  embedScriptPath: string,
  sidecarSockPath: string,
  logFd: number,
): ChildProcess {
  writeFileSync(embedScriptPath, EMBED_PY, "utf8");

  return spawn("uv", ["run", embedScriptPath], {
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
