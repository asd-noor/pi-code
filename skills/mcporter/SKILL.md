---
name: mcporter
description: >
  Use MCP (Model Context Protocol) tools through a single, stable proxy tool. Acts as a thin bridge to search, describe, and call tools from external MCP servers without polluting the primary context window.
---

# mcporter

## Native Tool
### Description
Use MCP tools through a single, stable proxy tool (`mcporter`). This skill acts as a thin bridge to interact with external MCP servers without polluting the primary agent context window.

###  Philosophy & Usage Guidelines
- **CLI > MCP:** You are fundamentally CLI-first. Always prefer native command-line interfaces (e.g., `gh`, `git`, `kubectl`, `aws`) whenever available.
- **When to Use:** Use the `mcporter` tool only when it adds clear value, such as interacting with Linear, Slack, hosted auth-heavy integrations, or complex cross-tool workflows.
- **Do Not Guess Schemas:** Unless the tool metadata is preloaded into your context, you must discover the tool and read its schema before attempting a call.

###  The Three-Step Workflow

1. **Search (`search`)** — *Find tools by keyword*
   Use this action when you do not know the exact server or tool name.
   - Example Input: `{"action": "search", "query": "linear issue"}`
   - Returns: Matching selectors (e.g., `linear.create_issue`) and short descriptions.

2. **Describe (`describe`)** — *Get the full schema for a tool*
   Use this action once you know the selector (format: `server.tool`) but need to see its exact required parameters, types, and optional fields.
   - Example Input: `{"action": "describe", "selector": "linear.create_issue"}`
   - Returns: The full JSON Schema for the specified tool.

3. **Call (`call`)** — *Invoke a tool*
   Use this action once you know the exact selector and its precise schema requirements.
   - Example Input: `{"action": "call", "selector": "linear.create_issue", "args": {"title": "Fix bug", "teamId": "TEAM-1"}}`

*Note: If the agent is running in `preload` mode and you already know the exact schema, you may skip `search` and `describe` and jump straight to `call`.*

###  Tool Schema

You have access to the following tool to interact with the MCPorter bridge:

```json
{
  "name": "mcporter",
  "description": "Proxy tool to discover, describe, and invoke tools from external MCP servers.",
  "parameters": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": ["search", "describe", "call"],
        "description": "The workflow step to perform."
      },
      "selector": {
        "type": "string",
        "description": "Target tool selector in the format 'server.tool'. Required for 'describe' and 'call' actions."
      },
      "query": {
        "type": "string",
        "description": "Free-text query to search for tools. Used only when action is 'search'."
      },
      "limit": {
        "type": "number",
        "description": "Maximum number of search results to return. Default is 20, max is 100. Used only when action is 'search'."
      },
      "args": {
        "type": "object",
        "description": "The JSON object containing the parameters required by the target tool. Used only when action is 'call'."
      },
      "argsJson": {
        "type": "string",
        "description": "A JSON-encoded string fallback for arguments that are awkward to express as nested JSON. Used only when action is 'call'."
      },
      "timeoutMs": {
        "type": "number",
        "description": "Optional timeout override for the call in milliseconds. Useful for slow-running operations."
      }
    },
    "required": ["action"]
  }
}
```

###  Troubleshooting & Error Handling
• Truncated Output: If the response from an MCP tool is too large, the output will be truncated and the tool will return a temporary file path containing the full output. Use standard file reading commands to view the complete content.
• Slow Calls/Timeouts: If a call action times out, retry the action and pass a higher value to the timeoutMs parameter.
• Unknown Server/Tool: The server may not be configured. Instruct the user to run `mcporter list` to verify visibility.
• Auth Failures: If the tool returns an authentication error, instruct the user to run `mcporter auth <server>` in their terminal.

## CLI Tool

Use the `mcporter` CLI when you need command-line access instead of the native `mcporter` tool wrapper.
It is especially useful inside scripts, for quick local inspection, or when you want to verify behavior
against the actual installed binary.

### CLI Overview

```sh
mcporter <command> [options]
```

### Core commands

- `list` — list configured servers; add `--schema` for tool docs
  ```sh
  mcporter list [name] [--schema] [--json]
  ```
- `call` — call a tool by selector (`server.tool`) or HTTP URL; supports inline argument pairs
  ```sh
  mcporter call <selector> [key=value ...]
  ```
- `auth` — complete OAuth for a server without listing tools first
  ```sh
  mcporter auth <server | url> [--reset]
  ```

### Generator & tooling commands

- `generate-cli` — emit a standalone CLI for a server or command target
  ```sh
  mcporter generate-cli --server <name> | --command <ref> [options]
  ```
- `inspect-cli` — show metadata and regeneration instructions for a generated CLI
  ```sh
  mcporter inspect-cli <path> [--json]
  ```
- `emit-ts` — generate TypeScript client code or types for a server
  ```sh
  mcporter emit-ts <server> --mode client|types [options]
  ```

### Configuration

- `config` — inspect or edit config files
  ```sh
  mcporter config <command> [options]
  ```
  Supports subcommands such as: `list`, `get`, `add`, `remove`, `import`, `login`, and `logout`.

### Daemon

- `daemon` — manage the keep-alive daemon
  ```sh
  mcporter daemon <subcommand>
  ```
  Common subcommands: `start`, `status`, `stop`, `restart`.

### Global flags

- `--config <path>` — path to `mcporter.json` (default: `$HOME/.mcporter/mcporter.json`)
- `--root <path>` — working directory for stdio servers
- `--log-level <debug|info|warn|error>` — CLI log level (default: `warn`)
- `--oauth-timeout <ms>` — browser OAuth wait timeout in milliseconds (default: `60000`)

### Usage examples

```sh
mcporter list
mcporter list linear --schema
mcporter call linear.list_issues limit=5
mcporter auth linear
mcporter daemon status
```

### Notes

- Use `mcporter <command> --help` for detailed flags on a specific subcommand.
- The CLI auto-loads servers from `$HOME/.mcporter/mcporter.json` and editor imports (Cursor, Claude, Codex, etc.).
- Prefer the native `mcporter` tool in normal agent execution when available; use the CLI for shell workflows and scripts.
