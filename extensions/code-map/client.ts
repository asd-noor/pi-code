/**
 * SocketClient — queries the daemon over Unix socket.
 * Does not auto-spawn the daemon; the pi extension manages lifecycle.
 */

import { connect } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectDir } from "./paths.ts";

const QUERY_TIMEOUT_MS = 90_000;

export class SocketClient {
  private sockPath: string;
  private statusPath: string;

  constructor(private rootPath: string) {
    const projectDir  = getProjectDir(rootPath);
    this.sockPath     = join(projectDir, "codemap-daemon.sock");
    this.statusPath   = join(projectDir, "codemap-daemon.status");
  }

  readStatus(): string {
    try { return readFileSync(this.statusPath, "utf8").trim(); }
    catch { return "stopped"; }
  }

  isReady(): boolean { return this.readStatus() === "ready"; }

  /** Query the daemon. Throws a user-friendly error if not ready. */
  async query<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!existsSync(this.sockPath)) {
      const status = this.readStatus();
      if (status === "starting" || status === "indexing") {
        throw new Error(`code-map daemon is still ${status}. Try again in a moment.`);
      }
      if (status === "error") {
        throw new Error("code-map daemon failed to start. Run /code-map logs to diagnose.");
      }
      throw new Error("code-map daemon is not running.");
    }
    return this.sendQuery<T>(method, params);
  }

  private sendQuery<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.sockPath);
      let buf = "";
      const reqId = 1;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`query timed out: ${method}`));
      }, QUERY_TIMEOUT_MS);

      socket.on("connect", () => {
        socket.write(JSON.stringify({ id: reqId, method, params }) + "\n");
      });

      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed) as { id: number; result?: T; error?: string };
            if (msg.id === reqId) {
              clearTimeout(timer);
              socket.end();
              if (msg.error) reject(new Error(msg.error));
              else resolve(msg.result as T);
            }
          } catch (_) {}
        }
      });

      socket.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
  }
}
