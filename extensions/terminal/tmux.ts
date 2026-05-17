/**
 * Core tmux helpers, shared state, pane-stream registry, and the
 * TmuxFocusModal component. Everything that was above the `export default`
 * factory in the original monolithic index.ts.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  Key,
  Text,
  decodeKittyPrintable,
  matchesKey,
  parseKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, promises as fsp } from "node:fs";
import type { ReadStream } from "node:fs";
import { join } from "node:path";
import { getProjectHash, createLogger, getProjectTempDir } from "../_config/index.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

export const VISIBLE_LINES = 16;
export const POLL_MS = 500;
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const CONTENT_PADDING = 1;
export const WHEEL_SCROLL_LINES = 3;
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const CAPTURE_LINES = 200;

// ── Shared mutable state ──────────────────────────────────────────────────────
//
// Wrapped in an object so that cross-module writes work correctly in both ESM
// and CJS contexts (you cannot reassign an imported `let` binding from another
// module, but you CAN mutate a property of an imported object).

export const state = {
  storedCtx: undefined as ExtensionContext | undefined,
  uiCtx: undefined as any,
  /** The managed tmux session name for the current project. */
  sessionName: undefined as string | undefined,
  /** Hook called when the managed session is first created. Set by the factory. */
  onSessionReady: undefined as ((sess: string, cwd: string) => void) | undefined,
  /** Whether the managed session has been created. */
  sessionReady: false,
  /** The current "focused" window name for the modal. */
  focusWindow: undefined as string | undefined,
  /** Whether the focus modal is currently open. */
  focusModalOpen: false,
  /** Counter for watcher IDs. */
  watcherIdCounter: 0,
  /** Logger instance — replaced on each session_start. */
  logger: createLogger("terminal"),
};

// ── Logger ────────────────────────────────────────────────────────────────────

export function debug(...args: unknown[]): void { state.logger.log(...args); }

// ── In-memory cache of known window names / pane streams ─────────────────────

/** In-memory cache of known window names in the managed session. */
export const knownWindows = new Set<string>();
/** Active watchers: id → cleanup function. */
export const watchers = new Map<string, () => void>();

type PaneSubscriber = (chunk: string) => void;
type PaneStream = {
  target: string;
  fifoPath: string;
  stream: ReadStream;
  subscribers: Set<PaneSubscriber>;
};

export const paneStreams = new Map<string, PaneStream>();
export const paneStreamCreates = new Map<string, Promise<PaneStream>>();

// ── Core tmux runner ──────────────────────────────────────────────────────────

