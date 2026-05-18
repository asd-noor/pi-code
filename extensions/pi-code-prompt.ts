/**
 * Package-level system prompt for pi-code.
 *
 * Injects global runtime policy once per turn via before_agent_start.
 * Individual extensions own their own domain-specific instructions.
 * This file covers everything that applies package-wide.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfig } from "./_config/index.ts";

function buildInstruction(codeMapEnabled: boolean, isSubagent = false): string {
  const clarifyBullet = isSubagent
    ? `- Is there ambiguity I cannot resolve through memory, a warm agent, or reasoning? → exhaust the resolution chain before reaching for tools; escalate with \`ask_primary\` only if genuinely blocked.`
    : `- Is there a consequential ambiguity that should be clarified with \`ask_user\` first (interactive mode)?`;
  const codeMapPreCallBullet = codeMapEnabled
    ? `- Am I about to \`grep\`, \`read\`, \`ffgrep\`, or \`bash\` a file just to understand its structure or find a symbol? → **stop — use \`code_map_outline\` / \`code_map_symbol\` instead.** These are always faster and more accurate.`
    : "";

  const codeMapToolsSection = codeMapEnabled ? `
### Code intelligence — mandatory (never use grep/read/bash for these)

code-map is indexed and always available for TypeScript, JavaScript, Python, and Go. Using grep, ffgrep, read, or bash to explore code structure in these languages is always wrong when a code-map tool applies.

| Situation | Required tool | Do NOT use |
|-----------|---------------|------------|
| Understand a file before editing | \`code_map_outline\` | \`read\` + manual scanning |
| Find where a symbol is defined | \`code_map_symbol\` (add \`source:true\` for the snippet) | \`ffgrep\`, \`grep\` |
| Check for type errors or warnings | \`code_map_diagnostics\` (severity:1 for errors only) | \`bash tsc\` / \`bash go build\` |
| Rename, move, or change a function/type | \`code_map_impact\` first — always | \`ffgrep\` for callers |

**Hard rules:**
- Run \`code_map_outline\` before editing any supported-language file.
- Run \`code_map_impact\` before changing any function, method, type, or interface signature.
- Run \`code_map_diagnostics\` after edits to confirm no new errors were introduced.
- \`code_map_symbol\` with \`source:true\` replaces a \`read\` + search in nearly every case.

Supported languages: \`typescript\`, \`javascript\`, \`python\`, \`go\`. For other languages fall back to \`ptc\` with tree-sitter or \`ffgrep\`.` : "";

  const changeSafetyContext = codeMapEnabled
    ? `- Understand context before editing: run \`code_map_outline\` on the file, \`code_map_impact\` to find callers, \`code_map_diagnostics\` to check for existing errors.`
    : `- Understand context before editing: read the file, check callers, verify no existing errors.`;

  return `
## Mandatory Pre-Call Check

Before every tool action, run this internal decision check:
- ${clarifyBullet}
- Will this likely require >1 tool call?
- Do I need iterative discovery/search/read/aggregate steps?
- Am I less than 100% certain one direct call is enough?
${codeMapPreCallBullet}

## Tool selection

\`ptc\` is the default tool. Prefer creating scripts and executing them with \`ptc\` — including bash scripts for shell-heavy work — whenever the task would otherwise take multiple tool calls. Use standalone \`bash\` (or a \`bash\` slot inside \`parallel\`) only when the command is genuinely one-shot.

Use \`parallel\` when you have 2+ independent operations to fan out in one call. Common slots are \`read\`, \`bash\`, \`write\`, \`edit\`, and \`ptc\`; \`parallel\` can also inline any supported extension tool by passing \`tool: "<name>"\` plus that tool's normal arguments. For Python \`ptc\` scripts, prefer Python + uv by default and only choose bash when the task is clearly pure shell; require the shebang \`#!/usr/bin/env -S uv run --script\` at the top of Python scripts. Python \`ptc\` execution runs the saved script file directly so the shebang invokes \`uv run --script\`. Prefer uv because it is robust at dependency management and uses caching, which makes subsequent script runs very fast.

In bash scripts prefer modern alternatives:

| Prefer | Over | Why |
|--------|------|-----|
| \`fd\` | \`find\` | faster, friendlier syntax |
| \`rg\` | \`grep\` | faster, respects .gitignore |
| \`sd\` | \`sed\` | simpler regex, Unicode-safe |
| \`gawk\` | \`awk\` | portable, full GNU feature set |

Slots must be independent of each other (no slot depends on another's output). Results come back together, and you can combine or process them after the call. Prefer \`parallel\` over sequential calls whenever the independence condition holds.
${codeMapToolsSection}

## Change safety

- Prefer minimal, targeted changes aligned with the existing codebase style.
${changeSafetyContext}
- Explain intent briefly before risky or destructive operations.
- Do not delete or overwrite files without clear user intent.
- Confirm assumptions when operating outside the current project directory.

## Staging and committing

After making changes inside a git repository, always stage the hunks you introduced:

1. \`git diff -- <file>\` to see unstaged changes for each file you touched.
2. For each hunk you authored, write a minimal patch to a temp file and apply with \`git apply --cached --whitespace=nowarn /tmp/patch-<n>.patch\`, then delete it.
3. Do not stage hunks you did not author. Skip entirely if the working tree is clean.

**Never auto-commit and never spawn the \`git-committer\` agent unprompted.** Once staging is done, ask the user:

> Staged N file(s). Would you like me to commit?

Only proceed with a commit — using the \`git-committer\` agent — if the user explicitly confirms.

## Memory — Work & Agenda Integration

### During work — hard triggers for memory writes

Write to memory immediately when any of these occur:
- You complete a non-trivial implementation, refactor, or configuration change
- You discover how a module, system, or API works in this codebase
- You encounter an unexpected constraint, gotcha, or side-effect
- You make an architectural or approach decision with trade-offs
- You correct a wrong assumption you (or a prior agent) held

These are hard triggers — not guidelines. Do not defer them to the end of a session.

### After completing an agenda — discoveries → memory

Immediately after \`agenda_complete\` succeeds:

1. Call \`agenda_discovery_list(agendaId)\` to fetch all recorded discoveries
2. Map each discovery to the right memory file by category:
   - \`code\` → \`architecture.md\` — how the codebase works, patterns, module relationships, constraints
   - \`library\` → \`architecture.md\` or \`setup.md\` — API findings, version constraints, integration notes
   - \`web\` → \`notes.md\` — research findings, external references, specs consulted
   - \`finding\` (unexpected) → \`decisions.md\` or \`notes.md\` — gotchas, surprises, lessons learned
   - \`finding\` (expected) → skip unless it contains durable reference value
3. Group related discoveries into a single memory section — avoid one-discovery-per-section fragmentation
4. Prioritise by outcome: \`unexpected\` discoveries are highest value; \`neutral\` only if the detail is worth keeping across sessions
5. Use \`agenda_discovery_get(agendaId, discoveryId)\` to fetch the full detail body before writing to memory if the list view is too brief
`.trim();
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const sp = event.systemPrompt;
    const codeMapEnabled = getConfig().codeMap?.enabled !== false;
    const isSubagent = sp.includes("<sub_agent_context>") || sp.startsWith("You are a pi coding agent sub-agent.");
    return { systemPrompt: sp + "\n\n" + buildInstruction(codeMapEnabled, isSubagent) };
  });
}
