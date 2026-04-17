# parallel

Fan out multiple independent operations (read, bash, write, edit, ptc) in one tool call. All run concurrently via `Promise.all`; results are returned together.

## LLM tool

| Tool | Description |
|---|---|
| `parallel` | Execute 2+ independent operations concurrently in a single call |

### Parameters

| Parameter | Type | Description |
|---|---|---|
| `calls` | array | List of operations to execute (minimum 2). Each must specify a `tool` and its arguments. |

### Supported operations

Each item in the `calls` array is one of:

#### `read`
```typescript
{
  tool: "read",
  path: string,        // relative or absolute
  offset?: number,     // line to start from (1-indexed)
  limit?: number       // max lines to read
}
```

#### `bash`
```typescript
{
  tool: "bash",
  command: string,     // bash command
  timeout?: number,    // seconds (default: 120)
  stdin?: string       // data to pipe to stdin
}
```

#### `write`
```typescript
{
  tool: "write",
  path: string,        // creates parent dirs automatically
  content: string      // file content
}
```

#### `edit`
```typescript
{
  tool: "edit",
  path: string,
  edits: Array<{       // exact text replacements
    oldText: string,   // must be unique in file
    newText: string
  }>
}
```

#### `ptc`
```typescript
{
  tool: "ptc",
  type: "python" | "bash",
  script: string,      // full script (Python needs PEP 723 block)
  args?: string[],     // command-line arguments
  stdin?: string       // pipe to script stdin
}
```

## When to use

✅ **Use `parallel` when:**
- You have 2+ operations that are **independent** (no operation depends on another's output)
- Results don't need processing — just returned together
- Examples:
  - Read multiple files to gather context
  - Run several independent ptc analysis scripts
  - Mix reads + bash commands + ptc calls

❌ **Don't use `parallel` when:**
- Operations are sequential/dependent
- You need to process results before the next operation
- Multiple edits target the same file (use the native `edit` tool instead)

## Important constraints

### Independence requirement
Operations in a `parallel` call must be **completely independent**. You cannot:
- Use the output of one operation as input to another
- Have operations that depend on execution order

If operations are dependent, use sequential individual tool calls instead.

### Edit safety
⚠️ **Critical:** `parallel`'s `edit` operation does **not** use the native mutation queue.

**Do not** include two `edit` calls targeting the same file in one `parallel` invocation. This will cause a race condition.

For multiple edits to the same file, use the native `edit` tool with multiple entries in the `edits[]` array.

## Examples

### Example 1: Read multiple files
```typescript
parallel({
  calls: [
    { tool: "read", path: "src/auth.ts" },
    { tool: "read", path: "src/api.ts" },
    { tool: "read", path: "tests/auth.test.ts" }
  ]
})
```

### Example 2: Mix ptc + read + bash
```typescript
parallel({
  calls: [
    {
      tool: "ptc",
      type: "python",
      script: "# /// script\n# requires-python = \">=3.11\"\n# ///\nprint('Analysis 1')"
    },
    { tool: "read", path: "config.json" },
    { tool: "bash", command: "git log --oneline -5" }
  ]
})
```

### Example 3: Multiple independent writes
```typescript
parallel({
  calls: [
    { tool: "write", path: "out/report1.txt", content: "..." },
    { tool: "write", path: "out/report2.txt", content: "..." },
    { tool: "write", path: "out/summary.txt", content: "..." }
  ]
})
```

## Output format

Results are returned in order, separated by `---`:

```
[0] read
<file content>

---

[1] bash
<command output>

---

[2] ptc
<script output>
```

Errors are marked with `❌ ERROR` and include the error message.

## Tool status

- If **all** operations fail → `isError: true`
- If **some** operations fail → `isError: false`, but errors are visible in output
- Details object includes: `{ totalCalls, errors, results[] }`

## Relationship to ptc

`ptc` remains the **default for all work**. Use `parallel` only when you need to fan out multiple independent operations simultaneously.

Pattern:
1. **Single operation?** → Use `ptc`
2. **Multiple independent operations?** → Use `parallel` (can include `ptc` calls as slots)
3. **Sequential/dependent operations?** → Use `ptc` or individual tools

## Implementation details

- All operations execute via `Promise.all` — truly concurrent
- Sandbox for ptc scripts: `/tmp/pi-sandbox/`
- Python scripts run via `uv run`
- Bash scripts execute in `/bin/bash`
- File operations resolve relative to `cwd` (current working directory)
- Timeout default: 120 seconds (configurable per operation)
- Max buffer: 10 MB per operation