export function tmux(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Wrap a shell command for tmux execution.
 * - autoClose: kill window immediately when command exits
 * - keep: pause for keypress then kill window
 */
export function wrapCmd(cmd: string, autoClose = true): string {
  if (autoClose) return `${cmd}; tmux kill-window -t "$TMUX_PANE"`;
  return `${cmd}; read -n1 -s -r -p $'\nPress any key to close...'; tmux kill-window -t "$TMUX_PANE"`;
}

// ── Session management ────────────────────────────────────────────────────────

/**
 * Derive the managed session name for `cwd`.
 * Format: pi-tmux-<12-char projectHash>
 */
export function deriveSessionName(cwd: string): string {
  return `pi-tmux-${getProjectHash(cwd)}`;
}

/** Ensure the managed session exists, creating it on demand. */
export async function ensureSession(cwd: string): Promise<string> {
  if (!state.sessionName) {
    state.sessionName = deriveSessionName(cwd);
  }
  if (state.sessionReady) return state.sessionName;
  // Check whether session already exists (e.g. leftover from prior pi run).
  try {
    await tmux(["has-session", "-t", state.sessionName]);
    // Populate known windows from existing session.
    try {
      const out = await tmux(["list-windows", "-t", state.sessionName, "-F", "#{window_name}"]);
      out.split("\n").map((l) => l.trim()).filter(Boolean).forEach((w) => knownWindows.add(w));
    } catch {}
    state.sessionReady = true;
    state.onSessionReady?.(state.sessionName, cwd); // also fire for existing sessions
    return state.sessionName;
  } catch {
    // Session does not exist — create it.
  }
  await tmux(["new-session", "-d", "-s", state.sessionName, "-c", cwd]);
  state.sessionReady = true;
  state.onSessionReady?.(state.sessionName, cwd);
  return state.sessionName;
}

/** Kill the managed session. Called on session_shutdown. */
export async function killSession(): Promise<void> {
  if (!state.sessionName || !state.sessionReady) return;
  try {
    await tmux(["kill-session", "-t", state.sessionName]);
  } catch {
    // Ignore — session may already be gone.
  } finally {
    state.sessionReady = false;
    knownWindows.clear();
  }
}

/** Return the fully qualified tmux target for a named window in the managed session. */
export function windowTarget(sess: string, window: string): string {
  return `${sess}:${window}`;
}

/** Check whether a window name exists in the managed session. */
export async function windowExists(sess: string, window: string): Promise<boolean> {
  try {
    await tmux(["list-windows", "-t", sess, "-F", "#{window_name}"]);
    const out = await tmux(["list-windows", "-t", sess, "-F", "#{window_name}"]);
    return out.split("\n").map((l) => l.trim()).includes(window);
  } catch {
    return false;
  }
}

/** Resolve a window target: use named window if given, else managed session first window. */
export async function resolveWindowTarget(sess: string, window?: string): Promise<string> {
  if (window) return windowTarget(sess, window);
  // Use the first window.
  const out = await tmux(["list-windows", "-t", sess, "-F", "#{window_name}"]);
  const first = out.split("\n").map((l) => l.trim()).filter(Boolean)[0];
  if (!first) throw new Error("No windows found in managed tmux session.");
  return windowTarget(sess, first);
}

// ── Pane stream (pipe-pane via FIFO) ─────────────────────────────────────────

export async function createPaneStream(target: string, cwd: string): Promise<PaneStream> {
  try {
    const fifoDir = join(getProjectTempDir(cwd), "fifo");
    const fifoPath = join(fifoDir, `pi-tmux-${process.pid}-${randomBytes(6).toString("hex")}.fifo`);
    await new Promise<void>((resolve, reject) => {
      execFile("mkfifo", [fifoPath], (err) => (err ? reject(err) : resolve()));
    });
    const stream = createReadStream(fifoPath, { encoding: "utf8" });
    const paneStream: PaneStream = {
      target,
      fifoPath,
      stream,
      subscribers: new Set(),
    };
    stream.on("data", (chunk) => {
      for (const sub of paneStream.subscribers) sub(chunk as string);
    });
    stream.on("error", () => {
      void closePaneStream(target).catch(() => {});
    });
    stream.on("end", () => {
      // Window was closed naturally — remove from registry and refresh footer.
      const winName = target.includes(":") ? target.split(":").slice(1).join(":") : target;
      knownWindows.delete(winName);
      const count = knownWindows.size;
      state.uiCtx?.setStatus("terminal", count > 0 ? `| terminals: ${count}` : undefined);
      void closePaneStream(target).catch(() => {});
    });
    await tmux(["pipe-pane", "-O", "-t", target, `cat > ${shellQuote(fifoPath)}`]);
    paneStreams.set(target, paneStream);
    paneStreamCreates.delete(target);
    return paneStream;
  } catch (error) {
    paneStreamCreates.delete(target);
    throw error;
  }
}

export async function closePaneStream(target: string): Promise<void> {
  const ps = paneStreams.get(target);
  if (!ps) return;
  paneStreams.delete(target);
  paneStreamCreates.delete(target);
  ps.stream.removeAllListeners("end"); // prevent knownWindows.delete on intentional close
  await tmux(["pipe-pane", "-t", target]).catch(() => {});
  ps.stream.destroy();
  await fsp.unlink(ps.fifoPath).catch(() => {});
}

export async function subscribePaneOutput(
  target: string,
  subscriber: PaneSubscriber,
  onEnd?: () => void,
  cwd?: string,
): Promise<() => Promise<void>> {
  let ps = paneStreams.get(target);
  if (!ps) {
    const pending =
      paneStreamCreates.get(target) ?? createPaneStream(target, cwd ?? state.storedCtx?.cwd ?? process.cwd());
    paneStreamCreates.set(target, pending);
    ps = await pending;
  }
  if (onEnd) ps.stream.once("end", onEnd);
  ps.subscribers.add(subscriber);
  return async () => {
    const active = paneStreams.get(target);
    if (!active) return;
    active.subscribers.delete(subscriber);
    if (active.subscribers.size === 0) {
      await closePaneStream(target);
    }
  };
}

// ── Capture helpers ───────────────────────────────────────────────────────────

export async function capturePaneText(target: string): Promise<string> {
  return tmux(["capture-pane", "-p", "-J", "-S", `-${CAPTURE_LINES}`, "-t", target]);
}

function skipEscapeSequence(value: string, position: number): number {
  const next = value[position + 1];
  if (!next) return 1;
  if (next === "[") {
    for (let i = position + 2; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i + 1 - position;
    }
    return value.length - position;
  }
  if (next === "]" || next === "P" || next === "_" || next === "^") {
    for (let i = position + 2; i < value.length; i++) {
      if (value[i] === "\x07") return i + 1 - position;
      if (value[i] === "\x1b" && value[i + 1] === "\\") return i + 2 - position;
    }
    return value.length - position;
  }
  return 2;
}

/**
 * Insert an underline cursor indicator at visible column `col` in an
 * ANSI-escaped string. Skips over escape sequences when counting columns.
 */
export function insertCursorAt(line: string, col: number): string {
  let visCol = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      i += skipEscapeSequence(line, i);
      continue;
    }
    if (visCol === col) {
      const ch = line[i] ?? " ";
      return line.slice(0, i) + "\x1b[4m" + ch + "\x1b[24m" + line.slice(i + ch.length);
    }
    const cp = line.codePointAt(i) ?? 0;
    i += String.fromCodePoint(cp).length;
    visCol++;
  }
  // Cursor past end of line — append underlined space.
  return line + "\x1b[4m \x1b[24m";
}

