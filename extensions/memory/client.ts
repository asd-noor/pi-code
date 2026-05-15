import { connect } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { getSocketPath, getStatusPath } from "./paths.ts";

const TIMEOUT_MS = 30_000;

export class MemoryClient {
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  readStatus(): string {
    try { return readFileSync(getStatusPath(this.projectRoot), "utf8").trim(); }
    catch { return "stopped"; }
  }

  async send<T extends Record<string, unknown>>(
    payload: Record<string, unknown>,
  ): Promise<T> {
    const sockPath = getSocketPath(this.projectRoot);
    if (!existsSync(sockPath)) {
      const status = this.readStatus();
      if (status === "starting" || status === "indexing") {
        throw new Error(`memory daemon is still ${status} — try again in a moment`);
      }
      throw new Error("memory daemon is not running");
    }

    return new Promise((resolve, reject) => {
      const socket = connect(sockPath);
      let buf = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`memory daemon request timed out`));
      }, TIMEOUT_MS);

      socket.on("connect", () => {
        socket.write(JSON.stringify({ id: 1, ...payload }) + "\n");
      });

      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        if (!buf.includes("\n")) return;
        clearTimeout(timer);
        socket.destroy();
        try {
          const resp = JSON.parse(buf.trim()) as T & { Ok: boolean; Error?: string };
          if (!resp.Ok) reject(new Error(resp.Error ?? "daemon error"));
          else resolve(resp);
        } catch (err) {
          reject(err);
        }
      });

      socket.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
  }
}
