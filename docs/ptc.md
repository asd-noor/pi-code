# ptc (Programmatic Tool Calling)

A `ptc` tool that runs a Python or bash script in a single tool call, replacing multiple sequential tool calls. MCP access is handled via the `mcporter` binary directly from within scripts.

## Tool: `ptc`

| Parameter | Type | Description |
|---|---|---|
| `type` | `"python"` \| `"bash"` | Script type. Prefer `python` unless the task is pure shell. |
| `script` | string | Full script content |
| `args` | string[]? | Command-line arguments passed to the script |
| `stdin` | string? | Data piped to the script's stdin |

Scripts are written to `/tmp/pi-sandbox/<id>.<ext>` and executed immediately.

## Priority

```
1. python   — primary; data processing, files, APIs, parsing, logic (PEP 723 deps)
2. bash     — shell operations, git, build commands, multi-step shell
```

## Python scripts (PEP 723)

```python
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "httpx>=0.27",
# ]
# ///
import sys, json, httpx

resp = httpx.get(sys.argv[1], timeout=10)
print(json.dumps(resp.json(), indent=2))
```

## code-map access from scripts

The code-map daemon is directly accessible via its Unix socket — no pi tool layer needed:

```python
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

# Available methods
symbols     = _code_map("outline",     {"file": "src/index.ts"}, "/abs/project/root")
diagnostics = _code_map("diagnostics", {"severity": 1},          "/abs/project/root")
callers     = _code_map("impact",      {"name": "MyClass"},      "/abs/project/root")
```

## MCP access via mcporter

Call any MCP tool directly from within a `ptc` script using the `mcporter` binary:

### Python

```python
import subprocess, json

def mcp(selector: str, **kwargs) -> dict:
    args = ["mcporter", "call", selector, "--output", "json"]
    for k, v in kwargs.items():
        args.append(f"{k}={v}")
    r = subprocess.run(args, capture_output=True, text=True, check=True)
    return json.loads(r.stdout)

issues = mcp("linear.list_issues", team="ENG", limit=10)
repos  = mcp("github.list_repos", owner="acme")
```

### Bash

```bash
mcporter call linear.list_issues team=ENG limit=10 --output json
mcporter call server.tool --args '{"key": "value", "nested": {"a": 1}}'
```

### Discovery

```bash
mcporter list           # list configured servers
mcporter list linear --schema   # see tool schemas and parameters
```

## On failure

The tool returns exit code + stderr on failure. Fix the script and call `ptc` again — do not fall back to individual tool calls.

## System instruction

A PTC instruction is appended to the system prompt on every turn, covering:
- Script type priority (python → bash)
- PEP 723 metadata block requirement
- MCP access patterns via `mcporter`
- Retry behaviour on failure
