import { watch, existsSync, type FSWatcher } from "node:fs";
import { join } from "node:path";

export type ChangeCallback  = (filePath: string) => Promise<void>;
export type DeletedCallback = (filePath: string) => void;

const DEBOUNCE_MS = 500;

/**
 * FileWatcher for the memory directory.
 *
 * Watches only the root level of memDir (recursive: false) — snapshot-*
 * subdirectories and any other nested dirs are never watched.
 *
 * After the debounce window, the callback chosen depends on whether the file
 * still exists on disk:
 *   - exists   → onChanged  (created / modified)
 *   - gone     → onDeleted  (removed / renamed away)
 *
 * node:fs.watch fires 'change' for in-place modifications and 'rename' for
 * creation, deletion, and renames.  We use the event type as a cheap early
 * hint but always resolve with existsSync — matching Go's fsnotify pattern
 * of separate kindChanged / kindDeleted paths.
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private rootPath: string,
    private onChanged: ChangeCallback,
    private onDeleted: DeletedCallback,
  ) {}

  start(): void {
    try {
      this.watcher = watch(this.rootPath, { recursive: false }, (event, filename) => {
        if (!filename) return;
        if (!filename.endsWith(".md")) return;

        const full = join(this.rootPath, filename);

        // For 'change' events the file definitely exists — skip the debounce
        // delay and fire immediately (still deduplicated via timer replacement).
        // For 'rename' we always need to wait for the FS to settle before
        // checking existsSync, so the same debounce window applies.
        const delay = event === "change" ? 0 : DEBOUNCE_MS;

        const existing = this.timers.get(full);
        if (existing) clearTimeout(existing);

        this.timers.set(full, setTimeout(() => {
          this.timers.delete(full);
          this.fire(full);
        }, delay));
      });

      this.watcher.on("error", () => this.stop());
    } catch (_) {
      // memDir may not exist yet — watcher will remain null until restart
    }
  }

  stop(): void {
    if (this.watcher) {
      try { this.watcher.close(); } catch (_) {}
      this.watcher = null;
    }
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private fire(filePath: string): void {
    if (existsSync(filePath)) {
      void this.onChanged(filePath);
    } else {
      this.onDeleted(filePath);
    }
  }
}
