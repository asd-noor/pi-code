#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["mlx-embeddings"]
# ///
"""Embedding sidecar for memory-md.

Listens on a Unix socket (sidecar.sock in the cache directory, passed via
MEMORY_MD_SIDECAR_SOCK env var), accepts newline-delimited JSON requests, and
returns embeddings produced by mlx-embeddings.

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

SOCK_PATH = os.environ.get("MEMORY_MD_SIDECAR_SOCK", "sidecar.sock")
MODEL_NAME = os.environ.get(
    "MEMORY_MD_EMBED_MODEL", "mlx-community/bge-small-en-v1.5-8bit"
)


def load_model():
    from mlx_embeddings.utils import load  # type: ignore

    return load(MODEL_NAME)


def embed(model, tokenizer, texts: list[str]) -> list[list[float]]:
    inputs = tokenizer.batch_encode_plus(
        texts,
        return_tensors="mlx",
        padding=True,
        truncation=True,
        max_length=512,
    )
    outputs = model(inputs["input_ids"], attention_mask=inputs["attention_mask"])
    return outputs.text_embeds.tolist()


def handle(conn, model, tokenizer):
    with conn.makefile("r") as f:
        line = f.readline()
    if not line:
        return
    try:
        req = json.loads(line)
        texts = req.get("Texts", [])
        embeddings = embed(model, tokenizer, texts)
        resp = json.dumps({"Embeddings": embeddings})
    except Exception as exc:  # noqa: BLE001
        resp = json.dumps({"Error": str(exc)})
    try:
        conn.sendall((resp + "\n").encode())
    except (BrokenPipeError, OSError):
        # Daemon closed the socket (e.g. killed during session shutdown) while
        # the sidecar was computing an embedding.  Silently discard — the
        # daemon is already gone so there is nothing useful to report.
        pass



def main():
    # Remove stale socket from a prior crash.
    try:
        os.unlink(SOCK_PATH)
    except FileNotFoundError:
        pass

    print(f"Loading model {MODEL_NAME}…", file=sys.stderr, flush=True)
    model, tokenizer = load_model()
    print("Model loaded. Listening on", SOCK_PATH, file=sys.stderr, flush=True)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCK_PATH)
    server.listen(8)

    def shutdown(signum, frame):
        # Closing the server causes accept() to raise OSError, breaking the
        # loop cleanly; the finally block below handles socket-file cleanup.
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
