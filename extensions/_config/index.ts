/**
 * _config extension — centralised loader for pi-code.json.
 *
 * Config is merged from three sources in ascending precedence:
 *   1. ~/.pi/agent/pi-code.json          (global)
 *   2. <projectRoot>/.pi/pi-code.json    (project)
 *   3. $PI_CODE_CONFIG                   (env override)
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
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Config paths ─────────────────────────────────────────────────────────────

/** Global config — ~/.pi/agent/pi-code.json */
export const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-code.json");

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

// ── Detached cache directory ────────────────────────────────────────────────

/**
 * Return (and initialise) a cache directory for a memory dir that lives
 * outside any project root (i.e. when memory.customSrcDir is set in config):
 *   ~/.pi/cache/detached-memory/<sha256[:16] of memDir>/
 */
export function getDetachedCacheDir(memDir: string): string {
  const hash = createHash("sha256").update(memDir).digest("hex").slice(0, 16);
  const dir  = join(homedir(), ".pi", "cache", "detached-memory", hash);
  const dirTxt = join(dir, "dir.txt");

  mkdirSync(dir, { recursive: true });

  if (!existsSync(dirTxt)) {
    writeFileSync(dirTxt, memDir, "utf-8");
  } else {
    const stored = readFileSync(dirTxt, "utf-8").trim();
    if (stored !== memDir) {
      throw new Error(
        `pi-code _config: detached cache dir mismatch for "${memDir}"\n` +
        `  cache dir : ${dir}\n` +
        `  dir.txt   : ${stored}`,
      );
    }
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

export interface SubagentsConfig {
  /** Shell command to preview a session log file. Use `$FILE` as placeholder, e.g. `"tail -f $FILE"`. */
  viewer?: string;
  /** Max concurrent background agents. Default: 4. */
  maxConcurrent?: number;
  /** Default max turns per agent (0 = unlimited). */
  defaultMaxTurns?: number;
  /** Grace turns given to an agent after hitting its turn limit. Default: 5. */
  graceTurns?: number;
  /** Minutes to keep a completed session warm for reuse. Default: 10. */
  warmPeriod?: number;
  /** Timeout in minutes for ask_primary to wait for primary agent response. Default: 5. */
  askPrimaryTimeout?: number;
  /** Timeout in minutes for ask_subagent to wait for the warm agent response. Default: 2. */
  askSubagentTimeout?: number;
}

export interface MemoryBrowserConfig {
  /** Shell command to edit a file (e / enter). Use `$FILE` as placeholder, e.g. `"code $FILE"`. */
  editor?: string;
  /** Shell command to view a file (v). Use `$FILE` as placeholder, e.g. `"open -a Typora $FILE"`. */
  viewer?: string;
}

export interface MemoryConfig {
  /** Custom memory source directory. If set and non-empty, behaves like a detached cache (cache keyed by this path, not the project root). */
  customSrcDir?: string;
  /** Activity log auto-logging config. */
  activityLog?: MemoryActivityLogConfig;
  /** Per-subcommand model overrides. `default` applies unless a subcommand key is set. */
  subcommandModel?: MemorySubcommandModelConfig;
  /** Browser widget commands. */
  browser?: MemoryBrowserConfig;
}

/**
 * Typed representation of ~/.pi/agent/pi-code.json.
 *
 * All fields are optional — the file may contain only a subset of keys.
 * Unknown keys are preserved under `[key: string]: unknown`.
 */
export interface CodeMapConfig {
  /** Enable the code-map daemon. Default: true. Set to false to skip daemon spawn, footer widget, and system prompt injection. */
  enabled?: boolean;
  /** Max files for initial indexing. Watcher covers all dirs regardless. Default: 200. */
  fileLimit?: number;
}

export interface PiCodeConfig {
  codeMap?: CodeMapConfig;
  scout?: ScoutConfig;
  memory?: MemoryConfig;
  subagents?: SubagentsConfig;
  [key: string]: unknown;
}

// ── Defaults ───────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: PiCodeConfig = {
  memory: {
    activityLog: {
      enabled: false,
    },
  },
};

// ── Loader ────────────────────────────────────────────────────────────────────

/** Parse one JSON file; returns {} on missing or invalid file. */
function loadFile(filePath: string): PiCodeConfig {
  try {
    if (!existsSync(filePath)) return {};
    return JSON.parse(readFileSync(filePath, "utf-8")) as PiCodeConfig;
  } catch {
    return {};
  }
}

/** Recursively merge objects. Later sources override earlier ones. */
function deepMerge(...sources: PiCodeConfig[]): PiCodeConfig {
  const out: Record<string, unknown> = {};
  for (const src of sources) {
    for (const [k, v] of Object.entries(src)) {
      const existing = out[k];
      if (
        v !== null && typeof v === "object" && !Array.isArray(v) &&
        existing !== null && existing !== undefined && typeof existing === "object" && !Array.isArray(existing)
      ) {
        out[k] = deepMerge(existing as PiCodeConfig, v as PiCodeConfig);
      } else {
        out[k] = v;
      }
    }
  }
  return out as PiCodeConfig;
}

/**
 * Load and merge config from all sources in ascending precedence:
 *   DEFAULT_CONFIG → global → project → $PI_CODE_CONFIG
 *
 * On first run, creates ~/.pi/agent/pi-code.json with DEFAULT_CONFIG.
 * Pass `cwd` to enable project-level config lookup.
 */
export function loadConfig(cwd?: string): PiCodeConfig {
  // Ensure global config exists; create with defaults on first run.
  if (!existsSync(GLOBAL_CONFIG_PATH)) {
    mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf-8");
  }

  const sources: PiCodeConfig[] = [DEFAULT_CONFIG, loadFile(GLOBAL_CONFIG_PATH)];

  // Project — <projectRoot>/.pi/pi-code.json
  if (cwd) {
    const projectRoot = getProjectRoot(cwd);
    sources.push(loadFile(join(projectRoot, ".pi", "pi-code.json")));
  }

  // Env override
  const envPath = process.env.PI_CODE_CONFIG?.trim();
  if (envPath) sources.push(loadFile(envPath));

  return deepMerge(...sources);
}

// ── Cached singleton ──────────────────────────────────────────────────────────

let _config: PiCodeConfig = loadConfig();

/** Return the current merged config. Always up to date. */
export function getConfig(): PiCodeConfig {
  return _config;
}

/**
 * Rebuild the merged config from all sources.
 * Pass `cwd` to include the project-level config.
 */
export function reloadConfig(cwd?: string): void {
  _config = loadConfig(cwd);
}

/**
 * Deep-merge `patch` into the global config file and reload.
 * Use for persisting UI-driven settings changes.
 */
export function updateGlobalConfig(patch: Partial<PiCodeConfig>): void {
  const current = loadFile(GLOBAL_CONFIG_PATH);
  const updated = deepMerge(current, patch as PiCodeConfig);
  writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(updated, null, 2) + "\n", "utf-8");
  reloadConfig();
}

// ── Extension factory ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // On every session start (including /reload and /new), refresh the cache and
  // broadcast it so other extensions can subscribe without a direct import.
  pi.on("session_start", async (_event, ctx) => {
    reloadConfig(ctx.cwd);
    pi.events.emit("pi-code:config", _config);
  });
}
