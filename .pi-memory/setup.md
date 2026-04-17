# setup

## Installation

```bash
pi install /path/to/pi-code        # global install
pi install -l /path/to/pi-code     # project-local install
```

## Requirements

- Pi coding agent (latest) — runtime host
- Node.js 22+ — `node:sqlite` for agenda extension
- Bun — spawning the code-map daemon
- `memory-md` binary in PATH — memory extension daemon
- `mcporter` binary in PATH — MCP bridge for doc-library and web-scout
- MCP servers configured for mcporter — enables Context7 (doc-library) and Tavily (web-scout)
- `pi-ask-tool-extension` — bundled in node_modules, provides the `ask` tool

## Installing Dependencies

```bash
npm install   # installs pi-mcporter and pi-ask-tool-extension
```

## Configuration

- code-map config file: `~/.pi/agent/code-map.json` — optional, sets `fileLimit` (default 200)
- Memory directory: `MEMORY_MD_DIR` env var, or `<cwd>/.pi-memory` (project-local default since v1.1.0)
- Bundled agents: seeded to `~/.pi/agent/agents/` on first run of the subagents extension
