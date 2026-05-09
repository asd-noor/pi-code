/**
 * notify extension for pi.
 *
 * Sends a macOS OS notification when the primary agent's turn ends.
 * Subagent sessions are ignored (detected via system-prompt marker).
 *
 * Commands:
 *   /notify on   — enable notifications (persisted in session)
 *   /notify off  — disable notifications
 *   /notify      — show current state
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "notify-state";
const FOOTER_KEY  = "notify";

export default function (pi: ExtensionAPI) {
  let enabled    = false;  // default: off
  let isPrimary  = false;
  // Typed as any — we only need ctx.ui (ExtensionUIContext), which isn't
  // directly exported; mirrors the pattern used in diff-watcher.
  let uiCtx: any;

  // ── macOS notification ───────────────────────────────────────────────────

  async function sendNotification(message: string): Promise<void> {
    // Escape backslashes then double-quotes for the AppleScript string literal.
    const body  = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    try {
      await pi.exec(
        "osascript",
        ["-e", `display notification "${body}" with title "pi"`],
        { timeout: 3000 },
      );
    } catch {
      // Best-effort — silently ignore if osascript is unavailable.
    }
  }

  // ── Footer badge ─────────────────────────────────────────────────────────

  function refreshFooter(): void {
    if (!uiCtx) return;
    uiCtx.setStatus(FOOTER_KEY, enabled ? "🔔 notify: on   " : undefined);
  }

  // ── Extract reply preview from agent_end messages ────────────────────────

  function extractPreview(messages: unknown[]): string {
    // Walk messages in reverse to find the last assistant message.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as Record<string, unknown>;
      if (msg?.role !== "assistant") continue;

      const content = msg.content;

      // Content can be a plain string.
      if (typeof content === "string" && content.trim()) {
        return trimPreview(content);
      }

      // Content can be an array of blocks: { type: "text", text: string }
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
            return trimPreview(b.text);
          }
        }
      }
    }
    return "Turn complete";
  }

  function trimPreview(text: string): string {
    const flat = text.trim().replace(/\n+/g, " ");
    return flat.length > 80 ? flat.slice(0, 77) + "…" : flat;
  }

  // ── Session start: restore persisted state ───────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    uiCtx   = ctx.ui;
    enabled = false;  // reset; restore below

    // Replay session entries — last matching entry wins.
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
        enabled = Boolean((entry.data as Record<string, unknown>)?.enabled);
      }
    }

    refreshFooter();
  });

  // ── before_agent_start: detect primary vs subagent ───────────────────────

  pi.on("before_agent_start", async (event) => {
    const sp = event.systemPrompt ?? "";
    isPrimary =
      !sp.includes("<sub_agent_context>") &&
      !sp.startsWith("You are a pi coding agent sub-agent.");
    refreshFooter();
  });

  // Keep uiCtx fresh during tool execution (ctx not available at agent_end in all paths).
  pi.on("tool_execution_start", async (_event, ctx) => { uiCtx = ctx.ui; });

  // ── agent_end: fire notification ─────────────────────────────────────────

  pi.on("agent_end", async (event, ctx) => {
    uiCtx = ctx.ui;
    if (!isPrimary || !enabled) return;

    const preview = extractPreview(((event as unknown) as { messages?: unknown[] }).messages ?? []);
    await sendNotification(preview);
  });

  // ── session_shutdown: cleanup ────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    uiCtx?.setStatus(FOOTER_KEY, undefined);
    uiCtx      = undefined;
    isPrimary  = false;
  });

  // ── /notify command ──────────────────────────────────────────────────────

  pi.registerCommand("notify", {
    description: "Toggle OS turn-end notifications: /notify on | off",
    getArgumentCompletions: (prefix: string) => {
      const opts = ["on", "off"].filter((s) => s.startsWith(prefix.toLowerCase()));
      return opts.length > 0 ? opts.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      uiCtx = ctx.ui;
      const sub = (args ?? "").trim().toLowerCase();

      if (sub === "on") {
        enabled = true;
        pi.appendEntry(CUSTOM_TYPE, { enabled: true });
        refreshFooter();
        ctx.ui.notify("Turn-end notifications enabled", "info");
      } else if (sub === "off") {
        enabled = false;
        pi.appendEntry(CUSTOM_TYPE, { enabled: false });
        refreshFooter();
        ctx.ui.notify("Turn-end notifications disabled", "info");
      } else {
        ctx.ui.notify(
          `Notifications are currently ${enabled ? "ON 🔔" : "OFF"}.\nUse /notify on or /notify off`,
          "info",
        );
      }
    },
  });
}
