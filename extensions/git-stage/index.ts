/**
 * git-stage extension
 *
 * Registers the /git-stage command which opens an interactive TUI for staging
 * and unstaging files in the current git repository.
 *
 * Footer badge: shows "⊕ N staged" when staged files exist.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GitStageComponent } from "./component.ts";

export default function (pi: ExtensionAPI) {
  let storedCtx: ExtensionContext | undefined;
  let inGitRepo = false;

  // ── Footer badge ─────────────────────────────────────────────────────────

  async function updateBadge(): Promise<void> {
    if (!storedCtx || !inGitRepo) return;
    const ctx = storedCtx;
    try {
      const result = await pi.exec("git", ["diff", "--cached", "--name-only"], {
        cwd: ctx.cwd,
        timeout: 5000,
      });
      const lines = result.stdout.trim().split("\n").filter(Boolean);
      if (lines.length > 0) {
        ctx.ui.setStatus("git-stage", ctx.ui.theme.fg("success", `⊕ ${lines.length} staged`));
      } else {
        ctx.ui.setStatus("git-stage", undefined);
      }
    } catch {
      ctx.ui.setStatus("git-stage", undefined);
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
    await updateBadge();
  });

  pi.on("agent_end", async (_event, ctx) => {
    storedCtx = ctx;
    await updateBadge();
  });

  pi.on("session_shutdown", async () => {
    storedCtx = undefined;
    inGitRepo = false;
  });

  // ── /git-stage command ───────────────────────────────────────────────────

  pi.registerCommand("git-stage", {
    description: "Interactively stage and unstage git files",
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

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        const component = new GitStageComponent({ tui, theme, done, pi, cwd: gitRoot });
        return component;
      });

      storedCtx = ctx;
      await updateBadge();
    },
  });
}
