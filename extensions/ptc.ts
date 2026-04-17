/**
 * ptc.ts — Programmatic Tool Calling.
 *
 * Registers a single `ptc` tool that runs a Python (uv) or bash script
 * in one tool call. PTC is the default — individual tools are the exception.
 *
 * MCP access from within scripts: use the `mcporter` binary directly.
 *   mcporter call server.tool key=value --output json
 *   mcporter list --schema
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SANDBOX_DIR   = "/tmp/pi-sandbox";

const SYSTEM_INSTRUCTION = `
## Programmatic Tool Calling (PTC)

**Default to \`ptc\` for all work.** Use individual tools only in these specific cases:

- **\`read\`** — only when you need raw file content in your context window to reason about it before deciding what to do (e.g. reading a file before planning an edit strategy). If reading to process or summarise, use \`ptc\`.
- **\`edit\`** — only when making parallel tool calls that may touch the same file simultaneously. \`edit\` uses a file mutation queue that prevents race conditions in parallel execution. For sequential edits, \`ptc\` is fine.
- Everything else: **use \`ptc\`**.

### Script type priority

1. **Python** (primary) — data processing, file operations, APIs, parsing, logic
2. **Bash** — shell operations, git, build commands, multi-step shell logic

### Python scripts must use PEP 723 inline metadata

\`\`\`python
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
\`\`\`

### MCP access from scripts

Use the \`mcporter\` binary directly — no bridge needed:

\`\`\`python
import subprocess, json

def mcp(selector: str, **kwargs) -> dict:
    args = ["mcporter", "call", selector, "--output", "json"]
    for k, v in kwargs.items():
        args.append(f"{k}={v}")
    r = subprocess.run(args, capture_output=True, text=True, check=True)
    return json.loads(r.stdout)

# Discover available servers and tools: mcporter list --schema
issues = mcp("linear.list_issues", team="ENG", limit=10)
repos  = mcp("github.list_repos", owner="acme")
\`\`\`

\`\`\`bash
# Bash
mcporter call linear.list_issues team=ENG limit=10 --output json
mcporter call server.tool --args '{"key": "value", "nested": {"a": 1}}'
\`\`\`

### code-map access from scripts

The code-map daemon speaks a simple JSON protocol over a Unix socket. Connect directly:

\`\`\`python
import socket, json
from pathlib import Path

def _code_map(method: str, params: dict, root: str) -> any:
    sock = Path.home() / ".pi" / "cache" / "code-map" / root.replace("/", "=") / "daemon.sock"
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

Fix the script and call \`ptc\` again — do not fall back to individual tool calls.
`.trim();

export default function (pi: ExtensionAPI) {

  // ── Tool ─────────────────────────────────────────────────────────────────

  pi.registerTool({
    name:  "ptc",
    label: "Run Script",
    description: `Default tool for all work. Run a Python (uv) or bash script in one call.

Use individual tools only when:
- read: raw file content is needed in context to reason before deciding
- edit: parallel calls may touch the same file (mutation queue safety)
Everything else: use ptc.

Script type priority:
1. Python (primary) — PEP 723 inline deps, use for data/files/APIs/logic
2. Bash — shell operations, git, build steps

MCP access: use the mcporter binary directly from within the script.
  Python: subprocess.run(["mcporter", "call", "server.tool", "key=value", "--output", "json"])
  Bash:   mcporter call server.tool key=value --output json
  Discover: mcporter list --schema

On failure: fix the script and call ptc again — do not fall back to individual tool calls.`,
    promptSnippet: "Default tool for all work — runs Python or bash scripts. Use instead of read/write/bash/edit tool calls. MCP via mcporter binary.",
    parameters: Type.Object({
      type: StringEnum(["python", "bash"] as const, {
        description: "Script type. Prefer python unless the task is pure shell.",
      }),
      script: Type.String({
        description: "Full script content. Python scripts must include a PEP 723 metadata block.",
      }),
      args: Type.Optional(Type.Array(Type.String(), {
        description: "Command-line arguments passed to the script.",
      })),
      stdin: Type.Optional(Type.String({
        description: "Data to pipe to the script's stdin.",
      })),
    }),

    async execute(toolCallId, params, signal, onUpdate, _ctx) {
      mkdirSync(SANDBOX_DIR, { recursive: true });

      const ext  = params.type === "python" ? "py" : "sh";
      const file = `${SANDBOX_DIR}/${toolCallId.slice(0, 8)}.${ext}`;
      writeFileSync(file, params.script, { mode: 0o755 });

      const cmd  = params.type === "python" ? "uv" : "bash";
      const args = params.type === "python"
        ? ["run", file, ...(params.args ?? [])]
        : [file,        ...(params.args ?? [])];

      onUpdate?.({ content: [{ type: "text", text: `Running ${file}…` }], details: undefined });

      try {
        const result = await execFileAsync(cmd, args, {
          input:     params.stdin,
          timeout:   120_000,
          signal,
          maxBuffer: 10 * 1024 * 1024,
        } as any);

        const out = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        return {
          content: [{ type: "text", text: out || "(no output)" }],
          details: { file, exitCode: 0 },
        };
      } catch (err: any) {
        const stdout = err.stdout ?? "";
        const stderr = err.stderr ?? "";
        const out    = [stdout, stderr].filter(Boolean).join("\n").trim();
        const code   = err.code ?? 1;
        return {
          content: [{ type: "text", text: `Exit ${code}:\n${out || err.message}` }],
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
