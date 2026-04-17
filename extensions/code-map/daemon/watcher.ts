import { watch, type FSWatcher } from "node:fs";
import { join, extname } from "node:path";
import { readdirSync, statSync } from "node:fs";

export type ChangeCallback = (filePath: string) => void;

const DEBOUNCE_MS = 500;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "vendor", ".code-map", "target", "__pycache__"]);

export class FileWatcher {
  private watchers: FSWatcher[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private extensions: Set<string>;

  constructor(
    private rootPath: string,
    extensions: string[],
    private onChange: ChangeCallback
  ) {
    this.extensions = new Set(extensions);
  }

  start(): void {
    this.watchDir(this.rootPath);
  }

  stop(): void {
    for (const w of this.watchers) {
      try { w.close(); } catch (_) {}
    }
    this.watchers = [];
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private watchDir(dir: string): void {
    try {
      const watcher = watch(dir, { recursive: false }, (_event, filename) => {
        if (!filename) return;
        const full = join(dir, filename);
        // Debounce per file
        const existing = this.timers.get(full);
        if (existing) clearTimeout(existing);
        this.timers.set(full, setTimeout(() => {
          this.timers.delete(full);
          this.handleChange(full);
        }, DEBOUNCE_MS));
      });
      this.watchers.push(watcher);

      // Also watch subdirectories (fs.watch recursive=false for wider compat)
      for (const entry of readdirSync(dir)) {
        if (SKIP_DIRS.has(entry)) continue;
        const full = join(dir, entry);
        try {
          if (statSync(full).isDirectory()) {
            this.watchDir(full);
          }
        } catch (_) {}
      }
    } catch (_) {
      // Silently skip unreadable dirs
    }
  }

  private handleChange(filePath: string): void {
    if (!this.extensions.has(extname(filePath))) return;
    // Skip generated files (same heuristics as codemap)
    const base = filePath.split("/").pop() ?? "";
    if (
      base.endsWith("_templ.go") ||
      base.endsWith(".sql.go") ||
      base.endsWith("_string.go") ||
      base.endsWith(".min.js") ||
      base.endsWith(".d.ts")
    ) return;
    this.onChange(filePath);
  }
}
