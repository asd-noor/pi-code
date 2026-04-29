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
  /** Tracks directories already passed to fs.watch to avoid duplicates. */
  private watchedDirs = new Set<string>();

  private rootPath: string;
  private onChange: ChangeCallback;

  constructor(
    rootPath: string,
    extensions: string[],
    onChange: ChangeCallback
  ) {
    this.rootPath = rootPath;
    this.onChange = onChange;
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
    if (this.watchedDirs.has(dir)) return;
    this.watchedDirs.add(dir);
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
    // Check if this is a new directory — watch it and index any files inside.
    try {
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        const name = filePath.split("/").pop() ?? "";
        if (!SKIP_DIRS.has(name)) {
          this.watchDir(filePath);
          this.indexNewDir(filePath);
        }
        return;
      }
    } catch (_) {
      // Path no longer exists (deleted) — fall through; reindexFile handles removal.
    }

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

  /** Walk a newly created directory and fire onChange for every source file found. */
  private indexNewDir(dir: string): void {
    try {
      for (const entry of readdirSync(dir)) {
        if (SKIP_DIRS.has(entry)) continue;
        const full = join(dir, entry);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) {
            this.watchDir(full);
            this.indexNewDir(full);
          } else if (this.extensions.has(extname(entry))) {
            this.onChange(full);
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
}
