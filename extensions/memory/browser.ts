import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

// ── Data ──────────────────────────────────────────────────────────────────────

interface MemoryFileEntry {
  name: string;        // basename without .md
  path: string;        // absolute path
  title: string;       // first # heading, falls back to name
  description: string; // first non-heading line after the title
  sectionCount: number; // number of ## headings
}

export interface MemoryBrowserSelection {
  path: string;
  action: "edit" | "preview";
}

function scanMemoryFiles(memDir: string): MemoryFileEntry[] {
  let names: string[];
  try {
    names = readdirSync(memDir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }

  return names.map((f) => {
    const path = join(memDir, f);
    const name = basename(f, ".md");
    let title        = name;
    let description  = "";
    let sectionCount = 0;
    let foundTitle   = false;
    let foundDesc    = false;

    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!foundTitle && line.startsWith("# ")) {
          title = line.slice(2).trim();
          foundTitle = true;
          continue;
        }
        if (!foundDesc && foundTitle && line.trim() && !line.startsWith("#")) {
          description = line.trim().slice(0, 80);
          foundDesc   = true;
        }
        if (line.startsWith("## ")) sectionCount++;
      }
    } catch {
      // ignore read errors — entry still included with defaults
    }

    return { name, path, title, description, sectionCount };
  });
}

function loadPreviewLines(path: string, max = 18): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").slice(0, max);
  } catch {
    return ["(could not read file)"];
  }
}

// ── Widget ────────────────────────────────────────────────────────────────────

export async function openMemoryBrowserInteractive(
  ctx: ExtensionContext,
  memDir: string,
  editorCommand: string | undefined,
  previewCommand: string | undefined,
): Promise<MemoryBrowserSelection | undefined> {
  if (!ctx.hasUI) {
    throw new Error("/memory browser requires interactive UI mode (not available in print/json mode)");
  }

  return ctx.ui.custom<MemoryBrowserSelection | undefined>((tui, theme, _keybindings, done) => {
    // ── colour helpers ────────────────────────────────────────────────────────
    const b   = (s: string) => theme.fg("borderMuted", s);
    const ba  = (s: string) => theme.fg("borderAccent", s);
    const ac  = (s: string) => theme.fg("accent", s);
    const dim = (s: string) => theme.fg("dim", s);
    const mut = (s: string) => theme.fg("muted", s);
    const wrn = (s: string) => theme.fg("warning", s);

    // ── state ─────────────────────────────────────────────────────────────────
    let files: MemoryFileEntry[] = [];
    let selected                 = 0;
    let preview: string[]        = [];
    let errorMessage: string | undefined;
    let contentLines: string[]   = [];

    // ── helpers ───────────────────────────────────────────────────────────────
    const refreshPreview = () => {
      const file = files[selected];
      preview = file ? loadPreviewLines(file.path) : [];
    };

    const reload = () => {
      try {
        files = scanMemoryFiles(memDir);
        if (selected >= files.length) selected = Math.max(0, files.length - 1);
        errorMessage = undefined;
      } catch (err) {
        files        = [];
        selected     = 0;
        errorMessage = err instanceof Error ? err.message : String(err);
      }
      refreshPreview();
    };

    // ── build content lines ───────────────────────────────────────────────────
    const buildLines = () => {
      const lines: string[] = [];

      // Hint line — show which actions are available
      const hints: string[] = ["↑/↓ j/k move", "r refresh", "esc/q close"];
      if (editorCommand)  hints.splice(1, 0, "e edit");
      if (previewCommand) hints.splice(editorCommand ? 2 : 1, 0, "v preview");
      lines.push(dim(hints.join(" · ")));

      if (!editorCommand && !previewCommand) {
        lines.push(wrn("  set memory.browser.editor / memory.browser.viewer in pi-code.json"));
      }

      if (errorMessage) {
        lines.push(theme.fg("error", `error: ${errorMessage}`));
      } else if (files.length === 0) {
        lines.push(dim(`no memory files in ${memDir}`));
      } else {
        lines.push("");

        const visible = 10;
        const start   = Math.max(0, selected - Math.floor(visible / 2));
        const end     = Math.min(files.length, start + visible);

        for (let i = start; i < end; i++) {
          const f     = files[i]!;
          const isSel = i === selected;
          const prefix  = isSel ? ac("▶") : dim("·");
          const nameStr = isSel ? theme.bold(ac(f.name)) : f.name;
          const badge   = dim(`[${f.sectionCount}§]`);
          lines.push(`${prefix} ${nameStr}  ${badge}`);
          if (f.description) {
            lines.push(mut(`    ${f.description}`));
          }
        }

        const current = files[selected];
        if (current) {
          lines.push("");
          lines.push(`§DIVIDER§${current.name}.md`);
          for (const line of preview) {
            lines.push(`  ${line}`);
          }
        }
      }

      contentLines = lines;
    };

    // ── bordered render ───────────────────────────────────────────────────────
    const renderBordered = (width: number): string[] => {
      const inner = Math.max(6, width - 2);
      const out: string[] = [];

      const titleLabel = " Memory Browser ";
      const topFill    = Math.max(0, inner - titleLabel.length - 1);
      out.push(b("┌") + b("─") + ba(titleLabel) + b("─".repeat(topFill)) + b("┐"));

      for (const line of contentLines) {
        if (line.startsWith("§DIVIDER§")) {
          const label = ` ${line.slice(9)} `;
          const fill  = Math.max(0, inner - label.length - 3);
          out.push(b("├") + b("───") + dim(label) + b("─".repeat(fill)) + b("┤"));
        } else {
          const padded = truncateToWidth(` ${line} `, inner, "…", true);
          out.push(b("│") + padded + b("│"));
        }
      }

      out.push(b("└") + b("─".repeat(inner)) + b("┘"));
      return out;
    };

    // ── refresh ───────────────────────────────────────────────────────────────
    const refresh = () => {
      buildLines();
      tui.requestRender();
    };

    // initial load
    reload();
    buildLines();

    return {
      render:      (width) => renderBordered(width),
      invalidate:  () => {},
      handleInput: (data: string) => {
        if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
          done(undefined);
          return;
        }
        if (matchesKey(data, Key.return) || data === "e" || data === "E") {
          if (editorCommand && files[selected]) done({ path: files[selected]!.path, action: "edit" });
          return;
        }
        if (data === "v" || data === "V") {
          if (previewCommand && files[selected]) done({ path: files[selected]!.path, action: "preview" });
          return;
        }
        if (matchesKey(data, Key.down) || data === "j") {
          if (files.length > 0) {
            selected = Math.min(files.length - 1, selected + 1);
            refreshPreview();
            refresh();
          }
          return;
        }
        if (matchesKey(data, Key.up) || data === "k") {
          if (files.length > 0) {
            selected = Math.max(0, selected - 1);
            refreshPreview();
            refresh();
          }
          return;
        }
        if (data === "r" || data === "R") {
          reload();
          refresh();
        }
      },
    };
  });
}