function sanitizePaneLine(line: string): string {
  let result = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      const sgr = line.slice(i).match(/^\x1b\[[0-9;:]*m/);
      if (sgr) {
        result += sgr[0];
        i += sgr[0].length;
      } else {
        i += skipEscapeSequence(line, i);
      }
      continue;
    }
    const code = line.codePointAt(i) ?? 0;
    const char = String.fromCodePoint(code);
    if (char === "\t") {
      result += " ";
    } else if ((code >= 0x20 && code < 0x7f) || code > 0x9f) {
      result += char;
    }
    i += char.length;
  }
  return result;
}

export async function capturePaneDisplayLines(target: string): Promise<string[]> {
  const output = await tmux([
    "capture-pane", "-p", "-e", "-J", "-S", `-${CAPTURE_LINES}`, "-t", target,
  ]);
  const trimmed = output.replace(/\s+$/g, "");
  return (trimmed ? trimmed.split("\n") : [""]).map(sanitizePaneLine);
}

// ── Scroll helpers ────────────────────────────────────────────────────────────

export function maxScrollOffset(lineCount: number, visibleLines: number): number {
  return Math.max(0, lineCount - visibleLines);
}

export function clampScrollOffset(offset: number, lineCount: number, visibleLines: number): number {
  return Math.min(Math.max(0, offset), maxScrollOffset(lineCount, visibleLines));
}

export function parseSgrMouse(data: string): { button: number; x: number; y: number } | undefined {
  const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/);
  if (!match) return undefined;
  return { button: Number(match[1]), x: Number(match[2]), y: Number(match[3]) };
}

export function wheelScrollDelta(data: string): number | undefined {
  const mouse = parseSgrMouse(data);
  if (!mouse || (mouse.button & 64) === 0) return undefined;
  const wheelButton = mouse.button & 3;
  if (wheelButton === 0) return -WHEEL_SCROLL_LINES;
  if (wheelButton === 1) return WHEEL_SCROLL_LINES;
  return undefined;
}

// ── Mouse reporting ───────────────────────────────────────────────────────────

let mouseReportingRefCount = 0;

export function enableMouseReporting(): void {
  if (!process.stdout.isTTY) return;
  if (mouseReportingRefCount++ === 0) {
    process.stdout.write("\x1b[?1000h\x1b[?1006h");
  }
}

export function disableMouseReporting(): void {
  if (!process.stdout.isTTY || mouseReportingRefCount === 0) return;
  mouseReportingRefCount--;
  if (mouseReportingRefCount === 0) {
    process.stdout.write("\x1b[?1006l\x1b[?1000l");
  }
}

// ── Status glyph ─────────────────────────────────────────────────────────────

export function statusGlyph(): string {
  return SPINNER_FRAMES[Math.floor(Date.now() / POLL_MS) % SPINNER_FRAMES.length];
}

// ── Key forwarding ────────────────────────────────────────────────────────────

