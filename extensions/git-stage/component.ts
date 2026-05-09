/**
 * GitStageComponent — interactive TUI for staging / unstaging git files.
 *
 * Keyboard:
 *   ↑ / k       move up
 *   ↓ / j       move down
 *   space/enter toggle stage on selected file
 *   a           stage all (git add -A)
 *   u           unstage all (git restore --staged .)
 *   r           refresh
 *   q / Escape  close
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

// ── Types ─────────────────────────────────────────────────────────────────────

interface GitFile {
  path: string;
  /** Has staged changes (X slot not ' ' or '?') */
  staged: boolean;
  /** Has unstaged modifications (Y slot 'M' or 'D') */
  modified: boolean;
  /** Completely untracked (??) */
  untracked: boolean;
  xStatus: string;
  yStatus: string;
}

interface TuiHandle {
  requestRender(): void;
}

export interface GitStageComponentOptions {
  tui: TuiHandle;
  theme: Theme;
  done: () => void;
  pi: ExtensionAPI;
  cwd: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export class GitStageComponent {
  private readonly tui: TuiHandle;
  private readonly theme: Theme;
  private readonly done: () => void;
  private readonly pi: ExtensionAPI;
  private readonly cwd: string;

  private files: GitFile[] = [];
  private selectedIndex = 0;
  private branch = "";
  private loading = true;
  private error: string | undefined;

  // Render cache
  private cachedLines: string[] | undefined;
  private cachedWidth: number | undefined;

  constructor(opts: GitStageComponentOptions) {
    this.tui = opts.tui;
    this.theme = opts.theme;
    this.done = opts.done;
    this.pi = opts.pi;
    this.cwd = opts.cwd;

    void this.refresh();
  }

  // ── Git helpers ─────────────────────────────────────────────────────────────

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
      this.error = undefined;

      if (this.selectedIndex >= this.files.length) {
        this.selectedIndex = Math.max(0, this.files.length - 1);
      }
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
      this.invalidate();
      this.tui.requestRender();
    }
  }

  private parseStatus(output: string): GitFile[] {
    const files: GitFile[] = [];
    for (const line of output.split("\n")) {
      if (line.length < 3) continue;
      const x = line[0] ?? " ";
      const y = line[1] ?? " ";
      let path = line.slice(3);
      // Renames are encoded as "old -> new"
      if (path.includes(" -> ")) {
        path = path.split(" -> ")[1] ?? path;
      }
      files.push({
        path: path.trim(),
        staged: x !== " " && x !== "?",
        modified: y === "M" || y === "D",
        untracked: x === "?" && y === "?",
        xStatus: x,
        yStatus: y,
      });
    }
    return files;
  }

  private async toggleSelected(): Promise<void> {
    const file = this.files[this.selectedIndex];
    if (!file) return;
    if (file.staged) {
      await this.pi.exec("git", ["restore", "--staged", "--", file.path], {
        cwd: this.cwd,
        timeout: 5000,
      });
    } else {
      await this.pi.exec("git", ["add", "--", file.path], { cwd: this.cwd, timeout: 5000 });
    }
    await this.refresh();
  }

  private async stageAll(): Promise<void> {
    await this.pi.exec("git", ["add", "-A"], { cwd: this.cwd, timeout: 5000 });
    await this.refresh();
  }

  private async unstageAll(): Promise<void> {
    await this.pi.exec("git", ["restore", "--staged", "."], { cwd: this.cwd, timeout: 5000 });
    await this.refresh();
  }

  // ── Input handling ──────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.done();
      return;
    }

    if (matchesKey(data, "up") || data === "k") {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "down") || data === "j") {
      if (this.selectedIndex < this.files.length - 1) {
        this.selectedIndex++;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "space") || matchesKey(data, "return")) {
      void this.toggleSelected();
      return;
    }

    if (data === "a") {
      void this.stageAll();
      return;
    }

    if (data === "u") {
      void this.unstageAll();
      return;
    }

    if (data === "r") {
      void this.refresh();
      return;
    }
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    const th = this.theme;
    const bar = "─".repeat(Math.max(0, width));

    // ── Header ──
    lines.push(truncateToWidth(th.fg("accent", `  ⎇  ${this.branch}`), width));
    lines.push(truncateToWidth(th.fg("border", bar), width));
    lines.push("");

    if (this.loading) {
      lines.push(truncateToWidth(th.fg("muted", "  Loading…"), width));
    } else if (this.error) {
      lines.push(truncateToWidth(th.fg("error", `  Error: ${this.error}`), width));
    } else if (this.files.length === 0) {
      lines.push(truncateToWidth(th.fg("success", "  ✓ Nothing to stage — working tree clean"), width));
    } else {
      // ── Stats ──
      const stagedCount = this.files.filter((f) => f.staged).length;
      const stats =
        th.fg("success", `  ${stagedCount} staged`) +
        th.fg("dim", ` / ${this.files.length} total`);
      lines.push(truncateToWidth(stats, width));
      lines.push("");

      // ── File list ──
      for (let i = 0; i < this.files.length; i++) {
        const file = this.files[i]!;
        const isSelected = i === this.selectedIndex;

        // Cursor
        const cursor = isSelected ? th.fg("accent", "▶") : " ";

        // Checkbox
        const checkbox = file.staged ? th.fg("success", "[✓]") : th.fg("dim", "[ ]");

        // Status glyph + colour
        let glyph: string;
        let glyphColor: Parameters<Theme["fg"]>[0];
        if (file.untracked) {
          glyph = "?";
          glyphColor = "dim";
        } else if (file.staged && file.modified) {
          glyph = "±";
          glyphColor = "warning";
        } else if (file.staged) {
          glyph = "✓";
          glyphColor = "success";
        } else {
          glyph = "M";
          glyphColor = "warning";
        }

        // Path colour
        const pathColour: Parameters<Theme["fg"]>[0] = file.untracked
          ? "dim"
          : file.staged
          ? "text"
          : "muted";

        const row =
          ` ${cursor} ${checkbox} ${th.fg(glyphColor, glyph)}  ${th.fg(pathColour, file.path)}`;
        lines.push(truncateToWidth(row, width));
      }
    }

    lines.push("");
    lines.push(truncateToWidth(th.fg("border", bar), width));

    // ── Key hints ──
    const hints = [
      [th.fg("accent", "space"), "stage/unstage"],
      [th.fg("accent", "a"), "stage all"],
      [th.fg("accent", "u"), "unstage all"],
      [th.fg("accent", "r"), "refresh"],
      [th.fg("accent", "q"), "close"],
    ]
      .map(([k, v]) => `${k} ${th.fg("dim", v!)}`)
      .join(th.fg("dim", "  ·  "));

    lines.push(truncateToWidth(`  ${hints}`, width));
    lines.push("");

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
