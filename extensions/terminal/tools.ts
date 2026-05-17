/**
 * Tool registrations: tmux_run, tmux_send_keys, tmux_capture,
 * tmux_watch, tmux_unwatch.
 *
 * Call `registerTools(pi)` from the extension factory.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  state,
  watchers,
  knownWindows,
  tmux,
  shellQuote,
  ensureSession,
  windowTarget,
  resolveWindowTarget,
  windowExists,
  capturePaneText,
  subscribePaneOutput,
  DEFAULT_WAIT_TIMEOUT_MS,
  POLL_MS,
} from "./tmux.ts";

export function registerTools(pi: ExtensionAPI): void {

  // 1. tmux_run
  pi.registerTool({
    name: "tmux_run",
    label: "Tmux Run",
    description:
      "Run a shell command in a named window of the managed tmux session. Creates the window if it doesn't exist. Uses bash -lc wrapper. Tracks exit status. Optionally blocks until a regex matches output.",
    promptSnippet: "tmux_run: run a command in the managed tmux session",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run." }),
      window: Type.Optional(
        Type.String({ description: "Window name. Defaults to 'main'." }),
      ),
      cwd: Type.Optional(
        Type.String({ description: "Working directory. Defaults to pi cwd." }),
      ),
      wait_for: Type.Optional(
        Type.Object({
          regex: Type.String({ description: "Regex to match in pane output before returning." }),
          timeout_ms: Type.Optional(Type.Number({ description: "Timeout in ms. Default 30000." })),
          poll_ms: Type.Optional(Type.Number({ description: "Poll interval in ms. Default 500." })),
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = params.cwd ?? ctx.cwd ?? process.cwd();
      const sess = await ensureSession(cwd);
      const winName = (params.window ?? "main").replace(/[^A-Za-z0-9_-]/g, "-");
      const target = windowTarget(sess, winName);
      const exists = await windowExists(sess, winName);
      if (!exists) {
        await tmux(["new-window", "-t", sess, "-n", winName, "-c", cwd]);
        knownWindows.add(winName);
      }

      // Build bash -lc wrapper that tracks exit status via pane option.
      const cmd = `bash -lc ${shellQuote(
        `${params.command}\n` +
          `status=$?\n` +
          `tmux set-option -p -t "$TMUX_PANE" @pi_tmux_run_status "$status" 2>/dev/null || true`,
      )}`;
      await tmux(["send-keys", "-t", target, "-l", cmd]);
      await tmux(["send-keys", "-t", target, "Enter"]);

      if (params.wait_for) {
        const timeoutMs = params.wait_for.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS;
        const pollMs = params.wait_for.poll_ms ?? POLL_MS;
        const regex = new RegExp(params.wait_for.regex, "m");
        const start = Date.now();
        while (true) {
          if (signal?.aborted) break;
          const out = await capturePaneText(target);
          if (regex.test(out)) {
            return {
              content: [{ type: "text" as const, text: `Command sent to ${target}. Regex matched.` }],
              details: { target, matched: true },
            };
          }
          if (Date.now() - start >= timeoutMs) {
            return {
              content: [{ type: "text" as const, text: `Command sent to ${target}. Timed out waiting for regex.` }],
              details: { target, matched: false, timedOut: true },
            };
          }
          await new Promise<void>((r) => setTimeout(r, pollMs));
        }
      }

      return {
        content: [{ type: "text" as const, text: `Command sent to ${target}.` }],
        details: { target },
      };
    },
    renderCall(args, theme) {
      const a = args as { command?: unknown; window?: unknown };
      const label = `${String(a.command ?? "")}${a.window ? ` [${a.window}]` : ""}`;
      return new Text(
        theme.fg("toolTitle", "tmux_run ") + theme.fg("dim", label.slice(0, 120)),
        0,
        0,
      );
    },
    renderResult(_result, _options, theme) {
      return new Text(theme.fg("success", "Command sent."), 0, 0);
    },
  });

  // 2. tmux_send_keys
  pi.registerTool({
    name: "tmux_send_keys",
    label: "Tmux Send Keys",
    description:
      "Send raw keystrokes to a window in the managed tmux session (e.g. C-c, Enter, q).",
    promptSnippet: "tmux_send_keys: send keystrokes to the tmux session",
    parameters: Type.Object({
      keys: Type.String({ description: "Keys to send, e.g. 'C-c', 'Enter', 'q'." }),
      window: Type.Optional(Type.String({ description: "Window name. Defaults to first window." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd ?? process.cwd();
      const sess = await ensureSession(cwd);
      const target = await resolveWindowTarget(sess, params.window);
      await tmux(["send-keys", "-t", target, params.keys]);
      return {
        content: [{ type: "text" as const, text: `Keys sent to ${target}.` }],
        details: { target, keys: params.keys },
      };
    },
    renderCall(args, theme) {
      const a = args as { keys?: unknown; window?: unknown };
      return new Text(
        theme.fg("toolTitle", "tmux_send_keys ") + theme.fg("dim", String(a.keys ?? "")),
        0,
        0,
      );
    },
    renderResult(_result, _options, theme) {
      return new Text(theme.fg("success", "Keys sent."), 0, 0);
    },
  });

  // 3. tmux_capture
  pi.registerTool({
    name: "tmux_capture",
    label: "Tmux Capture",
    description: "Capture the current visible output of a target window/pane.",
    promptSnippet: "tmux_capture: capture current output of a tmux window",
    parameters: Type.Object({
      window: Type.Optional(Type.String({ description: "Window name. Defaults to first window." })),
      tail_lines: Type.Optional(
        Type.Number({ description: "Return only the last N lines. Defaults to all." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd ?? process.cwd();
      const sess = await ensureSession(cwd);
      const target = await resolveWindowTarget(sess, params.window);
      const raw = await capturePaneText(target);
      let lines = raw.split("\n");
      if (typeof params.tail_lines === "number" && params.tail_lines > 0) {
        lines = lines.slice(-params.tail_lines);
      }
      const output = lines.join("\n");
      return {
        content: [{ type: "text" as const, text: output }],
        details: { target, lines: lines.length },
      };
    },
    renderCall(args, theme) {
      const a = args as { window?: unknown };
      return new Text(
        theme.fg("toolTitle", "tmux_capture") +
          (a.window ? theme.fg("dim", ` [${a.window}]`) : ""),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const d = result.details as { lines?: number } | undefined;
      return new Text(theme.fg("success", `Captured ${d?.lines ?? "?"} lines.`), 0, 0);
    },
  });

  // 4. tmux_watch
  pi.registerTool({
    name: "tmux_watch",
    label: "Tmux Watch",
    description:
      "Start an async pattern watcher on a tmux window. When output matches the regex, triggers a follow-up AI turn. Returns a watcher ID.",
    promptSnippet: "tmux_watch: async watch a tmux window for a regex pattern",
    parameters: Type.Object({
      regex: Type.String({ description: "JavaScript regex to match against pane output." }),
      window: Type.Optional(Type.String({ description: "Window to watch. Defaults to first window." })),
      timeout_ms: Type.Optional(Type.Number({ description: "Auto-cancel after N ms." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd ?? process.cwd();
      const sess = await ensureSession(cwd);
      const target = await resolveWindowTarget(sess, params.window);
      const regex = new RegExp(params.regex, "m");
      const watchId = `w${++state.watcherIdCounter}`;

      let unsubscribe: (() => Promise<void>) | undefined;
      let timeoutHandle: NodeJS.Timeout | undefined;

      function cleanup() {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (unsubscribe) void unsubscribe().catch(() => {});
        watchers.delete(watchId);
      }

      void subscribePaneOutput(target, (chunk) => {
        if (regex.test(chunk)) {
          cleanup();
          pi.sendMessage({
            customType: "tmux-watch-match",
            content: `Tmux watcher ${watchId} matched regex ${JSON.stringify(params.regex)} in window ${target}.`,
            display: false,
            details: { watchId, target, regex: params.regex },
          }, { deliverAs: "followUp", triggerTurn: true });
        }
      }).then((unsub) => {
        unsubscribe = unsub;
      }).catch(() => {
        watchers.delete(watchId);
      });

      watchers.set(watchId, cleanup);

      if (typeof params.timeout_ms === "number" && params.timeout_ms > 0) {
        timeoutHandle = setTimeout(() => {
          cleanup();
        }, params.timeout_ms);
      }

      return {
        content: [{ type: "text" as const, text: `Watcher ${watchId} started on ${target}.` }],
        details: { watchId, target },
      };
    },
    renderCall(args, theme) {
      const a = args as { regex?: unknown };
      return new Text(
        theme.fg("toolTitle", "tmux_watch ") + theme.fg("dim", String(a.regex ?? "")),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const d = result.details as { watchId?: string } | undefined;
      return new Text(theme.fg("success", `Watcher ${d?.watchId ?? "?"} started.`), 0, 0);
    },
  });

  // 5. tmux_unwatch
  pi.registerTool({
    name: "tmux_unwatch",
    label: "Tmux Unwatch",
    description: "Cancel a tmux watcher by ID.",
    promptSnippet: "tmux_unwatch: cancel a tmux pattern watcher",
    parameters: Type.Object({
      watch_id: Type.String({ description: "Watcher ID returned by tmux_watch." }),
    }),
    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const cleanup = watchers.get(params.watch_id);
      if (cleanup) {
        cleanup();
        return Promise.resolve({
          content: [{ type: "text" as const, text: `Watcher ${params.watch_id} cancelled.` }],
          details: { watchId: params.watch_id, found: true },
        });
      }
      return Promise.resolve({
        content: [{ type: "text" as const, text: `Watcher ${params.watch_id} not found (may have already fired or been cancelled).` }],
        details: { watchId: params.watch_id, found: false },
      });
    },
    renderCall(args, theme) {
      const a = args as { watch_id?: unknown };
      return new Text(
        theme.fg("toolTitle", "tmux_unwatch ") + theme.fg("dim", String(a.watch_id ?? "")),
        0,
        0,
      );
    },
    renderResult(_result, _options, theme) {
      return new Text(theme.fg("success", "Watcher cancelled."), 0, 0);
    },
  });
}
