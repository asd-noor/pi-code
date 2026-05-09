/**
 * GitStageOverlay — split-panel TUI overlay for hunk-level git staging.
 *
 * Left panel (~35%): file list
 * Right panel (~65%): diff / hunk viewer
 *
 * Keyboard:
 *   ↑ / k        move up in focused panel
 *   ↓ / j        move down in focused panel
 *   Tab          switch focus between panels
 *   space        stage/unstage selected hunk (hunk panel) OR toggle file stage (file panel)
 *   s            stage all hunks in current file
 *   u            unstage all hunks in current file (git restore --staged)
 *   a            git add -A
 *   r            refresh
 *   q / Esc      close
 */

import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GitFileStatus, FileDiff, PanelFocus } from "./types.ts";
import { parseDiff, buildHunkPatch } from "./diff-parser.ts";

// ── Background fill helper (creates the popup look) ─────────────────────────

function applyBgToLines(lines: string[], width: number, t: any, color: string): string[] {
  const SENTINEL = "\uE000";
  const probe = t.bg(color, SENTINEL);
  const idx = probe.indexOf(SENTINEL);
  if (idx <= 0) return lines;
  const bgOpen  = probe.slice(0, idx);
  const bgReset = `\x1b[0m${bgOpen}`;
  return lines.map((line) => {
    const vw  = visibleWidth(line);
    const pad = " ".repeat(Math.max(0, width - vw));
    const content = (line + pad).replace(/\x1b\[0m/g, bgReset);
    return `${bgOpen}${content}\x1b[0m`;
  });
}

// ── Types ────────────────────────────────────────────────────────────────────

interface TuiHandle {
  requestRender(): void;
}

export interface GitStageOverlayOptions {
  tui: TuiHandle;
  theme: Theme;
  done: () => void;
  pi: ExtensionAPI;
  cwd: string;
}

// ── Component ────────────────────────────────────────────────────────────────

export class GitStageOverlay {
  private readonly tui: TuiHandle;
  private readonly theme: Theme;
  private readonly done: () => void;
  private readonly pi: ExtensionAPI;
  private readonly cwd: string;

  // State
  private files: GitFileStatus[] = [];
  private fileIndex = 0;
  private fileDiff: FileDiff | null = null;
  private hunkIndex = 0;
  private focus: PanelFocus = "files";
  private fileScrollOffset = 0;
  private hunkScrollOffset = 0;
  private branch = "";
  private loading = true;
  private statusMessage: string | undefined;

  // Render cache
  private cachedLines: string[] | undefined;
  private cachedWidth: number | undefined;

  constructor(opts: GitStageOverlayOptions) {
    this.tui = opts.tui;
    this.theme = opts.theme;
    this.done = opts.done;
    this.pi = opts.pi;
    this.cwd = opts.cwd;

    void this.refresh();
  }

  // ── Git helpers ─────────────────────────────────────────────────────────

  private async refresh(): Promise<void> {
    this.loading = true;
    this.invalidate();
    this.tui.requestRender();

    try {
      const [statusResult, branchResult] = await Promise.all([
        this.pi.exec("git", ["status", "--porcelain=v1", "-u"], { cwd: this.cwd, timeout: 5000 }),
        this.pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: this.cwd, timeout: 3000 }),
      ]);

      this.branch = branchResult.stdout.trim() || "HEAD";
      this.files = this.parseStatus(statusResult.stdout);

      if (this.fileIndex >= this.files.length) {
        this.fileIndex = Math.max(0, this.files.length - 1);
      }

      // Reload diff for selected file
      await this.loadDiff();
    } catch {
      // ignore errors
    } finally {
      this.loading = false;
      this.invalidate();
      this.tui.requestRender();
    }
  }

  private parseStatus(output: string): GitFileStatus[] {
    const files: GitFileStatus[] = [];
    for (const line of output.split("\n")) {
      if (line.length < 3) continue;
      const x = line[0] ?? " ";
      const y = line[1] ?? " ";
      let path = line.slice(3);
      if (path.includes(" -> ")) {
        path = path.split(" -> ")[1] ?? path;
      }
      path = path.trim();
      if (!path) continue;

      const untracked = x === "?" && y === "?";
      const staged = !untracked && x !== " " && x !== "?";
      const unstaged = !untracked && (y === "M" || y === "D" || y === "A");
      const newFile = x === "A";
      const deleted = x === "D" || y === "D";

      files.push({ path, xStatus: x, yStatus: y, staged, unstaged, untracked, newFile, deleted });
    }
    return files;
  }

  private async loadDiff(): Promise<void> {
    const file = this.files[this.fileIndex];
    if (!file) {
      this.fileDiff = null;
      return;
    }

    if (file.untracked) {
      this.fileDiff = null;
      return;
    }

    try {
      // Show unstaged diff for staging; if no unstaged changes, show staged diff for unstaging
      const args = file.unstaged
        ? ["diff", "--", file.path]
        : ["diff", "--cached", "--", file.path];

      const result = await this.pi.exec("git", args, { cwd: this.cwd, timeout: 5000 });
      const diffs = parseDiff(result.stdout);
      this.fileDiff = diffs[0] ?? null;
      this.hunkIndex = 0;
      this.hunkScrollOffset = 0;
    } catch {
      this.fileDiff = null;
    }
  }

  private async stageHunk(): Promise<void> {
    const file = this.files[this.fileIndex];
    if (!file || !this.fileDiff) return;

    const hunk = this.fileDiff.hunks[this.hunkIndex];
    if (!hunk) return;

    const patch = buildHunkPatch(this.fileDiff, hunk);
    const tmpFile = join(tmpdir(), `pi-git-stage-${Date.now()}.patch`);

    try {
      writeFileSync(tmpFile, patch, "utf8");

      if (file.unstaged) {
        // Stage from working tree
        const result = await this.pi.exec(
          "git", ["apply", "--cached", "--whitespace=nowarn", tmpFile],
          { cwd: this.cwd, timeout: 5000 },
        );
        this.statusMessage = result.code === 0 ? "Hunk staged" : `git apply failed: ${result.stderr.trim()}`;
      } else {
        // Unstage (reverse apply)
        const result = await this.pi.exec(
          "git", ["apply", "--cached", "-R", "--whitespace=nowarn", tmpFile],
          { cwd: this.cwd, timeout: 5000 },
        );
        this.statusMessage = result.code === 0 ? "Hunk unstaged" : `git apply failed: ${result.stderr.trim()}`;
      }
    } catch (e) {
      this.statusMessage = `Error: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }

    await this.refresh();
  }

  private async toggleFileStage(): Promise<void> {
    const file = this.files[this.fileIndex];
    if (!file) return;

    if (file.staged) {
      await this.pi.exec("git", ["restore", "--staged", "--", file.path], {
        cwd: this.cwd,
        timeout: 5000,
      });
      this.statusMessage = "File unstaged";
    } else {
      await this.pi.exec("git", ["add", "--", file.path], { cwd: this.cwd, timeout: 5000 });
      this.statusMessage = "File staged";
    }

    await this.refresh();
  }

  private async stageAllHunks(): Promise<void> {
    const file = this.files[this.fileIndex];
    if (!file) return;
    await this.pi.exec("git", ["add", "--", file.path], { cwd: this.cwd, timeout: 5000 });
    this.statusMessage = "All hunks staged";
    await this.refresh();
  }

  private async unstageAllHunks(): Promise<void> {
    const file = this.files[this.fileIndex];
    if (!file) return;
    await this.pi.exec("git", ["restore", "--staged", "--", file.path], {
      cwd: this.cwd,
      timeout: 5000,
    });
    this.statusMessage = "All hunks unstaged";
    await this.refresh();
  }

  private async stageAll(): Promise<void> {
    await this.pi.exec("git", ["add", "-A"], { cwd: this.cwd, timeout: 5000 });
    this.statusMessage = "All files staged";
    await this.refresh();
  }

  // ── Input ────────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.done();
      return;
    }

    if (data === "\t") {
      this.focus = this.focus === "files" ? "hunks" : "files";
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "up") || data === "k") {
      if (this.focus === "files") {
        if (this.fileIndex > 0) {
          this.fileIndex--;
          this.fileDiff = null;
          this.invalidate();
          this.tui.requestRender();
          void this.loadDiff().then(() => {
            this.invalidate();
            this.tui.requestRender();
          });
        }
      } else {
        if (this.hunkIndex > 0) {
          this.hunkIndex--;
          this.invalidate();
          this.tui.requestRender();
        }
      }
      return;
    }

    if (matchesKey(data, "down") || data === "j") {
      if (this.focus === "files") {
        if (this.fileIndex < this.files.length - 1) {
          this.fileIndex++;
          this.fileDiff = null;
          this.invalidate();
          this.tui.requestRender();
          void this.loadDiff().then(() => {
            this.invalidate();
            this.tui.requestRender();
          });
        }
      } else {
        const maxHunk = (this.fileDiff?.hunks.length ?? 1) - 1;
        if (this.hunkIndex < maxHunk) {
          this.hunkIndex++;
          this.invalidate();
          this.tui.requestRender();
        }
      }
      return;
    }

    if (matchesKey(data, "space")) {
      if (this.focus === "hunks" && this.fileDiff && this.fileDiff.hunks.length > 0) {
        void this.stageHunk();
      } else {
        void this.toggleFileStage();
      }
      return;
    }

    if (data === "s") {
      void this.stageAllHunks();
      return;
    }

    if (data === "u") {
      void this.unstageAllHunks();
      return;
    }

    if (data === "a") {
      void this.stageAll();
      return;
    }

    if (data === "r") {
      this.statusMessage = undefined;
      void this.refresh();
      return;
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const th = this.theme;
    const termRows   = process.stdout.rows || 24;
    const overlayRows = Math.floor(termRows * 0.95);

    // ── Header ──
    const stagedCount = this.files.filter((f) => f.staged).length;
    const hints = [
      [th.fg("accent", "↑↓/jk"), "move"],
      [th.fg("accent", "Tab"), "switch"],
      [th.fg("accent", "space"), "stage hunk"],
      [th.fg("accent", "s"), "stage file"],
      [th.fg("accent", "u"), "unstage file"],
      [th.fg("accent", "a"), "add all"],
      [th.fg("accent", "r"), "refresh"],
      [th.fg("accent", "q"), "close"],
    ]
      .map(([k, v]) => `${k} ${th.fg("dim", v as string)}`)
      .join(th.fg("dim", "  ·  "));
    const headerLines: string[] = [
      truncateToWidth(
        th.fg("accent", `  ⎇  ${this.branch}`) +
          th.fg("dim", `  ·  `) +
          th.fg("success", `${stagedCount} staged`) +
          th.fg("dim", ` / ${this.files.length} total`) +
          (this.statusMessage ? th.fg("dim", `  ·  `) + th.fg("muted", this.statusMessage) : ""),
        width,
      ),
      truncateToWidth(`  ${hints}`, width),
      th.fg("border", "─".repeat(width)),
    ];

    // ── Footer ──
    const footerLines: string[] = [
      th.fg("border", "─".repeat(width)),
    ];

    const contentH = Math.max(5, overlayRows - headerLines.length - footerLines.length);

    // ── Split panels ──
    const leftW  = Math.floor(width * 0.35);
    const rightW = width - leftW - 1; // 1 for separator

    const leftLines  = this.renderFilePanel(leftW, contentH);
    const rightLines = this.renderDiffPanel(rightW, contentH);

    const maxRows = Math.max(leftLines.length, rightLines.length, contentH);
    const panelLines: string[] = [];
    for (let i = 0; i < maxRows; i++) {
      const l = truncateToWidth(leftLines[i] ?? "", leftW);
      const r = truncateToWidth(rightLines[i] ?? "", rightW);
      panelLines.push(l + th.fg("border", "│") + r);
    }

    const allLines = [...headerLines, ...panelLines, ...footerLines];
    const result = applyBgToLines(allLines, width, th, "customMessageBg");

    this.cachedWidth = width;
    this.cachedLines = result;
    return result;
  }

  private renderFilePanel(width: number, height: number): string[] {
    const th = this.theme;
    const lines: string[] = [];

    // Panel header
    const focusMarker = this.focus === "files" ? th.fg("accent", " FILES") : th.fg("dim", " FILES");
    lines.push(truncateToWidth(focusMarker, width));
    lines.push(th.fg("border", "─".repeat(width)));

    if (this.loading) {
      lines.push(truncateToWidth(th.fg("muted", " Loading…"), width));
      return lines;
    }

    if (this.files.length === 0) {
      lines.push(truncateToWidth(th.fg("success", " ✓ Clean"), width));
      return lines;
    }

    const listHeight = Math.max(1, height - 2);

    // Scroll to keep selected in view
    if (this.fileIndex < this.fileScrollOffset) {
      this.fileScrollOffset = this.fileIndex;
    }
    if (this.fileIndex >= this.fileScrollOffset + listHeight) {
      this.fileScrollOffset = this.fileIndex - listHeight + 1;
    }

    const visible = this.files.slice(this.fileScrollOffset, this.fileScrollOffset + listHeight);
    for (let i = 0; i < visible.length; i++) {
      const file = visible[i]!;
      const absIdx = this.fileScrollOffset + i;
      const isSelected = absIdx === this.fileIndex;

      let checkbox: string;
      if (file.untracked) {
        checkbox = th.fg("dim", "[?]");
      } else if (file.staged && file.unstaged) {
        checkbox = th.fg("warning", "[±]");
      } else if (file.staged) {
        checkbox = th.fg("success", "[✓]");
      } else {
        checkbox = th.fg("dim", "[ ]");
      }

      const pathColor: "text" | "muted" | "dim" = file.staged ? "text" : file.untracked ? "dim" : "muted";
      const cursor = isSelected ? th.fg("accent", "▶") : " ";
      const row = ` ${cursor} ${checkbox} ${th.fg(pathColor, file.path)}`;

      lines.push(truncateToWidth(row, width));
    }

    return lines;
  }

  private renderDiffPanel(width: number, height: number): string[] {
    const th = this.theme;
    const lines: string[] = [];

    // Panel header
    const file = this.files[this.fileIndex];
    const focusMarker = this.focus === "hunks" ? th.fg("accent", " DIFF") : th.fg("dim", " DIFF");
    const fileName = file ? th.fg("muted", `  ${file.path}`) : "";
    lines.push(truncateToWidth(focusMarker + fileName, width));
    lines.push(th.fg("border", "─".repeat(width)));

    if (this.loading) {
      lines.push(truncateToWidth(th.fg("muted", " Loading…"), width));
      return lines;
    }

    if (!file) {
      lines.push(truncateToWidth(th.fg("dim", " No file selected"), width));
      return lines;
    }

    if (file.untracked) {
      lines.push(truncateToWidth(th.fg("dim", " Untracked file — use space to add"), width));
      return lines;
    }

    if (!this.fileDiff || this.fileDiff.hunks.length === 0) {
      lines.push(truncateToWidth(th.fg("dim", " No diff available"), width));
      return lines;
    }

    // Build all diff lines with hunk highlighting
    const totalHunks = this.fileDiff.hunks.length;
    const diffLines: string[] = [];
    for (let hi = 0; hi < totalHunks; hi++) {
      const hunk = this.fileDiff.hunks[hi]!;
      const isSel = hi === this.hunkIndex;

      // ── Hunk divider (between hunks) ──────────────────────────────────
      if (hi > 0) {
        const label = ` hunk ${hi + 1} / ${totalHunks} `;
        const dashes = "─".repeat(Math.max(0, width - label.length));
        diffLines.push(th.fg("dim", dashes + label));
      }

      for (let li = 0; li < hunk.lines.length; li++) {
        const diffLine = hunk.lines[li] ?? "";
        let rendered: string;

        if (diffLine.startsWith("@@")) {
          // @@ header: full-width, ▶ when focused
          const hunkLabel = isSel
            ? th.fg("accent", `${this.focus === "hunks" ? "▶" : "▷"} ${diffLine}`)
            : th.fg("dim", `  ${diffLine}`);
          rendered = truncateToWidth(hunkLabel, width);
        } else {
          // Body lines: │ gutter on selected hunk so highlight persists when @@ scrolls off
          const gutter = isSel ? th.fg("accent", "│") : " ";
          const cw = width - 1; // 1 char taken by gutter
          let body: string;
          if (diffLine.startsWith("+")) {
            body = truncateToWidth(th.fg(isSel ? "success" : "dim", ` ${diffLine}`), cw);
          } else if (diffLine.startsWith("-")) {
            body = truncateToWidth(th.fg(isSel ? "error" : "dim", ` ${diffLine}`), cw);
          } else {
            body = truncateToWidth(th.fg(isSel ? "muted" : "dim", ` ${diffLine}`), cw);
          }
          rendered = gutter + body;
        }

        diffLines.push(rendered);
      }
    }

    // Scroll to keep selected hunk header in view
    const contentH = Math.max(1, height - 2);

    // Find the line index of the selected hunk's @@ header.
    // Divider is emitted BEFORE the hunk, so accumulate it first, then check.
    let selectedHunkLineStart = 0;
    let lineCount = 0;
    for (let hi = 0; hi < this.fileDiff.hunks.length; hi++) {
      if (hi > 0) lineCount++; // divider line comes before this hunk
      if (hi === this.hunkIndex) {
        selectedHunkLineStart = lineCount;
        break;
      }
      lineCount += this.fileDiff.hunks[hi]?.lines.length ?? 0;
    }

    if (selectedHunkLineStart < this.hunkScrollOffset) {
      // Selected hunk scrolled above viewport — snap to show divider + @@ at top
      this.hunkScrollOffset = Math.max(0, selectedHunkLineStart - 1);
    }
    if (selectedHunkLineStart >= this.hunkScrollOffset + contentH) {
      // Selected hunk below viewport — bring @@ near the top (1 line margin for divider)
      this.hunkScrollOffset = Math.max(0, selectedHunkLineStart - 1);
    }

    const visible = diffLines.slice(this.hunkScrollOffset, this.hunkScrollOffset + contentH);
    for (const l of visible) {
      lines.push(l);
    }

    // Scroll indicator
    if (diffLines.length > contentH) {
      const pct = Math.floor((this.hunkScrollOffset / Math.max(1, diffLines.length - contentH)) * 100);
      lines.push(truncateToWidth(th.fg("dim", ` ↕ ${pct}%`), width));
    }

    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
