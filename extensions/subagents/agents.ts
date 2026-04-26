/**
 * agents.ts — Load agent configs from .md files.
 *
 * Discovery (project overrides global):
 *   1. Global:  ~/.pi/agent/agents/*.md
 *   2. Project: <cwd>/.pi/agents/*.md
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { AgentConfig, ThinkingLevel } from "./types.ts";

const ALL_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export function loadAgents(cwd?: string): Map<string, AgentConfig> {
  const baseCwd = typeof cwd === "string" && cwd ? cwd : process.cwd();
  const globalDir = join(homedir(), ".pi", "agent", "agents");
  const projectDir = join(baseCwd, ".pi", "agents");

  const agents = new Map<string, AgentConfig>();
  loadFromDir(globalDir, agents, "global");
  loadFromDir(projectDir, agents, "project");
  return agents;
}

function loadFromDir(
  dir: string,
  agents: Map<string, AgentConfig>,
  source: "project" | "global",
): void {
  if (!existsSync(dir)) return;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return;
  }

  for (const file of files) {
    const name = basename(file, ".md");
    let content: string;
    try {
      content = readFileSync(join(dir, file), "utf-8");
    } catch {
      continue;
    }

    const { frontmatter: fm, body } = parseFrontmatter<Record<string, unknown>>(content);

    agents.set(name, {
      name,
      displayName: str(fm.display_name),
      description: str(fm.description) ?? name,
      builtinToolNames: csvList(fm.tools, ALL_BUILTIN_TOOLS),
      extensions: inheritField(fm.extensions ?? fm.inherit_extensions),
      model: str(fm.model),
      thinking: str(fm.thinking) as ThinkingLevel | undefined,
      maxTurns: nonNegativeInt(fm.max_turns),
      systemPrompt: body.trim(),
      promptMode: fm.prompt_mode === "append" ? "append" : "replace",
      inheritContext: fm.inherit_context != null ? fm.inherit_context === true : undefined,
      runInBackground: fm.run_in_background != null ? fm.run_in_background === true : undefined,
      isolated: fm.isolated != null ? fm.isolated === true : undefined,
      enabled: fm.enabled !== false,
      source,
    });
  }
}

function str(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

function nonNegativeInt(val: unknown): number | undefined {
  return typeof val === "number" && val >= 0 ? val : undefined;
}

function parseCsvField(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  const s = String(val).trim();
  if (!s || s === "none") return undefined;
  const items = s.split(",").map((t) => t.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/** omitted → defaults; "none"/empty → []; csv → items. */
function csvList(val: unknown, defaults: string[]): string[] {
  if (val === undefined || val === null) return defaults;
  return parseCsvField(val) ?? [];
}

/** omitted/true → true; false/"none" → false; csv → items. */
function inheritField(val: unknown): true | string[] | false {
  if (val === undefined || val === null || val === true) return true;
  if (val === false || val === "none") return false;
  const items = csvList(val, []);
  return items.length > 0 ? items : false;
}
