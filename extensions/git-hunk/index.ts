/**
 * git-hunk extension
 *
 * Footer badge: polls every 3s and shows "⊕ N staged" when staged files exist.
 *
 * Autostart: hunk session is started via terminal extension autostart config
 * ("hunk-session" key in pi-code.json terminal.autostart).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { isGitRepo, createLogger } from "../_config/index.ts";

let logger = createLogger("git-hunk");
function debug(...args: unknown[]): void { logger.log(...args); }

const HUNK_WINDOW = "hunk-session";

function tmux(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

const POLL_INTERVAL_MS = 3000;
const STATUS_KEY = "git-hunk";

export default function (pi: ExtensionAPI) {
  let storedCtx: ExtensionContext | undefined;
  let inGitRepo = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let lastBadge: string | undefined;

  // ── Footer badge ────────────────────────────────────────────────────────────

  async function updateBadge(): Promise<void> {
    if (!storedCtx || !inGitRepo) return;
    const ctx = storedCtx;
    try {
      const result = await pi.exec("git", ["diff", "--cached", "--name-only"], {
        cwd: ctx.cwd,
        timeout: 3000,
      });
      const lines = result.stdout.trim().split("\n").filter(Boolean);
      const next = lines.length > 0
        ? ctx.ui.theme.fg("success", `| git-hunk: ${lines.length} staged`)
        : undefined;
      if (next !== lastBadge) {
        lastBadge = next;
        ctx.ui.setStatus(STATUS_KEY, next);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("stale")) {
        stopPolling();
        storedCtx = undefined;
        inGitRepo = false;
        lastBadge = undefined;
        return;
      }
      if (lastBadge !== undefined) {
        lastBadge = undefined;
        try { ctx.ui.setStatus(STATUS_KEY, undefined); } catch { /* ignore */ }
      }
    }
  }

  function startPolling(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => { void updateBadge(); }, POLL_INTERVAL_MS);
  }

  function stopPolling(): void {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
  }

  // ── Session events ───────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    logger = createLogger("git-hunk", ctx.cwd);
    logger.truncate();
    debug("session_start", ctx.cwd);
    storedCtx = ctx;
    inGitRepo = isGitRepo(ctx.cwd);
    lastBadge = undefined;
    if (!inGitRepo) return;
    await updateBadge();
    startPolling();
    // Request terminal session so hunk can be started.
    debug("emitting terminal:ensure-session");
    pi.events.emit("terminal:ensure-session", { cwd: ctx.cwd });
  });

  // Start hunk when the terminal session becomes ready.
  pi.events.on("terminal:session-ready", async (data: any) => {
    debug("terminal:session-ready received", JSON.stringify(data), "inGitRepo="+inGitRepo);
    if (!inGitRepo) return;
    const { session: sess, cwd } = data as { session: string; cwd: string };
    try {
      const winOut = await tmux(["list-windows", "-t", sess, "-F", "#{window_name}"]).catch(() => "");
      if (winOut.split("\n").map((l: string) => l.trim()).includes(HUNK_WINDOW)) return;
      await tmux(["new-window", "-t", sess, "-n", HUNK_WINDOW, "-c", cwd,
        "bash", "-lc", "hunk diff --staged --watch"]);
      debug("created hunk-session window");
      pi.events.emit("terminal:window-added", { window: HUNK_WINDOW });
    } catch { /* hunk or tmux not available */ }
  });

  pi.on("session_shutdown", async () => {
    stopPolling();
    storedCtx = undefined;
    inGitRepo = false;
    lastBadge = undefined;
  });
}
