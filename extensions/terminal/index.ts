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

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
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
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, mkdirSync, promises as fsp, rmSync } from "node:fs";
import type { ReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { getProjectHash, getConfig, isGitRepo, createLogger, getProjectTempDir } from "../_config/index.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const VISIBLE_LINES = 16;
const POLL_MS = 500;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const CONTENT_PADDING = 1;
const WHEEL_SCROLL_LINES = 3;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CAPTURE_LINES = 200;

// ── Module-level state ────────────────────────────────────────────────────────

let storedCtx: ExtensionContext | undefined;
let uiCtx: any;
/** The managed tmux session name for the current project. */
let sessionName: string | undefined;
/** Hook called when the managed session is first created. Set by the factory. */
let onSessionReady: ((sess: string, cwd: string) => void) | undefined;
/** Whether the managed session has been created. */
let sessionReady = false;
/** The current "focused" window name for the modal. */
let focusWindow: string | undefined;
/** Whether the focus modal is currently open. */
let focusModalOpen = false;
/** Counter for watcher IDs. */
let watcherIdCounter = 0;
/** Active watchers: id → cleanup function. */
const watchers = new Map<string, () => void>();

// ── Pane stream registry ──────────────────────────────────────────────────────

type PaneSubscriber = (chunk: string) => void;
type PaneStream = {
  target: string;
  fifoPath: string;
  stream: ReadStream;
  subscribers: Set<PaneSubscriber>;
};

let logger = createLogger("terminal");
function debug(...args: unknown[]): void { logger.log(...args); }

/** In-memory cache of known window names in the managed session. */
const knownWindows = new Set<string>();
const paneStreams = new Map<string, PaneStream>();

const paneStreamCreates = new Map<string, Promise<PaneStream>>();

function tmux(args: string[]): Promise<string> {
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Wrap a shell command for tmux execution.
 * - autoClose: kill window immediately when command exits
 * - keep: pause for keypress then kill window
 */
function wrapCmd(cmd: string, autoClose = true): string {
  if (autoClose) return `${cmd}; tmux kill-window -t "$TMUX_PANE"`;
  return `${cmd}; read -n1 -s -r -p $'\nPress any key to close...'; tmux kill-window -t "$TMUX_PANE"`;
}

// ── Session management ────────────────────────────────────────────────────────

/**
 * Derive the managed session name for `cwd`.
 * Format: pi-tmux-<12-char projectHash>
 */
function deriveSessionName(cwd: string): string {
  return `pi-tmux-${getProjectHash(cwd)}`;
}

/** Ensure the managed session exists, creating it on demand. */
async function ensureSession(cwd: string): Promise<string> {
  if (!sessionName) {
    sessionName = deriveSessionName(cwd);
  }
  if (sessionReady) return sessionName;
  // Check whether session already exists (e.g. leftover from prior pi run).
  try {
    await tmux(["has-session", "-t", sessionName]);
    // Populate known windows from existing session.
    try {
      const out = await tmux(["list-windows", "-t", sessionName, "-F", "#{window_name}"]);
      out.split("\n").map((l) => l.trim()).filter(Boolean).forEach((w) => knownWindows.add(w));
    } catch {}
    sessionReady = true;
    onSessionReady?.(sessionName, cwd); // also fire for existing sessions
    return sessionName;
  } catch {
    // Session does not exist — create it.
  }
  await tmux(["new-session", "-d", "-s", sessionName, "-c", cwd]);
  sessionReady = true;
  onSessionReady?.(sessionName, cwd);
  return sessionName;
}

/** Kill the managed session. Called on session_shutdown. */
async function killSession(): Promise<void> {
  if (!sessionName || !sessionReady) return;
  try {
    await tmux(["kill-session", "-t", sessionName]);
  } catch {
    // Ignore — session may already be gone.
  } finally {
    sessionReady = false;
    knownWindows.clear();
  }
}

/** Return the fully qualified tmux target for a named window in the managed session. */
function windowTarget(sess: string, window: string): string {
  return `${sess}:${window}`;
}

/** Check whether a window name exists in the managed session. */
async function windowExists(sess: string, window: string): Promise<boolean> {
  try {
    await tmux(["list-windows", "-t", sess, "-F", "#{window_name}"]);
    const out = await tmux(["list-windows", "-t", sess, "-F", "#{window_name}"]);
    return out.split("\n").map((l) => l.trim()).includes(window);
  } catch {
    return false;
  }
}

/** Resolve a window target: use named window if given, else managed session first window. */
async function resolveWindowTarget(sess: string, window?: string): Promise<string> {
  if (window) return windowTarget(sess, window);
  // Use the first window.
  const out = await tmux(["list-windows", "-t", sess, "-F", "#{window_name}"]);
  const first = out.split("\n").map((l) => l.trim()).filter(Boolean)[0];
  if (!first) throw new Error("No windows found in managed tmux session.");
  return windowTarget(sess, first);
}

// ── Pane stream (pipe-pane via FIFO) ─────────────────────────────────────────

async function createPaneStream(target: string, cwd: string): Promise<PaneStream> {
  try {
    const fifoDir = join(getProjectTempDir(cwd), "fifo");
    mkdirSync(fifoDir, { recursive: true });
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
      uiCtx?.setStatus("terminal", count > 0 ? `| terminals: ${count}` : undefined);
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

async function closePaneStream(target: string): Promise<void> {
  const ps = paneStreams.get(target);
  if (!ps) return;
  paneStreams.delete(target);
  paneStreamCreates.delete(target);
  ps.stream.removeAllListeners("end"); // prevent knownWindows.delete on intentional close
  await tmux(["pipe-pane", "-t", target]).catch(() => {});
  ps.stream.destroy();
  await fsp.unlink(ps.fifoPath).catch(() => {});
}

async function subscribePaneOutput(
  target: string,
  subscriber: PaneSubscriber,
  onEnd?: () => void,
  cwd?: string,
): Promise<() => Promise<void>> {
  let ps = paneStreams.get(target);
  if (!ps) {
    const pending =
      paneStreamCreates.get(target) ?? createPaneStream(target, cwd ?? storedCtx?.cwd ?? process.cwd());
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

async function capturePaneText(target: string): Promise<string> {
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
function insertCursorAt(line: string, col: number): string {
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

async function capturePaneDisplayLines(target: string): Promise<string[]> {
  const output = await tmux([
    "capture-pane", "-p", "-e", "-J", "-S", `-${CAPTURE_LINES}`, "-t", target,
  ]);
  const trimmed = output.replace(/\s+$/g, "");
  return (trimmed ? trimmed.split("\n") : [""]).map(sanitizePaneLine);
}

// ── Scroll helpers ────────────────────────────────────────────────────────────

function maxScrollOffset(lineCount: number, visibleLines: number): number {
  return Math.max(0, lineCount - visibleLines);
}

function clampScrollOffset(offset: number, lineCount: number, visibleLines: number): number {
  return Math.min(Math.max(0, offset), maxScrollOffset(lineCount, visibleLines));
}

function parseSgrMouse(data: string): { button: number; x: number; y: number } | undefined {
  const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/);
  if (!match) return undefined;
  return { button: Number(match[1]), x: Number(match[2]), y: Number(match[3]) };
}

function wheelScrollDelta(data: string): number | undefined {
  const mouse = parseSgrMouse(data);
  if (!mouse || (mouse.button & 64) === 0) return undefined;
  const wheelButton = mouse.button & 3;
  if (wheelButton === 0) return -WHEEL_SCROLL_LINES;
  if (wheelButton === 1) return WHEEL_SCROLL_LINES;
  return undefined;
}

// ── Mouse reporting ───────────────────────────────────────────────────────────

let mouseReportingRefCount = 0;

function enableMouseReporting(): void {
  if (!process.stdout.isTTY) return;
  if (mouseReportingRefCount++ === 0) {
    process.stdout.write("\x1b[?1000h\x1b[?1006h");
  }
}

function disableMouseReporting(): void {
  if (!process.stdout.isTTY || mouseReportingRefCount === 0) return;
  mouseReportingRefCount--;
  if (mouseReportingRefCount === 0) {
    process.stdout.write("\x1b[?1006l\x1b[?1000l");
  }
}

// ── Status glyph ─────────────────────────────────────────────────────────────

function statusGlyph(): string {
  return SPINNER_FRAMES[Math.floor(Date.now() / POLL_MS) % SPINNER_FRAMES.length];
}

// ── Key forwarding ────────────────────────────────────────────────────────────

function isPrintableText(data: string): boolean {
  return (
    data.length > 0 &&
    !data.startsWith("\x1b") &&
    Array.from(data).every((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
  );
}

function toTmuxKey(key: string): string | undefined {
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

function sendTmuxInput(target: string, data: string): Promise<void> {
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

class TmuxFocusModal implements Component {
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

async function openFocusModal(ctx: ExtensionContext, window?: string): Promise<void> {
  uiCtx = ctx.ui;
  if (!ctx.hasUI) {
    ctx.ui.notify("Focus modal requires a UI session.", "warning");
    return;
  }
  if (focusModalOpen) return;

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
    target = await resolveWindowTarget(sess, window ?? focusWindow);
  } catch (error) {
    ctx.ui.notify(
      `Could not resolve tmux window: ${error instanceof Error ? error.message : String(error)}`,
      "warning",
    );
    return;
  }

  focusModalOpen = true;
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
    focusModalOpen = false;
    // Refresh footer after modal closes — uiCtx was set at openFocusModal entry.
    const count = knownWindows.size;
    uiCtx?.setStatus("terminal", count > 0 ? `| terminals: ${count}` : undefined);
  }
}

// ── Extension factory ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {

  function updateFooter(): void {
    if (!uiCtx) return;
    const count = knownWindows.size;
    uiCtx.setStatus("terminal", count > 0 ? `| terminals: ${count}` : undefined);
  }

  // ── Session lifecycle ───────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    try { logger.truncate(); } catch {} // truncate on start
    logger = createLogger("terminal", ctx.cwd);
    logger.truncate();
    debug("session_start", ctx.cwd);
    // Delete the project temp root to clean up any leftovers from a crash.
    try {
      const tempDir = getProjectTempDir(ctx.cwd ?? process.cwd());
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    storedCtx = ctx;
    uiCtx = ctx.ui;
    sessionName = deriveSessionName(ctx.cwd ?? process.cwd());
    sessionReady = false;
    // Pre-populate knownWindows if session already exists.
    try {
      const out = await tmux(["list-windows", "-t", sessionName, "-F", "#{window_name}"]);
      out.split("\n").map((l) => l.trim()).filter(Boolean).forEach((w) => knownWindows.add(w));
      sessionReady = true;
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

  pi.on("tool_execution_start", async (_event, ctx) => { uiCtx = ctx.ui; });
  pi.on("agent_end", async (_event, ctx) => { uiCtx = ctx.ui; updateFooter(); });

  // Allow other extensions to request session creation.
  pi.events.on("terminal:ensure-session", async (data: any) => {
    const cwd = data?.cwd ?? storedCtx?.cwd ?? process.cwd();
    debug("terminal:ensure-session requested", cwd);
    await ensureSession(cwd).catch(() => {});
  });

  // Emit terminal:session-ready when the managed session is first created.
  onSessionReady = (sess, cwd) => {
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
    const cwd = storedCtx?.cwd ?? process.cwd();
    const pagerCmd = getConfig().terminal?.pagerCmd ?? "less -RS +F $FILE";
    const cmd = pagerCmd.replace(/\$FILE/g, shellQuote(data.file));
    const winName = "pi-code-pager";
    try {
      const sess = await ensureSession(cwd);
      if (await windowExists(sess, winName)) {
        await tmux(["kill-window", "-t", windowTarget(sess, winName)]).catch(() => {});
        knownWindows.delete(winName);
      }
      await tmux(["new-window", "-t", sess, "-n", winName, "-c", cwd, "bash", "-lc", wrapCmd(cmd, true)]);
      knownWindows.add(winName);
      if (storedCtx) await openFocusModal(storedCtx, winName);
    } catch (err) {
      storedCtx?.ui.notify(`terminal: could not open pager: ${err instanceof Error ? err.message : String(err)}`, "warning");
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
      const tempDir = getProjectTempDir(storedCtx?.cwd);
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    storedCtx = undefined;
    uiCtx?.setStatus("terminal", undefined);
    uiCtx = undefined;
    sessionReady = false;
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
      if (window) focusWindow = window;
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

      focusWindow = winName;
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
    focusWindow = winName;
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
      focusWindow = winName;
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
          focusWindow = winName;
          await openFocusModal(ctx, winName);
        },
      });
    }
  }

  registerAppCommands();



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

  // 5. tmux_watch
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
      const watchId = `w${++watcherIdCounter}`;

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

  // 7. tmux_unwatch
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
