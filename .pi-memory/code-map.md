
## Tree-sitter Integration (Phase 1)

Tree-sitter is now the **primary symbol indexer** (Phase 1). LSP is retained exclusively for **relations** (diagnostics, reverse refs / impact analysis).

**Startup sequence:**
1. Install tree-sitter grammars to `~/.pi/cache/code-map/tree-sitter/` (on-demand, mirrors LSP installer pattern)
2. Load grammars via `createRequire` with absolute path — no bundled deps
3. Parse all files synchronously with tree-sitter → graph ready → write `"ready"` status
4. Background: init LSP → open files → snapshot diagnostics → buildReverseRefs

**Key invariant:** `"ready"` is written *before* LSP init completes. LSP failure after ready is non-fatal.

**Incremental reindex (file change):**
- Tree-sitter re-parse instantly (sync) → graph updated
- LSP notified async (`_lspReindexBackground`) → diagnostics update in background
- `waitForQuietDiagnostics` removed from the symbol update hot path

**Fallbacks:**
- tree-sitter install fails → LSP-only mode (old behaviour)
- grammar unavailable for a file type → falls back to LSP `documentSymbol` per file
- LSP missing but tree-sitter loaded → tree-sitter-only mode (no diagnostics/impact)

**`lspReady` guard:** `DaemonServer.lspReady` starts `false`; set `true` by runner when LSP background init completes. `handleImpact` returns a friendly message if called before LSP is ready.
## Status: complete (agenda #25)

### New files
- `extensions/code-map/tree-sitter/installer.ts` — npm-installs tree-sitter + 6 grammars to `~/.pi/cache/code-map/tree-sitter/`
- `extensions/code-map/tree-sitter/loader.ts` — `loadGrammars(tsDir)` via `createRequire`, returns `LoadedGrammars`
- `extensions/code-map/tree-sitter/queries.ts` — S-expression queries per language; captures `@name` + `@def_KIND`
- `extensions/code-map/tree-sitter/parser.ts` — `TreeSitterParser.parseFile()` → `GraphNode[]` (sync)
- `extensions/code-map/tree-sitter/index.ts` — re-exports

- `extensions/code-map/tree-sitter/installer.ts` — installs `tree-sitter` + 6 grammars to cache dir via npm/bun
- `extensions/code-map/tree-sitter/loader.ts` — `loadGrammars(tsDir)` via absolute-path `createRequire`; handles `tree-sitter-typescript`'s `{ typescript, tsx }` export shape
- `extensions/code-map/tree-sitter/queries.ts` — S-expression queries per language; capture convention `@name` + `@def_KIND`
- `extensions/code-map/tree-sitter/parser.ts` — `TreeSitterParser.parseFile(absPath, relPath): GraphNode[]`; kind from capture name suffix; deduplication by `lineStart:name`
- `extensions/code-map/tree-sitter/index.ts` — public re-exports
### Modified files
- `paths.ts` — added `getTreeSitterDir()` → `~/.pi/cache/code-map/tree-sitter/`
- `daemon/indexer.ts` — `buildNodes(files, tsParser?)` uses tree-sitter first, LSP fallback per file; no sleep(); `reindexFile` is instant with tree-sitter, LSP updates in `_lspReindexBackground` (fire-and-forget)
- `daemon/runner.ts` — new startup: tree-sitter parse → ready written → LSP init in background void IIFE
- `daemon/server.ts` — `lspReady: boolean` property; `handleImpact` guards on `!lspReady`

- `paths.ts` — added `getTreeSitterDir()` → `~/.pi/cache/code-map/tree-sitter/`
- `daemon/indexer.ts` — `buildNodes(files, tsParser?)` uses tree-sitter fast path; LSP fallback per file; `reindexFile()` tree-sitter instant + `_lspReindexBackground()` async; no `waitForQuietDiagnostics` in symbol hot path
- `daemon/runner.ts` — new 6-step startup; tree-sitter → ready; LSP in `void (async()=>{})()` background block
- `daemon/server.ts` — `lspReady: boolean` public field; `handleImpact` returns friendly error when `!lspReady`
### Key design decisions
- Capture names `@def_KIND` encode the kind directly (no kindMap lookup needed)
- 6 grammars: typescript, javascript (covers jsx/mjs/cjs), python, go, rust, lua
- tsx shares tree-sitter-typescript grammar via `{ typescript, tsx }` export
- Daemon reaches "ready" before LSP initializes — tree-sitter index is immediately available
- LSP failure after ready is non-fatal; tree-sitter index remains available
- **Native bindings** (not WASM): prebuilt `.node` files from npm packages; loaded via `createRequire`
- **6 grammars**: typescript, javascript, python, go, rust, lua (mirrors `lsp/registry.ts`)
- **Install pattern**: mirrors `lsp/installer.ts` exactly; same `--auto-install` flag triggers both LSP + tree-sitter install
- **Source text**: on-demand (not cached on `GraphNode`)
- **Polyglot**: tree-sitter parses all 6 language types regardless of which LSP is active
- **No `package.json` changes**: all deps installed at runtime to cache dir
