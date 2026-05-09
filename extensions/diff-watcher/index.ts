/**
 * diff-watcher extension for pi.
 *
 * Passively monitors active Hunk sessions by polling `hunk session list --json`
 * every 4 seconds. The Hunk TUI manages its own daemon — this extension does
 * NOT spawn any processes.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Module-level constants ────────────────────────────────────────────────────

const CACHE_BASE = join(homedir(), ".pi", "cache");
function encodeProjectPath(p: string): string { return p.replace(/\//g, "="); }

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let gitRoot:    string | undefined;
  let poller:     ReturnType<typeof setInterval> | undefined;
  let uiCtx:      any;
  let hunkOnPath  = false;

  // ── Footer helpers ────────────────────────────────────────────────────────

  function setFooter(label: string) { uiCtx?.setStatus("diff-watcher", label); }
  function clearFooter()            { uiCtx?.setStatus("diff-watcher", undefined); }

  // ── resolveGitRoot ────────────────────────────────────────────────────────

  async function resolveGitRoot(cwd: string): Promise<string | undefined> {
    try {
      const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 3000 });
      if (result.code === 0) return result.stdout.trim();
    } catch {}
    return undefined;
  }

  // ── isHunkOnPath ──────────────────────────────────────────────────────────

  async function isHunkOnPath(): Promise<boolean> {
    try {
      const result = await pi.exec("which", ["hunk"], { timeout: 3000 });
      return result.code === 0;
    } catch {
      return false;
    }
  }

  // ── listSessions ──────────────────────────────────────────────────────────

  async function listSessions(): Promise<any[]> {
    try {
      const result = await pi.exec("hunk", ["session", "list", "--json"], { timeout: 5000 });
      if (result.code !== 0 || !result.stdout.trim()) return [];
      const parsed = JSON.parse(result.stdout.trim());
      if (Array.isArray(parsed)) return parsed;
      // newer hunk versions wrap the list: { sessions: [...] }
      if (parsed && Array.isArray(parsed.sessions)) return parsed.sessions;
      return [];
    } catch {
      return [];
    }
  }

  // ── sessionCountLabel ─────────────────────────────────────────────────────

  function sessionCountLabel(n: number): string {
    if (n === 0) return "⬡ hunk: no sessions   ";
    if (n === 1) return "⬡ hunk: 1 session   ";
    return `⬡ hunk: ${n} sessions   `;
  }

  // ── Poller ────────────────────────────────────────────────────────────────

  function startPoller(): void {
    if (poller) return;
    poller = setInterval(async () => {
      const sessions = await listSessions();
      setFooter(sessionCountLabel(sessions.length));
    }, 4000);
  }

  function stopPoller(): void {
    if (poller) { clearInterval(poller); poller = undefined; }
  }

  // ── Events ────────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    uiCtx = ctx.ui;
    gitRoot = await resolveGitRoot(ctx.cwd);
    if (!gitRoot) return;

    hunkOnPath = await isHunkOnPath();
    if (!hunkOnPath) {
      setFooter("⬡ hunk: not installed   ");
      return;
    }

    // Show initial count immediately, then start polling
    const sessions = await listSessions();
    setFooter(sessionCountLabel(sessions.length));
    startPoller();
  });

  pi.on("tool_execution_start", async (_event, ctx) => { uiCtx = ctx.ui; });

  pi.on("session_shutdown", async () => {
    stopPoller();
    clearFooter();
    gitRoot = undefined;
    uiCtx = undefined;
    hunkOnPath = false;
  });

  pi.on("before_agent_start", async (event) => {
    if (!gitRoot || !hunkOnPath) return { systemPrompt: event.systemPrompt };

    const sessions = await listSessions();

    let hunkSection: string;
    if (sessions.length === 0) {
      hunkSection = `\n\n## Hunk diff viewer\n\nHunk is installed. No live Hunk sessions are currently open for this repository. If the user opens Hunk in their terminal (\`hunk diff\`, \`hunk show\`, etc.), you can interact with their session using \`hunk session *\` commands. Consult the hunk-review skill for the full reference.`;
    } else {
      const sessionList = sessions
        .map((s: any, i: number) => `  ${i + 1}. repo: ${s.repo ?? s.Repo ?? "unknown"} (id: ${s.id ?? s.Id ?? "?"})`)
        .join("\n");
      hunkSection = `\n\n## Hunk diff viewer\n\nThere ${sessions.length === 1 ? "is 1 active Hunk session" : `are ${sessions.length} active Hunk sessions`}:\n${sessionList}\n\nUse \`hunk session review --repo <path> --json\` to inspect a session, then \`navigate\` and \`comment\` to interact.\nConsult the hunk-review skill for the full command reference.`;
    }

    return { systemPrompt: event.systemPrompt + hunkSection };
  });

  // ── /diff-watcher command ─────────────────────────────────────────────────

  pi.registerCommand("diff-watcher", {
    description: "Show active Hunk sessions: status",
    getArgumentCompletions: (prefix: string) => {
      const matches = ["status"]
        .filter(s => s.startsWith(prefix.toLowerCase()))
        .map(s => ({ value: s, label: s }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      uiCtx = ctx.ui;
      const sub = (args ?? "").trim().toLowerCase();

      if (!gitRoot) {
        ctx.ui.notify("diff-watcher: no git repository detected", "warning");
        return;
      }

      if (sub === "status" || sub === "") {
        if (!hunkOnPath) {
          ctx.ui.notify("diff-watcher: hunk not found on PATH", "warning");
          return;
        }
        const sessions = await listSessions();
        if (sessions.length === 0) {
          ctx.ui.notify("No active Hunk sessions.\nOpen Hunk in your terminal with: hunk diff", "info");
        } else {
          const lines = sessions.map((s: any, i: number) =>
            `${i + 1}. ${s.repo ?? s.Repo ?? JSON.stringify(s)}`
          );
          ctx.ui.notify(`Active Hunk sessions:\n${lines.join("\n")}`, "info");
        }
      } else {
        ctx.ui.notify(`diff-watcher: unknown sub-command "${sub}". Use: status`, "warning");
      }
    },
  });
}
