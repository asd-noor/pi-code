# code-map

LSP-backed code intelligence for pi. Spawns a per-project daemon that indexes every symbol into a SQLite database and answers queries in milliseconds. The index persists across sessions — only changed files are re-parsed on restart.

## How it works

```
session_start
  └── resolve git root (or cwd)
  └── spawn daemon: bun run daemon/runner.ts <root> --auto-install --file-limit=N
        1. open codemap.db (creates if new)
        2. detect all applicable LSP servers from root markers
        3. install any missing LSP servers (--auto-install)
        4. load tree-sitter grammars for all 6 supported languages
        5. Phase 1: parse all files
               fresh files (mtime unchanged) → loaded from DB instantly
               stale/new files → tree-sitter parse → insert into DB
                                 (LSP documentSymbol fallback if no grammar)
           → write "ready"
        6. Phase 2 (background): start each LSP, open files, snapshot
               diagnostics → DB; reverse refs per fn/method/class → DB

Query (LLM tool call)
  └── SocketClient connects to ~/.pi/cache/<project>/codemap-daemon.sock
  └── JSON query → SQL → result in ~1ms

File change
  └── watcher fires (500ms debounce)
  └── deleteFile: removes nodes + diagnostics + stale reverse refs pointing
      INTO this file; unmarks affected external symbols as indexed
  └── tree-sitter re-parse → insert new nodes → update mtime
  └── background: LSP updateFile → snapshot all diagnostics → recompute
      reverse refs for changed file's symbols AND all affected external symbols
```

## LLM tools

All tools require a `language` parameter. If the language is not natively supported, a descriptive error is returned pointing to the `ptc` fallback.

| Tool | Description |
|---|---|
| `code_map_outline` | Structural overview of a file — all symbols the LSP sees |
| `code_map_symbol` | Find every definition of a symbol across the workspace |
| `code_map_diagnostics` | LSP diagnostics (type errors, warnings, hints) |
| `code_map_impact` | Every caller of a symbol — blast radius for refactoring |

### `code_map_outline`

```
file:     string  — absolute or relative path
language: string  — typescript | javascript | python | go | zig | lua
```

Returns all symbols in the file: functions, classes, methods, interfaces, types, enums — with kind, name, line range, and language.

### `code_map_symbol`

```
name:     string   — plain name, qualified (Store.Find), or Go receiver syntax
language: string   — typescript | javascript | python | go | zig | lua
source:   boolean? — include source snippet (default: false)
```

Searches the whole workspace filtered by language. Use the qualified form from `code_map_outline` output for precise results.

### `code_map_diagnostics`

```
language: string  — typescript | javascript | python | go | zig | lua
file:     string? — filter to a specific file (omit for all files)
severity: number? — 1=error, 2=warning, 3=info, 4=hint, 0=all (default: 0)
```

Real LSP diagnostics — same errors the editor would show. Only available for languages whose LSP was detected and started for the project.

### `code_map_impact`

```
name:     string — symbol name to find callers for
language: string — typescript | javascript | python | go | zig | lua
```

Returns every reference to the symbol with the enclosing function at each call site. Results are stored in the DB after first computation; eager recomputation is triggered after any file change that affects the caller graph.

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
~/.pi/cache/
  lsp/                          shared LSP binaries (all projects)
    node_modules/.bin/          npm-installed servers
    bin/                        standalone binaries
    go/bin/                     gopls
  tree-sitter/                  shared tree-sitter + grammar packages
  =Users=noor=project/          per-project state (/ → =)
    codemap-daemon.sock
    codemap-daemon.log
    codemap-daemon.status
    codemap-daemon.pid
    codemap.db                  SQLite: nodes, reverse_refs, diagnostics,
                                        indexed_nodes, file_meta (mtime)
```

## Language support

All 6 languages are indexed via tree-sitter on every project regardless of which LSPs are running. LSP servers are started for every language whose detection marker is present in the project root — a project can run multiple LSPs simultaneously.

| Language | Tree-sitter | LSP detection marker | LSP server |
|---|---|---|---|
| TypeScript / JavaScript | ✅ | `tsconfig.json` or `package.json` | `typescript-language-server` |
| Python | ✅ | `pyproject.toml` / `setup.py` / `requirements.txt` | `pyright` → `pylsp` |
| Go | ✅ | `go.mod` | `gopls` |
| Zig | ✅ | `build.zig` | `zls` |
| Lua | ✅ | `.luarc.json` or `.luacheckrc` | `lua-language-server` |

Tree-sitter provides: symbol outlines, symbol search.  
LSP additionally provides: diagnostics, reverse refs / impact analysis.

If no LSP markers are found, the daemon runs in **tree-sitter-only mode** (no diagnostics or impact analysis).

For any other language, tools return a descriptive error. Fall back to:
1. `ptc` with a Python uv script (PEP 723) — use language-specific AST libraries (e.g. `tree_sitter`, `libcst`)
2. `ptc` with a bash script using `find`, `grep`, `awk` — pattern-match function/class signatures

LSP servers are auto-installed to `~/.pi/cache/lsp/` on first run (`--auto-install`).

## Requirements

- Bun (used to spawn the daemon process)
- Git (for project root detection; falls back to `cwd`)
