/**
 * terminal extension for pi.
 *
 * Manages a dedicated tmux session for the project:
 *   - Session name: pi-tmux-<projectHash>
 *   - Session created on demand (first tool/command use)
 *   - Session auto-killed on session_shutdown
 *   - Works whether pi is inside tmux or not
 *
 * Tools: tmux_run, tmux_send_keys, tmux_capture,
 *        tmux_watch, tmux_unwatch
 *
 * Commands: /terminal [window], /terminal:editor <file>, /terminal:previewer <file>, /terminal:pager <file>
 * Commands: /terminal [window], /terminal:editor <file>, /terminal:previewer <file>, /terminal:pager <file>
 *
 * Future: tmux.apps config key for user-configurable tmux apps (not yet implemented).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig, isGitRepo, createLogger, getProjectTempDir } from "../_config/index.ts";
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
  windowTarget,
  windowExists,
  closePaneStream,
  openFocusModal,
  debug,
} from "./tmux.ts";
import { registerTools } from "./tools.ts";
import { TERMINAL_INSTRUCTION } from "./instruction.ts";

export default function (pi: ExtensionAPI): void {

  function updateFooter(): void {
    if (!state.uiCtx) return;
    const count = knownWindows.size;
    state.uiCtx.setStatus("terminal", count > 0 ? `| terminals: ${count}` : undefined);
  }

  // ── Session lifecycle ───────────────────────────────────────────────────────

  pi.on("session_start", async (event: any, ctx) => {
    if (event?.subagentMode) return; // skip in subagent sessions
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
        updateFooter();
      }
    }
  });

  pi.on("tool_execution_start", async (_event, ctx) => { state.uiCtx = ctx.ui; });

  pi.on("before_agent_start", async (event) => {
    return { systemPrompt: event.systemPrompt + "\n\n" + TERMINAL_INSTRUCTION };
  });
  pi.on("agent_end", async (_event, ctx) => { state.uiCtx = ctx.ui; updateFooter(); });

  // Allow other extensions to request session creation.
  pi.events.on("terminal:ensure-session", async (data: any) => {
    const cwd = data?.cwd ?? state.storedCtx?.cwd ?? process.cwd();
    debug("terminal:ensure-session requested", cwd);
    await ensureSession(cwd).catch(() => {});
  });

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

  // Open a file in the pager (used by subagents and other extensions).
  pi.events.on("terminal:open-pager", async (data: any) => {
    if (typeof data?.file !== "string") return;
    const cwd = state.storedCtx?.cwd ?? process.cwd();
    const pagerCmd = getConfig().terminal?.pagerCmd ?? "less -RS +F $FILE";
    const cmd = pagerCmd.replace(/\$FILE/g, shellQuote(data.file));
    const winName = typeof data.window === "string" ? data.window : "pi-code-pager";
    try {
      const sess = await ensureSession(cwd);
      if (await windowExists(sess, winName)) {
        await tmux(["kill-window", "-t", windowTarget(sess, winName)]).catch(() => {});
        knownWindows.delete(winName);
      }
      await tmux(["new-window", "-t", sess, "-n", winName, "-c", cwd, "bash", "-lc", wrapCmd(cmd, true)]);
      knownWindows.add(winName);
      if (state.storedCtx) await openFocusModal(state.storedCtx, winName);
    } catch (err) {
      state.storedCtx?.ui.notify(`terminal: could not open pager: ${err instanceof Error ? err.message : String(err)}`, "warning");
    }
  });

  pi.events.on("terminal:open-editor", async (data: any) => {
    if (typeof data?.file !== "string") return;
    const cwd = state.storedCtx?.cwd ?? process.cwd();
    const file = data.file.startsWith("/") ? data.file : resolve(cwd, data.file);
    const editorCmd = getConfig().terminal?.editorCmd ?? "vim $FILE";
    const cmd = editorCmd.replace(/\$FILE/g, shellQuote(file));
    const winName = `pi-code-editor-${file.split("/").pop()?.replace(/[^A-Za-z0-9_-]/g, "-") ?? "file"}`;
    try {
      const sess = await ensureSession(cwd);
      if (await windowExists(sess, winName)) {
        await tmux(["kill-window", "-t", windowTarget(sess, winName)]).catch(() => {});
        knownWindows.delete(winName);
      }
      await tmux(["new-window", "-t", sess, "-n", winName, "-c", cwd, "bash", "-lc", wrapCmd(cmd, true)]);
      knownWindows.add(winName);
      if (state.storedCtx) await openFocusModal(state.storedCtx, winName);
    } catch (err) {
      state.storedCtx?.ui.notify(`terminal: could not open editor: ${err instanceof Error ? err.message : String(err)}`, "warning");
    }
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
    // Delete the project temp root (logs, fifo, ptc scripts, subagent sessions).
    try {
      const tempDir = getProjectTempDir(state.storedCtx?.cwd);
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
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
      }

      state.focusWindow = winName;
      ctx.ui.notify(`Sent to [${winName}]: ${command}`, "info");
      await openFocusModal(ctx, winName);
  }

  // ── /terminal:previewer + /terminal:pager + /terminal:editor ───────────────

  async function openFileWindow(
    args: string | undefined,
    ctx: any,
    command: (file: string) => string,
    autoClose: boolean,
    usageName: string,
    winName: string,
  ): Promise<void> {
    const file = typeof args === "string" && args.trim() ? args.trim() : undefined;
    if (!file) {
      ctx.ui.notify(`Usage: /${usageName} <file>`, "warning");      return;
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
      const cmd = wrapCmd(command(file), autoClose);
      await tmux(["new-window", "-t", sess, "-n", winName, "-c", cwd, "bash", "-lc", cmd]);
      knownWindows.add(winName);
    }
    state.focusWindow = winName;
    await openFocusModal(ctx, winName);
  }

  pi.registerCommand("terminal:editor", {
    description: "Open a file in the editor in a tmux window: /terminal:editor [file]",
    handler: async (args, ctx) => {
      const tmuxCfg = getConfig().terminal;
      const cmdTpl = tmuxCfg?.editorCmd ?? "vim $FILE";
      const cwd = ctx.cwd ?? process.cwd();
      const file = args?.trim() || cwd;
      const absoluteFile = file.startsWith("/") ? file : resolve(cwd, file);
      const winName = `pi-code-editor-${absoluteFile.split("/").pop()?.replace(/[^A-Za-z0-9_-]/g, "-") ?? "file"}`;
      let sess: string;
      try {
        sess = await ensureSession(cwd);
      } catch (error) {
        ctx.ui.notify(`Could not start tmux session: ${error instanceof Error ? error.message : String(error)}`, "warning");
        return;
      }
      // Always kill existing window so the correct file is opened fresh.
      if (await windowExists(sess, winName)) {
        await tmux(["kill-window", "-t", windowTarget(sess, winName)]).catch(() => {});
        knownWindows.delete(winName);
      }
      const cmd = wrapCmd(cmdTpl.replace(/\$FILE/g, shellQuote(absoluteFile)), true);
      await tmux(["new-window", "-t", sess, "-n", winName, "-c", cwd, "bash", "-lc", cmd]);
      knownWindows.add(winName);
      state.focusWindow = winName;
      await openFocusModal(ctx, winName);
    },
  });

  pi.registerCommand("terminal:previewer", {
    description: "Render a file in a tmux window: /terminal:previewer <file>",
    handler: (args, ctx) => {
      const tmuxCfg = getConfig().terminal;
      const cmdTpl = tmuxCfg?.previewerCmd ?? "mcat $FILE; read -n1 -s -r -p $'\\nPress any key to close...'";
      return openFileWindow(args, ctx, (f) => cmdTpl.replace(/\$FILE/g, shellQuote(f)), false, "terminal:previewer", "pi-code-preview");
    },
  });

  pi.registerCommand("terminal:pager", {
    description: "Follow a file with less in a tmux window: /terminal:pager <file>",
    handler: (args, ctx) => {
      const tmuxCfg = getConfig().terminal;
      const cmdTpl = tmuxCfg?.pagerCmd ?? "less -RS +F $FILE";
      return openFileWindow(args, ctx, (f) => cmdTpl.replace(/\$FILE/g, shellQuote(f)), true, "terminal:pager", "pi-code-pager");
    },
  });

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
          }
          state.focusWindow = winName;
          await openFocusModal(ctx, winName);
        },
      });
    }
  }

  registerAppCommands();

  // ── Tool registrations ───────────────────────────────────────────────────────

  registerTools(pi);
}
