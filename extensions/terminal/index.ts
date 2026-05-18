/**
 * terminal extension for pi.
 *
 * Manages a dedicated tmux session for the project:
 *   - Session name: pi-tmux-<projectHash>
 *   - Session created on demand (first tool/command use)
 *   - Session auto-killed on session_shutdown
 *   - Works whether pi is inside tmux or not
 *
 * Tools: tmux_run, tmux_list, tmux_send_keys, tmux_capture,
 *        tmux_watch, tmux_unwatch
 *
 * Commands: /terminal [window]
 *
 * Future: tmux.apps config key for user-configurable tmux apps (not yet implemented).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { getConfig, isGitRepo, createLogger, getProjectTempDir, getExtensionTempDir } from "../_config/index.ts";
import {
  state,
  watchers,
  knownWindows,
  paneStreams,
  tmux,
  shellQuote,
  wrapCmd,
  deriveSessionName,
  ensureSession,
  killSession,
  killSentinelWindow,
  windowTarget,
  windowExists,
  closePaneStream,
  openFocusModal,
  debug,
} from "./tmux.ts";
import { registerTools } from "./tools.ts";
import { TERMINAL_INSTRUCTION } from "./instruction.ts";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// Pager command: use less with appropriate flags
function getPagerCommand(file: string, follow = false): string {
  // -R honours ANSI colour codes
  // -S chop long lines (use arrow keys to scroll horizontally)
  // +F enables follow (tail) mode for growing files
  return follow ? `less -RS +F ${shellQuote(file)}` : `less -RS ${shellQuote(file)}`;
}

export default function (pi: ExtensionAPI): void {

  function updateFooter(): void {
    if (!state.uiCtx) return;
    const count = knownWindows.size;
    state.uiCtx.setStatus("terminal", count > 0 ? `| terminals: ${count}` : undefined);
  }

  // ── Session lifecycle ───────────────────────────────────────────────────────

  pi.on("session_start", async (event: any, ctx) => {
    if (event?.subagentMode) return; // skip in subagent sessions
    getExtensionTempDir("terminal", ctx.cwd);
    state.logger.truncate();
    state.logger = createLogger("terminal", ctx.cwd);
    state.logger.truncate();
    debug("session_start", ctx.cwd);
    state.storedCtx = ctx;
    state.uiCtx = ctx.ui;
    state.sessionName = deriveSessionName(ctx.cwd ?? process.cwd());
    state.sessionReady = false;
    // Pre-populate knownWindows if session already exists.
    try {
      const out = await tmux(["list-windows", "-t", state.sessionName, "-F", "#{window_name}"]);
      out.split("\n").map((l) => l.trim()).filter(Boolean).forEach((w) => knownWindows.add(w));
      state.sessionReady = true;
    } catch {
      knownWindows.clear();
    }
    updateFooter();

    // Auto-start windows from config.
    const autostart = getConfig().terminal?.autostart ?? {};
    if (Object.keys(autostart).length > 0) {
      const cwd = ctx.cwd ?? process.cwd();
      const sess = await ensureSession(cwd).catch(() => undefined);
      if (sess) {
        for (const [winName, cmdArr] of Object.entries(autostart)) {
          const safeName = winName.replace(/[^A-Za-z0-9_-]/g, "-");
          if (await windowExists(sess, safeName)) continue;
          const cmdStr = cmdArr.map(shellQuote).join(" ");
          await tmux(["new-window", "-t", sess, "-n", safeName, "-c", cwd, "bash", "-lc", cmdStr]).catch(() => {});
          knownWindows.add(safeName);
        }
        // Remove the default shell window that `new-session` always creates.
        await killSentinelWindow(sess);
        updateFooter();
      }
    }
  });

  pi.on("tool_execution_start", async (_event, ctx) => { state.uiCtx = ctx.ui; });

  pi.on("before_agent_start", async (event) => {
    return { systemPrompt: event.systemPrompt + "\n\n" + TERMINAL_INSTRUCTION };
  });
  pi.on("agent_end", async (_event, ctx) => { state.uiCtx = ctx.ui; updateFooter(); });

  // Open a file in a pager (less -R) in a dedicated tmux window.
  // Emitted by the subagents and memory extensions for "View session" / "View file".
  pi.events.on("terminal:open-pager", async (data: any) => {
    const file   = data?.file as string | undefined;
    const window = (data?.window as string | undefined) ?? "pager";
    const follow = data?.follow === true; // Enable tail/follow mode if explicitly set
    if (!file) {
      debug("terminal:open-pager ignored — no file provided", data);
      return;
    }
    debug("terminal:open-pager", { file, window, follow });
    const cwd = state.storedCtx?.cwd ?? process.cwd();
    let sess: string;
    try {
      sess = await ensureSession(cwd);
    } catch (err) {
      debug("terminal:open-pager ensureSession failed", err);
      state.uiCtx?.notify(
        `Could not open pager: ${err instanceof Error ? err.message : String(err)}`,
        "warning",
      );
      return;
    }
    // Sanitise window name (tmux rejects most special chars).
    const winName = window.replace(/[^A-Za-z0-9_.()-]/g, "-").slice(0, 48);
    const exists  = await windowExists(sess, winName);
    if (exists) {
      debug("terminal:open-pager window already exists — focusing", winName);
    } else {
      // Use less with -R (ANSI colors), -S (chop long lines), +F (follow mode if tailing)
      const pagerCmd = getPagerCommand(file, follow);
      debug("terminal:open-pager spawning window", { winName, pagerCmd });
      await tmux(["new-window", "-t", sess, "-n", winName, "-c", cwd, "bash", "-lc", pagerCmd]);
      knownWindows.add(winName);
      await killSentinelWindow(sess);
      updateFooter();
      debug("terminal:open-pager window created", winName);
    }
    state.focusWindow = winName;
    if (state.storedCtx) {
      await openFocusModal(state.storedCtx, winName);
    } else {
      debug("terminal:open-pager no storedCtx — cannot open focus modal");
    }
  });

  // Allow other extensions to request session creation.
  pi.events.on("terminal:ensure-session", async (data: any) => {
    const cwd = data?.cwd ?? state.storedCtx?.cwd ?? process.cwd();
    debug("terminal:ensure-session requested", cwd);
    await ensureSession(cwd).catch(() => {});
  });

  // Open a file in an editor (default: vim) in a dedicated tmux window.
  // Emitted by the memory browser when no editor config is set.
  pi.events.on("terminal:open-editor", async (data: any) => {
    const file   = data?.file as string | undefined;
    const window = (data?.window as string | undefined) ?? "editor";
    if (!file) {
      debug("terminal:open-editor ignored — no file provided", data);
      return;
    }
    debug("terminal:open-editor", { file, window });
    const editor = process.env["EDITOR"] ?? "vim";
    const cmd    = `${editor} ${shellQuote(file)}`;
    await openInWindow(window, cmd, data?.cwd, data?.env);
  });

  // Open a command in a named tmux window and show the focus modal.
  // Emitted by the memory browser for non-external viewer/editor configs.
  pi.events.on("terminal:open-window", async (data: any) => {
    const cmdArr = data?.cmd as string[] | undefined;
    const window = (data?.window as string | undefined) ?? "terminal";
    if (!cmdArr?.length) {
      debug("terminal:open-window ignored — no cmd provided", data);
      return;
    }
    debug("terminal:open-window", { cmd: cmdArr, window });
    const cmd = cmdArr.map(shellQuote).join(" ");
    await openInWindow(window, cmd, data?.cwd, data?.env);
  });

  // Shared helper: create (or focus) a tmux window running `cmd`, then open the focus modal.
  async function openInWindow(window: string, cmd: string, cwdOverride?: string, env?: Record<string, string>): Promise<void> {
    const cwd     = cwdOverride ?? state.storedCtx?.cwd ?? process.cwd();
    let   sess: string;
    try {
      sess = await ensureSession(cwd);
    } catch (err) {
      debug("openInWindow ensureSession failed", err);
      state.uiCtx?.notify(
        `Could not open window: ${err instanceof Error ? err.message : String(err)}`,
        "warning",
      );
      return;
    }
    const winName = window.replace(/[^A-Za-z0-9_.()-]/g, "-").slice(0, 48);
    const exists  = await windowExists(sess, winName);
    if (exists) {
      debug("openInWindow window already exists — focusing", winName);
    } else {
      debug("openInWindow spawning window", { winName, cmd });
      const envEntries = env ? Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ") : "";
      const fullCmd    = envEntries ? `${envEntries} ${cmd}` : cmd;
      await tmux(["new-window", "-t", sess, "-n", winName, "-c", cwd, "bash", "-lc", fullCmd]);
      knownWindows.add(winName);
      await killSentinelWindow(sess);
      updateFooter();
      debug("openInWindow window created", winName);
    }
    state.focusWindow = winName;
    if (state.storedCtx) {
      await openFocusModal(state.storedCtx, winName);
    } else {
      debug("openInWindow no storedCtx — cannot open focus modal");
    }
  }

  // Emit terminal:session-ready when the managed session is first created.
  state.onSessionReady = (sess, cwd) => {
    debug("session-ready", sess, cwd);
    pi.events.emit("terminal:session-ready", { session: sess, cwd });
  };

  // Listen for windows created/removed by other extensions (e.g. git-hunk).
  pi.events.on("terminal:window-added", (data: any) => {
    if (typeof data?.window === "string") { knownWindows.add(data.window); updateFooter(); }
  });
  pi.events.on("terminal:window-removed", (data: any) => {
    if (typeof data?.window === "string") { knownWindows.delete(data.window); updateFooter(); }
  });

  pi.on("session_shutdown", async () => {
    // Cancel all watchers.
    for (const [, cleanup] of watchers) cleanup();
    watchers.clear();
    // Kill managed session.
    await killSession();
    // Close pane streams.
    for (const target of [...paneStreams.keys()]) {
      await closePaneStream(target).catch(() => {});
    }
    state.storedCtx = undefined;
    state.uiCtx?.setStatus("terminal", undefined);
    state.uiCtx = undefined;
    state.sessionReady = false;
  });

  // ── /terminal:focus ────────────────────────────────────────────────────────────

  pi.registerCommand("terminal", {
    description: "Open the tmux focus modal for a window: /terminal [window]",
    getArgumentCompletions: (prefix: string) => {
      if (knownWindows.size === 0) return [];
      const filtered = [...knownWindows].filter((w) => w.startsWith(prefix));
      return filtered.map((w) => ({ value: w, label: w }));
    },
    handler: async (args, ctx) => {
      const window = args?.trim() || undefined;
      if (window) state.focusWindow = window;
      await openFocusModal(ctx, window);
    },
  });

  // ── /terminal:run ────────────────────────────────────────────────────────────

  pi.registerCommand("terminal:run", {
    description: "Run a command in a named tmux window (window closes when done): /terminal:run <window> <command>",
    handler: async (args, ctx) => runInWindow(args, ctx, { keep: false }),
  });

  pi.registerCommand("terminal:run:keep", {
    description: "Run a command in a named tmux window (keeps shell open when done): /terminal:run:keep <window> <command>",
    handler: async (args, ctx) => runInWindow(args, ctx, { keep: true }),
  });

  async function runInWindow(args: string | undefined, ctx: any, opts: { keep: boolean }): Promise<void> {
      const input = args?.trim();
      if (!input) {
        ctx.ui.notify(`Usage: /terminal:run${opts.keep ? ":keep" : ""} <window> <command>\nExample: /terminal:run server npm run dev`, "warning");
        return;
      }
      const cwd = ctx.cwd ?? process.cwd();
      let sess: string;
      try {
        sess = await ensureSession(cwd);
      } catch (error) {
        ctx.ui.notify(
          `Could not start tmux session: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
        return;
      }

      // First word = window name, rest = command. One word = both.
      const spaceIdx = input.indexOf(" ");
      const winName = (spaceIdx === -1 ? input : input.slice(0, spaceIdx)).replace(/[^A-Za-z0-9_-]/g, "-");
      const command = spaceIdx === -1 ? input : input.slice(spaceIdx + 1).trim();

      const target = windowTarget(sess, winName);
      const exists = await windowExists(sess, winName);
      if (!exists) {
        const sent = wrapCmd(command, !opts.keep);
        await tmux(["new-window", "-t", sess, "-n", winName, "-c", cwd, "bash", "-lc", sent]);
        knownWindows.add(winName);
        // Remove the default shell window that `new-session` always creates.
        await killSentinelWindow(sess);
      }

      state.focusWindow = winName;
      ctx.ui.notify(`Sent to [${winName}]: ${command}`, "info");
      await openFocusModal(ctx, winName);
  }

  // ── /app:<name> — user-configured app launcher ───────────────────────────────

  function registerAppCommands(): void {
    const apps = getConfig().terminal?.apps ?? {};
    for (const [name, app] of Object.entries(apps)) {
      const winName = name.replace(/[^A-Za-z0-9_-]/g, "-");
      const cmdStr = app.cmd.map(shellQuote).join(" ");
      pi.registerCommand(`app:${name}`, {
        description: `Open ${name} (${app.cmd.join(" ")}) in a tmux window`,
        handler: async (args, ctx) => {
          // Check gitExclusive at invocation time.
          if (app.gitExclusive && !isGitRepo(ctx.cwd)) {
            ctx.ui.notify(`${name} is only available inside a git repository.`, "warning");
            return;
          }
          const cwd = ctx.cwd ?? process.cwd();
          let sess: string;
          try {
            sess = await ensureSession(cwd);
          } catch (error) {
            ctx.ui.notify(
              `Could not start tmux session: ${error instanceof Error ? error.message : String(error)}`,
              "warning",
            );
            return;
          }
          const target = windowTarget(sess, winName);
          const exists = await windowExists(sess, winName);
          if (!exists) {
            const sent = wrapCmd(cmdStr, app.autoClose ?? true);
            await tmux(["new-window", "-t", sess, "-n", winName, "-c", cwd, "bash", "-lc", sent]);
            knownWindows.add(winName);
            await killSentinelWindow(sess);
          }
          state.focusWindow = winName;
          await openFocusModal(ctx, winName);
        },
      });
    }
  }

  registerAppCommands();
  registerLauncherCommands();

  // ── /launcher:<name> — external fire-and-forget launcher ────────────────────

  function registerLauncherCommands(): void {
    const launchers = getConfig().terminal?.launch ?? {};
    for (const [name, launcher] of Object.entries(launchers)) {
      pi.registerCommand(`launch:${name}`, {
        description: `Launch ${name} externally (fire and forget): ${launcher.cmd.join(" ")}`,
        handler: async (args, ctx) => {
          if (launcher.gitExclusive && !isGitRepo(ctx.cwd)) {
            ctx.ui.notify(`${name} is only available inside a git repository.`, "warning");
            return;
          }
          const cwd = ctx.cwd ?? process.cwd();
          const argsStr = args?.trim() ?? "";
          const resolvedCmd = launcher.cmd
            .flatMap((token) => {
              if (token === "$ARGS") return argsStr ? [argsStr] : [];
              if (token === "$CWD") return [cwd];
              return [token.replace(/\$ARGS/g, argsStr).replace(/\$CWD/g, cwd)];
            });
          const [bin, ...argv] = resolvedCmd;
          const envOverrides: Record<string, string> = launcher.env ?? {};
          debug(`launch:${name} cwd=${cwd} bin=${bin} argv=${JSON.stringify(argv)} env=${JSON.stringify(envOverrides)}`);
          try {
            const child = spawn(bin, argv, {
              cwd,
              detached: true,
              stdio: "ignore",
              env: { ...process.env, ...envOverrides },
            });
            child.on("error", (err) => {
              debug(`launch:${name} spawn error: ${err.message}`);
              ctx.ui.notify(`Failed to launch ${name}: ${err.message}`, "warning");
            });
            child.unref();
            debug(`launch:${name} spawned pid=${child.pid}`);
            ctx.ui.notify(`Launched ${name}: ${launcher.cmd.join(" ")}`, "info");
          } catch (error) {
            ctx.ui.notify(
              `Failed to launch ${name}: ${error instanceof Error ? error.message : String(error)}`,
              "warning",
            );
          }
        },
      });
    }
  }

  // ── Tool registrations ───────────────────────────────────────────────────────

  registerTools(pi);
}
