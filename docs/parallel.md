# parallel

Fan out multiple independent operations in one tool call. All slots run concurrently via `Promise.all`; results are returned together.

## LLM tool

| Tool | Description |
|---|---|
| `parallel` | Execute 2+ independent operations concurrently in a single call |

### Parameters

| Parameter | Type | Description |
|---|---|---|
| `calls` | array | List of operations to execute (minimum 2). Each must specify a `tool` and its arguments. |

### Supported slots

#### Native

```typescript
{ tool: "read",  path: string, offset?: number, limit?: number }
{ tool: "bash",  command: string, timeout?: number, stdin?: string }
{ tool: "write", path: string, content: string }
{ tool: "edit",  path: string, edits: Array<{ oldText: string, newText: string }> }
```

#### `ptc`

```typescript
{
  tool: "ptc",
  purpose: string,          // one-line description shown in UI
  type: "python" | "bash",
  script: string,           // full script (Python needs PEP 723 block + uv shebang)
  args?: string[],
  stdin?: string
}
```

#### Code intelligence

```typescript
{ tool: "code_map_outline",     file: string, language: string }
{ tool: "code_map_symbol",      name: string, language: string, source?: boolean }
{ tool: "code_map_diagnostics", language: string, file?: string, severity?: number }
{ tool: "code_map_impact",      name: string, language: string }
```

#### Memory (read-only / safe for parallel)

```typescript
{ tool: "memory_list",          file?: string }
{ tool: "memory_get",           path: string }
{ tool: "memory_search",        query: string, top?: number }
{ tool: "memory_create_file",   name: string, title: string, description?: string }
{ tool: "memory_delete_file",   name: string }
{ tool: "memory_validate_file", name: string }
```

> ⚠️ `memory_new`, `memory_update`, and `memory_delete` are **not allowed** in `parallel` — concurrent writes corrupt markdown-backed memory files. Call them sequentially via the native tools.

#### Agenda

```typescript
{ tool: "agenda_create", title: string, description: string, acceptanceGuard: string, tasks?: string[], discoveries?: any[] }
{ tool: "agenda_discovery_add",    agendaId: number, category: string, title: string, detail?: string, outcome?: string, source?: string }
{ tool: "agenda_discovery_get",    agendaId: number, discoveryId: number }
{ tool: "agenda_discovery_list",   agendaId: number, category?: string }
{ tool: "agenda_discovery_delete", agendaId: number, discoveryId: number }
```

SQLite WAL mode safely serialises concurrent writes for all agenda slots.

#### File search — `ffgrep` / `fffind` (requires finder extension)

```typescript
{
  tool: "ffgrep",
  pattern: string,
  path?: string,           // repo-relative path constraint or glob
  exclude?: string | string[],
  caseSensitive?: boolean,
  context?: number,        // lines before+after each match
  limit?: number,
  cursor?: string          // pagination
}

{
  tool: "fffind",
  pattern: string,
  path?: string,
  exclude?: string | string[],
  limit?: number,
  cursor?: string
}
```

#### Scout / web (requires scout extension)

```typescript
{ tool: "web_search",   query: string, max_results?: number, depth?: string, topic?: string, time_range?: string, include_domains?: string[], exclude_domains?: string[], include_answer?: string, include_raw_content?: string }
{ tool: "web_extract",  urls: string[], query?: string, extract_depth?: string, format?: string, chunks_per_source?: number }
{ tool: "web_crawl",    url: string, max_depth?: number, max_breadth?: number, limit?: number, instructions?: string, select_paths?: string[], extract_depth?: string, format?: string }
{ tool: "web_map",      url: string, max_depth?: number, max_breadth?: number, limit?: number, instructions?: string, select_paths?: string[] }
{ tool: "web_research", topic: string, model?: "mini" | "pro" | "auto" }
{ tool: "find_library_id",    library_name: string, query: string }
{ tool: "query_library_docs", library_id: string, query: string }
```

## When to use

✅ **Use `parallel` when:**
- You have 2+ operations that are **independent** (no operation depends on another's output)
- Reading multiple files, running multiple searches, fanning out analysis scripts
- Mixing reads + bash + ptc + search calls

❌ **Don't use `parallel` when:**
- Operations are sequential/dependent
- Multiple edits target the **same file** (use the native `edit` tool with multiple `edits[]` entries)

## Edit safety

`parallel`'s `edit` slot does **not** use the native mutation queue. Never include two `edit` calls targeting the same file in one `parallel` call — use the native `edit` tool instead.

## Examples

### Read multiple files concurrently
```typescript
parallel({ calls: [
  { tool: "read", path: "src/auth.ts" },
  { tool: "read", path: "src/api.ts" },
  { tool: "bash", command: "git log --oneline -5" }
]})
```

### Fan out search + analysis
```typescript
parallel({ calls: [
  { tool: "ffgrep",  pattern: "FileFinder", path: "extensions/" },
  { tool: "fffind",  pattern: "finder index" },
  { tool: "memory_search", query: "fff extension FileFinder" }
]})
```

### Web research + library docs in one shot
```typescript
parallel({ calls: [
  { tool: "web_search", query: "vite 6 breaking changes" },
  { tool: "find_library_id", library_name: "vite", query: "migration guide" }
]})
```

### Multiple independent ptc scripts
```typescript
parallel({ calls: [
  { tool: "ptc", purpose: "analyse auth.ts", type: "python", script: "..." },
  { tool: "ptc", purpose: "analyse db.ts",   type: "python", script: "..." }
]})
```

## Output format

Results are returned in order, separated by `---`:
```
[0] read
<file content>
---
[1] bash ❌ ERROR
<error message>
---
[2] ptc
<script output>
```

- All fail → `isError: true`
- Some fail → `isError: false`, errors visible in output
- Details: `{ totalCalls, errors, results[] }`

## Implementation

- All slots run via `Promise.all` — truly concurrent
- Extension tool logic is **inlined directly** into `parallel.ts` — no dynamic dispatch
- ptc sandbox: `/tmp/pi-sandbox/`
- Timeout default: 120 s (ptc), varies per scout tool (web_research: 600 s)
- Max buffer: 10 MB per slot
