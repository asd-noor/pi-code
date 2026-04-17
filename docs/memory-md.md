# memory-md

Persistent markdown-backed memory store with hybrid FTS5 + vector search. The `memory-md` binary is used as-is — this extension manages its lifecycle and exposes its operations as pi tools.

## How it works

```
session_start
  └── read config: ~/.pi/agent/memory-md.json
  └── ensure memory directory exists
  └── spawn: memory-md start-daemon (with MEMORY_MD_DIR set)
        - validates memory dir
        - opens SQLite index (FTS5 + vec0)
        - starts vector sidecar if uv is in PATH (Apple Silicon)
        - binds channel.sock, starts file watcher

LLM tool call
  └── extension calls: MEMORY_MD_DIR=... memory-md <subcommand>
  └── binary connects to daemon socket, executes query

File change (via daemon's watcher)
  └── 500ms debounce → re-parse changed .md file → update index

session_shutdown
  └── SIGTERM → daemon exits, removes socket
```

## LLM tools

| Tool | Description |
|---|---|
| `memory_list` | List all memory files, or all sections within a file |
| `memory_get` | Exact path lookup |
| `memory_search` | Hybrid FTS5 + vector search |
| `memory_new` | Create a new section |
| `memory_update` | Replace a section's body (child sections preserved) |
| `memory_delete` | Delete a section and all its children |
| `memory_create_file` | Create a new empty memory file (topic area) |
| `memory_delete_file` | Delete a memory file and all its sections |

### Path conventions

Memory is organised hierarchically by file and section headings:

```
auth.md
  ## API Keys          → path: auth/api-keys
    ### Rotation Policy → path: auth/api-keys/rotation-policy
```

- File name (without `.md`) is always the first path segment
- Headings are slugified: lowercase, spaces → `-`, non-alphanumeric stripped
- `"API Keys"` → `api-keys`, `"Token Refresh Policy"` → `token-refresh-policy`

### Workflow: storing

```
1. memory_list                          check if file exists
2. memory_create_file name:"auth"       create file if not
3. memory_new path:"auth/api-keys"      add section
              heading:"API Keys"
              body:"Keys are hashed with bcrypt."
```

### Workflow: retrieving

```
1. memory_search query:"key rotation"   find relevant sections
2. memory_get path:"auth/api-keys"      get exact section
```

## Commands

| Command | Description |
|---|---|
| `/memory` or `/memory status` | Show daemon status, memory directory, socket path |
| `/memory restart` | Kill daemon, reload config, respawn |
| `/memory snapshot` | Copy all `.md` files to a timestamped subdirectory |
| `/memory logs` | Show last 50 lines of daemon log |

## Configuration

No config file needed. Directory resolved in order:

1. `$MEMORY_MD_DIR` env var — if already set in the environment
2. `~/.pi/memory` — global default, created automatically

`/memory status` shows which source is active.

## Footer status

| Status | Meaning |
|---|---|
| `☰ memory: starting…` | Daemon spawned, initialising |
| `☰ memory: running` | Daemon ready, accepting queries |
| `☰ memory: stopped` | Daemon not running |

## Vector search

When `uv` is in `PATH` and running on Apple Silicon (M1+), the daemon automatically spawns a Python sidecar (`mlx-embeddings`) for vector search. Queries then use hybrid FTS5 + vector retrieval fused with Reciprocal Rank Fusion. On other hardware or when `uv` is absent, FTS5-only search is used.

## Cache layout

```
~/.cache/memory-md/
  embed.py       ← Python sidecar script (shared across all projects, Apple Silicon only)
  <sha256[:16] of MEMORY_MD_DIR>/
    dir            ← breadcrumb: the original MEMORY_MD_DIR path in plain text
    cache.sqlite   ← SQLite index (FTS5 + vec0)
    channel.sock   ← Unix socket
    sidecar.sock   ← Sidecar socket (Apple Silicon only)
    daemon.log     ← Daemon output log
```

The 16-char hash keeps socket paths well within macOS's 104-byte `sun_path` limit. The `dir` breadcrumb file identifies which cache dir belongs to which memory dir:

```bash
cat ~/.cache/memory-md/*/dir
```

## Requirements

- `memory-md` binary in PATH — see [memory-md installation](https://github.com/yourorg/memory-md)
- `MEMORY_MD_DIR` is managed by the extension — do not set it in your shell when using pi
- `uv` in PATH (optional) — enables vector search on Apple Silicon

## Skill

The `memory-md` skill is auto-registered and teaches the LLM when to use memory tools, path conventions, and the decision guide for choosing the right operation.
