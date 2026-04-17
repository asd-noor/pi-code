# code-map

LSP-backed code intelligence for pi. Spawns a per-project daemon that indexes every symbol into an in-memory graph and answers queries in milliseconds.

## How it works

```
session_start
  └── resolve git root (or cwd)
  └── spawn daemon: bun run daemon/runner.ts <root> --auto-install --file-limit=N
        1. detect + install LSP server if missing
        2. init LSP, open all project files
        3. Phase 1: documentSymbol every file → symbol graph  ← "ready"
        4. Phase 2: references per fn/method/class → reverse refs (background)

Query (LLM tool call)
  └── SocketClient connects to ~/.pi/cache/code-map/<project>/daemon.sock
  └── JSON query → result in ~50ms

File change
  └── watcher fires (500ms debounce) → re-index that file only
```

## LLM tools

| Tool | Description |
|---|---|
| `code_map_outline` | Structural overview of a file — all symbols the LSP sees |
| `code_map_symbol` | Find every definition of a symbol across the workspace |
| `code_map_diagnostics` | LSP diagnostics (type errors, warnings, hints) |
| `code_map_impact` | Every caller of a symbol — blast radius for refactoring |

### `code_map_outline`

```
file: string    — absolute or relative path
```

Returns all symbols in the file: functions, classes, methods, interfaces, types, enums, constants — with kind, name, and line range.

### `code_map_symbol`

```
name:   string   — plain name, qualified (Store.Find), or Go receiver syntax
source: boolean? — include source snippet (default: false)
```

Searches the whole workspace. Use the qualified form from `code_map_outline` output for precise results.

### `code_map_diagnostics`

```
file:     string? — filter to a specific file (omit for all files)
severity: number? — 1=error, 2=warning, 3=info, 4=hint, 0=all (default: 0)
```

Real LSP diagnostics — same errors the editor would show.

### `code_map_impact`

```
name: string — symbol name to find callers for
```

Returns every reference to the symbol with the enclosing function at each call site. Instant once background indexing has reached the symbol; falls back to a live LSP call otherwise.

## Commands

| Command | Description |
|---|---|
| `/code-map` or `/code-map status` | Show daemon status, project root, file limit |
| `/code-map restart` | Kill daemon, reload config, respawn |
| `/code-map logs` | Show last 50 lines of daemon log |

## Configuration

`~/.pi/agent/code-map.json` — created with defaults on first run:

```json
{
  "fileLimit": 200
}
```

| Field | Default | Description |
|---|---|---|
| `fileLimit` | `200` | Max files for initial indexing at startup |

The file limit only caps the **initial index**. The file watcher covers all directories regardless, so files beyond the limit are still re-indexed incrementally when changed.

Run `/code-map restart` after editing the config to apply changes.

## Footer status

| Status | Meaning |
|---|---|
| `⬡ code-map: starting…` | Daemon spawned, LSP initialising |
| `⬡ code-map: indexing…` | Phase 1 in progress |
| `⬡ code-map: ready` | Graph built, queries open |
| `⬡ code-map: error` | Daemon failed — check `/code-map logs` |
| `⬡ code-map: stopped` | Daemon not running |

## Cache layout

```
~/.pi/cache/code-map/
  lsp/                          shared LSP binaries (all projects)
    node_modules/.bin/          npm-installed servers
    bin/                        standalone binaries
    go/bin/                     gopls
  =Users=noor=project/          per-project state (/ → =)
    daemon.sock
    daemon.log
    daemon.status
```

## Language support

Auto-detected from project root files:

| Language | Detection | Server |
|---|---|---|
| TypeScript / JavaScript | `tsconfig.json` or `package.json` | `typescript-language-server` |
| Go | `go.mod` | `gopls` |
| Rust | `Cargo.toml` | `rust-analyzer` |
| Python | `pyproject.toml` / `setup.py` / `requirements.txt` | `pyright` → `pylsp` |
| Lua | `.luarc.json` or `.luacheckrc` | `lua-language-server` |

LSP servers are auto-installed to `~/.pi/cache/code-map/lsp/` on first run (`--auto-install`).

## Requirements

- Bun (used to spawn the daemon process)
- Git (for project root detection; falls back to `cwd`)