export function isPrintableText(data: string): boolean {
  return (
    data.length > 0 &&
    !data.startsWith("\x1b") &&
    Array.from(data).every((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
  );
}

export function toTmuxKey(key: string): string | undefined {
  const special: Record<string, string> = {
    escape: "Escape",
    esc: "Escape",
    enter: "Enter",
    return: "Enter",
    tab: "Tab",
    backspace: "BSpace",
    delete: "DC",
    insert: "IC",
    home: "Home",
    end: "End",
    pageUp: "PPage",
    pageDown: "NPage",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
    f1: "F1", f2: "F2", f3: "F3", f4: "F4",
    f5: "F5", f6: "F6", f7: "F7", f8: "F8",
    f9: "F9", f10: "F10", f11: "F11", f12: "F12",
  };
  if (special[key]) return special[key];
  const parts = key.split("+");
  const base = parts.pop();
  if (!base) return undefined;
  const tmuxBase = special[base] || base;
  const modifiers = parts
    .map((part) => ({ ctrl: "C", shift: "S", alt: "M" } as Record<string, string>)[part])
    .filter(Boolean);
  if (modifiers.length === 0) return undefined;
  return `${modifiers.join("-")}-${tmuxBase}`;
}

export function sendTmuxInput(target: string, data: string): Promise<void> {
  const printable = decodeKittyPrintable(data) ?? (isPrintableText(data) ? data : undefined);
  if (printable !== undefined) {
    return tmux(["send-keys", "-t", target, "-l", printable]).then(() => {});
  }
  const key = parseKey(data);
  const tmuxKey = key ? toTmuxKey(key) : undefined;
  if (tmuxKey) {
    return tmux(["send-keys", "-t", target, tmuxKey]).then(() => {});
  }
  return tmux(["send-keys", "-t", target, "-l", data]).then(() => {});
}

// ── TmuxFocusModal ────────────────────────────────────────────────────────────

export class TmuxFocusModal implements Component {
  private lines: string[] = [];
  private pendingLine = "";
  private error: string | undefined;
  private scrollOffset = 0;
  private cursorX = 0;
  private cursorY = 0;
  private lastResize = "";
  private unsubscribeStream?: () => Promise<void>;
  private refreshTimer?: NodeJS.Timeout;
  private refreshRunning = false;
  private refreshAgain = false;
  private disposed = false;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private target: string,
    private title: string,
    private done: () => void,
  ) {
    enableMouseReporting();
    void this.initialize();
  }

  private visibleLines(): number {
    return Math.max(1, this.tui.terminal.rows - 2);
  }

  private lineCount(): number {
    return this.lines.length + (this.pendingLine ? 1 : 0);
  }

  private async initialize(): Promise<void> {
    try {
      this.unsubscribeStream = await subscribePaneOutput(
        this.target,
        (chunk) => this.appendChunk(chunk),
        () => { if (!this.disposed) this.done(); },
      );
      if (this.disposed) {
        await this.unsubscribeStream().catch(() => {});
        this.unsubscribeStream = undefined;
        return;
      }
      await this.refreshOutput();
      if (this.disposed) return;
      this.scrollOffset = maxScrollOffset(this.lineCount(), this.visibleLines());
    } catch (error) {
      if (this.disposed) return;
      this.error = error instanceof Error ? error.message : String(error);
      this.tui.requestRender();
      return;
    }
    if (!this.disposed) this.tui.requestRender();
  }

  private appendChunk(_chunk: string): void {
    this.scheduleOutputRefresh();
  }

  private scheduleOutputRefresh(): void {
    if (this.disposed || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshOutput();
    }, 16);
  }

  private async refreshOutput(): Promise<void> {
    if (this.disposed) return;
    if (this.refreshRunning) {
      this.refreshAgain = true;
      return;
    }
    this.refreshRunning = true;
    const visibleLines = this.visibleLines();
    const wasAtBottom = this.scrollOffset >= maxScrollOffset(this.lineCount(), visibleLines);
    try {
      const lines = await capturePaneDisplayLines(this.target);
      if (this.disposed) return;
      this.lines = lines;
      this.pendingLine = "";
      this.scrollOffset = wasAtBottom
        ? maxScrollOffset(this.lineCount(), visibleLines)
        : clampScrollOffset(this.scrollOffset, this.lineCount(), visibleLines);
      this.error = undefined;
      try {
        const pos = await tmux(["display-message", "-p", "-t", this.target, "#{cursor_x} #{cursor_y}"]);
        const [cx, cy] = pos.trim().split(" ").map(Number);
        this.cursorX = cx ?? 0;
        this.cursorY = cy ?? 0;
      } catch { /* ignore */ }
    } catch (error) {
      if (!this.disposed)
        this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.refreshRunning = false;
      if (!this.disposed) {
        this.tui.requestRender();
        if (this.refreshAgain) {
          this.refreshAgain = false;
          this.scheduleOutputRefresh();
        }
      }
    }
  }

  handleInput(data: string): void {
    const delta = wheelScrollDelta(data);
    if (delta !== undefined) {
      this.scrollOffset = clampScrollOffset(
        this.scrollOffset + delta,
        this.lineCount(),
        this.visibleLines(),
      );
      this.tui.requestRender();
      return;
    }
    if (parseSgrMouse(data)) return;
    if (matchesKey(data, Key.ctrl("q"))) {
      this.done();
      return;
    }
    void sendTmuxInput(this.target, data)
      .then(() => this.tui.requestRender())
      .catch((err) => {
        this.error = err instanceof Error ? err.message : String(err);
        this.tui.requestRender();
      });
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerW = Math.max(1, width - 2);
    const visibleLines = this.visibleLines();
    const tmuxW = Math.max(1, innerW - CONTENT_PADDING * 2);
    const resizeKey = `${tmuxW}x${visibleLines}`;
    if (resizeKey !== this.lastResize) {
      this.lastResize = resizeKey;
      void tmux([
        "resize-window", "-t", this.target,
        "-x", String(tmuxW), "-y", String(visibleLines),
      ]).catch(() => {});
    }

    const border = (s: string) => th.fg("borderAccent", s);
    const shortcut = (s: string) => th.fg("accent", s);
    const dim = (s: string) => th.fg("dim", s);
    const reset = "\x1b[0m";
    const pad = (s: string) =>
      truncateToWidth(s, innerW, "…", true).padEnd(
        Math.max(0, innerW - Math.max(0, visibleWidth(truncateToWidth(s, innerW, "…", true)))),
      );

    const result: string[] = [];
    const rawTitle = ` ${statusGlyph()} ${this.title} `;
    const maxTitleWidth = Math.max(1, innerW - 1);
    const title = truncateToWidth(rawTitle, maxTitleWidth, "…");
    const rightRuleWidth = Math.max(0, innerW - 1 - visibleWidth(title));
    result.push(border("╭─") + title + border(`${"─".repeat(rightRuleWidth)}╮`));

    const body = this.error
      ? [th.fg("error", `tmux: ${this.error}`)]
      : this.pendingLine
        ? [...this.lines, this.pendingLine]
        : this.lines;

    const visible = body.slice(this.scrollOffset, this.scrollOffset + visibleLines);
    const cursorLineInVisible = this.cursorY - this.scrollOffset;
    for (let i = 0; i < visibleLines; i++) {
      let line = visible[i] ?? "";
      if (i === cursorLineInVisible)
        line = insertCursorAt(line, this.cursorX);
      result.push(
        border("│") + pad(`${" ".repeat(CONTENT_PADDING)}${line}`) + reset + border("│"),
      );
    }

    const hints = [
      shortcut(" ctrl+q ") + dim("close"),
      dim("scroll wheel scrolls output"),
      dim("input sent to tmux"),
    ].join(border(" · "));
    const hintsWidth = visibleWidth(hints);
    const leftRuleWidth = Math.max(1, innerW - hintsWidth - 1);
    result.push(border("╰") + border("─".repeat(leftRuleWidth)) + hints + border("─╯"));
    return result;
  }

  invalidate(): void {}

  dispose(): void {
    disableMouseReporting();
    this.disposed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.unsubscribeStream) {
      void this.unsubscribeStream().catch(() => {});
      this.unsubscribeStream = undefined;
    }
  }
}

// ── Focus modal helper ────────────────────────────────────────────────────────

export async function openFocusModal(ctx: ExtensionContext, window?: string): Promise<void> {
  state.uiCtx = ctx.ui;
  if (!ctx.hasUI) {
    ctx.ui.notify("Focus modal requires a UI session.", "warning");
    return;
  }
  if (state.focusModalOpen) return;

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

  let target: string;
  try {
    target = await resolveWindowTarget(sess, window ?? state.focusWindow);
  } catch (error) {
    ctx.ui.notify(
      `Could not resolve tmux window: ${error instanceof Error ? error.message : String(error)}`,
      "warning",
    );
    return;
  }

  state.focusModalOpen = true;
  try {
    await (ctx.ui as any).custom(
      (tui: TUI, theme: Theme, _keybindings: unknown, done: () => void) =>
        new TmuxFocusModal(tui, theme, target, target, done),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "100%",
          maxHeight: "100%",
          margin: 0,
        },
      },
    );
  } finally {
    disableMouseReporting();
    state.focusModalOpen = false;
    // Refresh footer after modal closes.
    const count = knownWindows.size;
    state.uiCtx?.setStatus("terminal", count > 0 ? `| terminals: ${count}` : undefined);
  }
}
