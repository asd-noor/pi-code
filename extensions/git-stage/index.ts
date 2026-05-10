/**
 * git-stage extension
 *
 * Registers the /git-stage command which opens an interactive TUI overlay
 * for hunk-level staging and unstaging in the current git repository.
 *
 * Footer badge: polls every 3s and shows "⊕ N staged" when staged files exist.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GitStageOverlay } from "./component.ts";

const POLL_INTERVAL_MS = 3000;

export default function (pi: ExtensionAPI) {
  let storedCtx: ExtensionContext | undefined;
  let inGitRepo = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let lastBadge: string | undefined;  // track last value to avoid redundant setStatus calls

  // ── Footer badge ─────────────────────────────────────────────────────────

  async function updateBadge(): Promise<void> {
    if (!storedCtx || !inGitRepo) return;
    const ctx = storedCtx;
    try {
      const result = await pi.exec("git", ["diff", "--cached", "--name-only"], {
        cwd: ctx.cwd,
        timeout: 3000,
      });
      const lines = result.stdout.trim().split("\n").filter(Boolean);
      const next = lines.length > 0 ? ctx.ui.theme.fg("success", `⊕ ${lines.length} staged`) : undefined;
      if (next !== lastBadge) {
        lastBadge = next;
        ctx.ui.setStatus("git-stage", next);
      }
    } catch (err) {
      // If the context became stale (session replacement / reload), stop the
      // poll timer and clear state. The next session_start event will restart.
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
        try { ctx.ui.setStatus("git-stage", undefined); } catch { /* ignore if also stale */ }
      }
    }
  }

  function startPolling(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => { void updateBadge(); }, POLL_INTERVAL_MS);
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  }

  async function isGitRepo(cwd: string): Promise<boolean> {
    try {
      const result = await pi.exec("git", ["rev-parse", "--git-dir"], { cwd, timeout: 3000 });
      return result.code === 0;
    } catch {
      return false;
    }
  }

  // ── Session events ───────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    storedCtx = ctx;
    inGitRepo = await isGitRepo(ctx.cwd);
    lastBadge = undefined;
    if (inGitRepo) {
      await updateBadge();
      startPolling();
    }
  });

  pi.on("session_shutdown", async () => {
    stopPolling();
    storedCtx = undefined;
    inGitRepo = false;
    lastBadge = undefined;
  });

  // ── /git-stage command ───────────────────────────────────────────────────

  pi.registerCommand("git-stage", {
    description: "Interactively stage and unstage git hunks",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/git-stage requires interactive mode", "error");
        return;
      }

      const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
        cwd: ctx.cwd,
        timeout: 3000,
      });
      if (rootResult.code !== 0) {
        ctx.ui.notify("Not a git repository", "error");
        return;
      }
      const gitRoot = rootResult.stdout.trim();

      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          const comp = new GitStageOverlay({ tui, theme, done, pi, cwd: gitRoot });
          return {
            render:      (w) => comp.render(w),
            invalidate:  ()  => comp.invalidate(),
            handleInput: (d) => { comp.handleInput(d); tui.requestRender(); },
          };
        },
        { overlay: true, overlayOptions: { anchor: "center", width: "95%", maxHeight: "95%" } },
      );
    },
  });
}
