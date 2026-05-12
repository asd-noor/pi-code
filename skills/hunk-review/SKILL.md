---
name: hunk-review
description: Interacts with live Hunk diff review sessions via CLI. Inspects review focus, navigates files and hunks, reloads session contents, and adds inline review comments. Use when the user has a Hunk session running or wants to review diffs interactively.
---

# Hunk Review

`hunk` is an interactive terminal diff viewer. The TUI is for the user — **do NOT run `hunk diff`, `hunk show`, or other interactive commands directly.** Use `hunk session *` CLI commands to inspect and control live sessions through the local daemon.

If no session exists, ask the user to launch Hunk in their terminal first.

## Command groups

Load the reference for the group you need before constructing any command.

| Group | Commands | Reference |
|---|---|---|
| **Inspect** | `list`, `get`, `context`, `review` | [references/inspect.md](references/inspect.md) |
| **Navigate** | `navigate` | [references/navigate.md](references/navigate.md) |
| **Reload** | `reload` | [references/reload.md](references/reload.md) |
| **Comment** | `comment add/apply/list/rm/clear` | [references/comment.md](references/comment.md) |

## Workflow

```
1. Inspect  — parallel(list, context, review --json)   # fan out; independent calls
2. Navigate — hunk session navigate ...                 # move to the right file/hunk
3. Reload   — hunk session reload -- diff/show ...      # swap contents if needed
4. Comment  — ptc: build batch → comment apply --stdin  # all notes in one shot
```

**Use `parallel` for independent inspect calls. Use `ptc` for batch comments and multi-step sequences.**

## Session selection

Most commands accept:
- `--repo <path>` — match by repo root (most common)
- `<session-id>` — match by exact ID (multiple sessions sharing a repo)
- No selector needed when only one session exists

`reload` additionally supports `--session-path <path>` and `--source <path>` — see [references/reload.md](references/reload.md).

## Using parallel and ptc

### Parallel initial inspection

Fan out independent calls instead of running them sequentially:

```
parallel([
  bash("hunk session list --json"),
  bash("hunk session context --repo . --json"),
  bash("hunk session review --repo . --json"),
])
```

### Batch comments via ptc

Prefer one `comment apply` over many `comment add` calls:

```python
#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
import json, subprocess

comments = [
    {"filePath": "src/auth.ts",  "hunk": 1, "summary": "Missing null check before .token access"},
    {"filePath": "src/auth.ts",  "hunk": 3, "summary": "This branch is unreachable — condition is always false"},
    {"filePath": "src/db.ts",    "hunk": 2, "summary": "N+1 query — move outside the loop"},
]

subprocess.run(
    ["hunk", "session", "comment", "apply", "--repo", ".", "--stdin", "--focus"],
    input=json.dumps({"comments": comments}), text=True, check=True,
)
```

### Multi-file navigation via ptc bash script

```bash
#!/usr/bin/env bash
set -euo pipefail
for file in src/auth.ts src/db.ts src/api.ts; do
    hunk session navigate --repo . --file "$file" --hunk 1
    sleep 0.3
done
```

### Targeted patch fetch via parallel

Avoid pulling `--include-patch` for the whole session when you only need specific files:

```
parallel([
  bash("hunk session review --repo . --json --include-patch | jq '.files[] | select(.path == \"src/auth.ts\")'"),
  bash("hunk session review --repo . --json --include-patch | jq '.files[] | select(.path == \"src/db.ts\")'"),
])
```

## Guiding a review

1. Load the right content (`reload` if needed)
2. Navigate to the first interesting file/hunk
3. Build all comment notes, then apply as one `comment apply` batch
4. Summarize when done

Guidelines:
- Work in the order that tells the clearest story, not file order
- Navigate before commenting so the user sees the code being discussed
- Use `--focus` sparingly — only when the note should actively steer the view
- Keep comments focused: intent, structure, risks, follow-ups
- Don't comment on every hunk — highlight what the user wouldn't spot themselves

## Common errors

| Error | Fix |
|---|---|
| `No visible diff file matches ...` | File not in loaded review. Check `context`, then `reload` |
| `No active Hunk sessions` | Ask the user to open Hunk in their terminal |
| `Multiple active sessions match` | Pass `<session-id>` explicitly |
| `No active Hunk session matches session path ...` | Verify `Path` via `hunk session get`, then use `--session-path` |
| `Pass the replacement Hunk command after --` | Include `--` before the nested `diff`/`show` command |
| `Pass --stdin to read batch comments from stdin JSON` | `comment apply` reads payload from stdin only |
| `Specify exactly one navigation target` | Pick one of `--hunk`, `--old-line`, or `--new-line` |
| `Specify either --next-comment or --prev-comment, not both` | Choose one direction |
