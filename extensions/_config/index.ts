/**
 * _config extension — centralised loader for ~/.pi/agent/pi-code.json.
 *
 * Usage in other extensions:
 *   import { getConfig, loadConfig } from "../_config/index.ts";
 *   import type { PiCodeConfig } from "../_config/index.ts";
 *
 * The default export is a valid pi ExtensionAPI factory.  On `session_start` it
 * broadcasts the loaded config via the shared event bus so other extensions can
 * react without a direct import:
 *
 *   pi.events.on("pi-code:config", (cfg: PiCodeConfig) => { ... });
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Config path ───────────────────────────────────────────────────────────────

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-code.json");

// ── Project root ─────────────────────────────────────────────────────────────

/**
 * Resolve the project root for a given working directory:
 *   1. The git repository root, if `cwd` is inside a git repo.
 *   2. `cwd` itself otherwise.
 *
 * Defaults to `process.cwd()` when no `cwd` argument is supplied.
 */
export function getProjectRoot(cwd?: string): string {
  const dir = cwd ?? process.cwd();
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    encoding: "utf-8",
  });
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return dir;
}

// ── Project cache directory ──────────────────────────────────────────────────

/**
 * Return (and initialise) the per-project cache directory:
 *   ~/.pi/cache/pi-code-project/<sha256[:16] of projectRoot>/
 *
 * On every call:
 *   - Creates the directory if it does not exist.
 *   - Writes `dir.txt` with the resolved project root if the file is absent.
 *   - Validates `dir.txt` against the resolved project root if the file already
 *     exists; throws if the stored path does not match (hash collision or stale
 *     cache from a renamed directory).
 *
 * Defaults to `getProjectRoot(cwd)` when no `projectRoot` is supplied.
 */
export function getProjectCacheDir(projectRoot?: string): string {
  const root = projectRoot ?? getProjectRoot();
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const dir  = join(homedir(), ".pi", "cache", "pi-code-projects", hash);
  const dirTxt = join(dir, "dir.txt");

  mkdirSync(dir, { recursive: true });

  if (!existsSync(dirTxt)) {
    writeFileSync(dirTxt, root, "utf-8");
  } else {
    const stored = readFileSync(dirTxt, "utf-8").trim();
    if (stored !== root) {
      throw new Error(
        `pi-code _config: cache dir mismatch for "${root}"\n` +
        `  cache dir : ${dir}\n` +
        `  dir.txt   : ${stored}`,
      );
    }
  }

  return dir;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WorkflowLogConfig {
  /** Whether to write a timestamped entry to workflow.md after each agent turn. */
  enabled?: boolean;
  /** Model used for auto-summarisation, e.g. "github-copilot/claude-haiku-4.5". */
  model?: string;
}

export interface MemoryAgentConfig {
  /** Model used for /memory init and /memory curate commands. */
  model?: string;
}

export interface ScoutConfig {
  /** Tavily API key — passed as TAVILY_API_KEY to the tvly CLI. */
  tavilyApiKey?: string;
  /** Context7 API key — passed as CONTEXT7_API_KEY to the ctx7 CLI. */
  context7ApiKey?: string;
}

export interface MemoryActivityLogConfig {
  /** Whether to write a timestamped entry to activity_log.md after each agent turn. */
  enabled?: boolean;
  /** Model used for auto-summarisation, e.g. "github-copilot/claude-haiku-4.5". */
  model?: string;
}

export interface MemorySubcommandModelConfig {
  default?: string;
  init?: string;
  curate?: string;
  compact?: string;
}

export interface MemoryConfig {
  /** Subdirectory name under `<projectRoot>/.pi/` for markdown files. Defaults to "memory". */
  dirname?: string;
  /** Activity log auto-logging config. */
  activityLog?: MemoryActivityLogConfig;
  /** Per-subcommand model overrides. `default` applies unless a subcommand key is set. */
  subcommandModel?: MemorySubcommandModelConfig;
}

/**
 * Typed representation of ~/.pi/agent/pi-code.json.
 *
 * All fields are optional — the file may contain only a subset of keys.
 * Unknown keys are preserved under `[key: string]: unknown`.
 */
export interface PiCodeConfig {
  workflowLog?: WorkflowLogConfig;
  memoryAgent?: MemoryAgentConfig;
  scout?: ScoutConfig;
  memory?: MemoryConfig;
  [key: string]: unknown;
}

// ── Loader ────────────────────────────────────────────────────────────────────

/**
 * Load and parse the config file fresh from disk.
 * Returns an empty object when the file is absent or unparseable.
 */
export function loadConfig(): PiCodeConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as PiCodeConfig;
  } catch {
    return {};
  }
}

// ── Cached singleton ──────────────────────────────────────────────────────────

let _cached: PiCodeConfig | undefined;

/**
 * Return a cached copy of the config, loading from disk on the first call.
 * Call `invalidateConfig()` to force a reload on the next `getConfig()` call.
 */
export function getConfig(): PiCodeConfig {
  if (_cached === undefined) {
    _cached = loadConfig();
  }
  return _cached;
}

/** Invalidate the in-memory cache so the next `getConfig()` re-reads the file. */
export function invalidateConfig(): void {
  _cached = undefined;
}

// ── Extension factory ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // On every session start (including /reload and /new), refresh the cache and
  // broadcast it so other extensions can subscribe without a direct import.
  pi.on("session_start", async (_event, _ctx) => {
    invalidateConfig();
    const cfg = getConfig();
    pi.events.emit("pi-code:config", cfg);
  });
}
