/**
 * ptc.ts — Programmatic Tool Calling.
 *
 * Registers a single `ptc` tool that runs a Python (uv) or bash script
 * in one tool call. PTC is the default — individual tools are the exception.
 *
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getProjectTempDir } from "./_config/index.ts";

const execFileAsync = promisify(execFile);

const SYSTEM_INSTRUCTION = `
## Programmatic Tool Calling (PTC)

**\`ptc\` is the default tool.** Prefer creating scripts and executing them with \`ptc\` — including bash scripts for shell-heavy work — whenever the task would otherwise take multiple tool calls. **Never use the standalone \`bash\` tool** — always go through \`ptc\`.
Use \`read\` and \`edit\` only in the specific cases below.

### Decision tree

1. **Two or more independent operations?** → \`parallel\` — fan them out in one call, all run concurrently
   - Common slots are: \`read\`, \`write\`, \`edit\`, and **\`ptc\`**
   - \`parallel\` can also inline any supported extension tool by passing \`tool: "<name>"\` plus that tool's normal arguments
   - do NOT use raw \`bash\` slots
   - Slots must be independent: no slot may depend on another slot's output
   - Results are returned together — combine or process them after the call
2. **Single operation?** → always use \`ptc\`. Every \`ptc\` call must include a \`purpose\` field
3. **Exceptions — use the named tool directly:**
   - \`read\` — when you need raw file content in your context window *before deciding* what to do
   - \`edit\` — when two parallel slots write to the same file (\`edit\` uses a mutation queue to prevent races)

### \`parallel\` with \`ptc\` slots

\`parallel\` can mix \`ptc\` scripts with reads, edits, writes, and other supported extension tools in one fan-out call:

\`\`\`
parallel([
  ptc(type="python", script="..."),   // analyse file A
  ptc(type="python", script="..."),   // analyse file B simultaneously
  read(path="config.ts"),             // bring raw content into context
])
\`\`\`

Use this to run multiple scripts and other independent operations all at once. Always use \`ptc\` — never a raw \`bash\` slot.

### Script types

1. **Python** (default) — executed via \`uv run --script\`. Include PEP 723 inline metadata for dependencies. No shebang needed.
2. **Bash** — use only for clearly pure-shell tasks: git, build steps, shell pipelines.

In bash scripts prefer modern alternatives:

| Prefer | Over | Why |
|--------|------|-----|
| \`fd\` | \`find\` | faster, friendlier syntax |
| \`rg\` | \`grep\` | faster, respects .gitignore |
| \`sd\` | \`sed\` | simpler regex, Unicode-safe |
| \`gawk\` | \`awk\` | portable, full GNU feature set |

### Python scripts

Python scripts are executed via \`uv run --script\` — no shebang needed. Include PEP 723 inline metadata to declare dependencies:

\`\`\`python
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
\`\`\`

uv handles dependencies robustly and its cache makes repeated runs very fast.
Use \`tmux_run\` for long-running or interactive processes — \`ptc\` scripts are for short-lived tasks.

### code-map access from scripts

The code-map daemon speaks a simple JSON protocol over a Unix socket. Connect directly:

\`\`\`python
import socket, json
from pathlib import Path

def _code_map(method: str, params: dict, root: str) -> any:
    sock = Path.home() / ".pi" / "cache" / root.replace("/", "=") / "codemap-daemon.sock"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.connect(str(sock))
        s.sendall((json.dumps({"id": 1, "method": method, "params": params}) + "\n").encode())
        data = b""
        while True:
            chunk = s.recv(4096)
            if not chunk: break
            data += chunk
            if b"\n" in data: break
        return json.loads(data.decode().strip())["result"]

# Available methods: outline, symbol, diagnostics, impact
symbols     = _code_map("outline",     {"file": "src/index.ts"},  "/abs/project/root")
diagnostics = _code_map("diagnostics", {"severity": 1},           "/abs/project/root")
callers     = _code_map("impact",      {"name": "MyClass"},       "/abs/project/root")
\`\`\`

### On failure

Fix the script and call \`ptc\` again — do not fall back to individual tool calls or the \`bash\` tool.

### Script reuse

Every \`ptc\` run prints the filename in the output header (e.g. \`ptc: my_script.py\`). Within the same session, omit \`script\` and pass only \`name\` to re-run an existing script without re-sending its content. If the script needs changes, provide \`script\` again to overwrite and re-run.
`.trim();

export default function (pi: ExtensionAPI) {

  // ── Tool ─────────────────────────────────────────────────────────────────

  pi.registerTool({
    name:  "ptc",
    label: "Run Script",
    description: `Default tool. Run a Python (uv) or bash script in one call. Prefer Python + uv by default; use bash only for clearly pure-shell tasks (git, build steps, pipelines). The standalone \`bash\` tool is prohibited — always use ptc.

Every ptc call must include a \`name\` field — a short snake_case identifier used as the filename (e.g. \`parse_json\`, \`build_summary\`).

Every ptc call must include a purpose field — a one-line description of what the script does.
The purpose is shown in the UI when the tool runs.

Use \`parallel\` for 2+ independent operations. Use individual tools directly only when:
- read: raw file content is needed in context to reason before deciding
- edit: parallel calls may touch the same file (mutation queue safety)
Everything else: use ptc.

Script types:
1. Python (default) — executed via \`uv run --script\`. Include PEP 723 inline metadata (\`# /// script\`) for dependencies. No shebang needed.
2. Bash — use only for clearly pure-shell tasks: git, build steps, shell pipelines.

Script reuse: omit \`script\` and pass only \`name\` to reuse a script written earlier this session. If the result is unexpected and changes are needed, provide \`script\` again to overwrite and re-run.

Use \`tmux_run\` for long-running or interactive processes — ptc scripts are for short-lived tasks.

On failure: fix the script and call ptc again — do not fall back to individual tool calls or the \`bash\` tool.`,
    promptSnippet: "Default tool — runs Python (uv) or bash scripts. Prefer Python + uv by default; use bash only for pure-shell tasks. The standalone `bash` tool is prohibited — always use ptc. Python scripts run via `uv run --script` with PEP 723 inline metadata — no shebang needed. Use `parallel` for 2+ independent operations, including `ptc` slots.",
    parameters: Type.Object({
      name: Type.String({
        description: "Short meaningful snake_case name for the script, e.g. `parse_config`, `fetch_users`. Used as the filename and for reuse. Do NOT use tool call IDs or generic names like `script` or `run`.",
      }),
      purpose: Type.String({
        description: "One-line description of what this script does. Shown in the UI when the tool runs.",
      }),
      type: StringEnum(["python", "bash"] as const, {
        description: "Script type. Default: python (run via uv). Use bash only for clearly pure-shell tasks.",
      }),
      script: Type.Optional(Type.String({
        description: "Full script content. If provided, writes (or overwrites) the file before running. Omit to reuse a script written earlier this session — pass only `name`.",
      })),
      args: Type.Optional(Type.Array(Type.String(), {
        description: "Command-line arguments passed to the script.",
      })),
      stdin: Type.Optional(Type.String({
        description: "Data to pipe to the script's stdin.",
      })),
    }),


    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const ptcDir = join(getProjectTempDir(ctx.cwd), "ptc");
      mkdirSync(ptcDir, { recursive: true });

      const ext  = params.type === "python" ? "py" : "sh";
      const file = join(ptcDir, `${params.name}.${ext}`);
      if (params.script) {
        writeFileSync(file, params.script, { mode: 0o755 });
      } else if (!existsSync(file)) {
        throw new Error(`No script provided and no existing file found: ${file}`);
      }

      const cmd  = params.type === "python" ? "uv" : "bash";
      const args = params.type === "python"
        ? ["run", "--script", file, ...(params.args ?? [])]
        : [file, ...(params.args ?? [])];

      onUpdate?.({ content: [{ type: "text", text: "Running..." }], details: undefined });

      const scriptName = basename(file);
      const header = `ptc: ${scriptName}\nPurpose: ${params.purpose}`;

      try {
        const result = await execFileAsync(cmd, args, {
          cwd: ctx.cwd,
          input: params.stdin,
          timeout: 120_000,
          signal,
          maxBuffer: 10 * 1024 * 1024,
        } as any);

        const out = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        return {
          content: [{ type: "text", text: `${header}\n${out || "(no output)"}` }],
          details: { file, exitCode: 0 },
        };
      } catch (err: any) {
        const stdout = err.stdout ?? "";
        const stderr = err.stderr ?? "";
        const out    = [stdout, stderr].filter(Boolean).join("\n").trim();
        const code   = err.code ?? 1;
        return {
          content: [{ type: "text", text: `${header}\nExit ${code}:\n${out || err.message}` }],
          details: { file, exitCode: code },
          isError: true,
        };
      }
    },
  });

  // ── System prompt ─────────────────────────────────────────────────────────

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${SYSTEM_INSTRUCTION}`,
  }));
}
