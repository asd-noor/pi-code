# Comment commands

Inline review notes attached to specific hunks in a live session.

**Rule of thumb:** use `comment apply` (batch via ptc) for agent-generated notes; use `comment add` only for a single one-off note.

## hunk session comment add

```
Usage: session comment add [options] [sessionId]

attach one live inline review note

Options:
  --file <path>       diff file path as shown by Hunk
  --summary <text>    short review note
  --repo <path>       target the live session whose repo root matches this path
  --old-line <n>      1-based line number on the old side
  --new-line <n>      1-based line number on the new side
  --rationale <text>  optional longer explanation
  --author <name>     optional author label
  --focus             add the note and focus the viewport on it
  --json              emit structured JSON
  -h, --help          display help for command
```

Required: `--file`, `--summary`, and exactly one of `--old-line` or `--new-line`.

```bash
hunk session comment add --repo . \
  --file src/auth.ts --new-line 42 \
  --summary "Missing null check before .token access" \
  --rationale "token can be undefined when the session expires mid-request" \
  --author "pi"
```

## hunk session comment apply

```
Usage: session comment apply [options] [sessionId]

apply many live inline review notes from stdin JSON

Options:
  --repo <path>  target the live session whose repo root matches this path
  --stdin        read the comment batch from stdin as JSON
  --focus        apply the batch and focus the first note
  --json         emit structured JSON
  -h, --help     display help for command

Stdin JSON shape:
  {
    "comments": [
      {
        "filePath": "README.md",
        "hunk": 2,
        "summary": "Explain this hunk",
        "rationale": "Optional detail",
        "author": "Pi"
      }
    ]
  }
```

- `--stdin` is required — the batch payload is always read from stdin
- Each item requires `filePath`, `hunk` (1-based), and `summary`
- `rationale` and `author` are optional
- The full batch is validated before any mutation
- Use `--focus` to jump to the first note after applying

### ptc pattern

```python
#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
import json, subprocess

comments = [
    {"filePath": "src/auth.ts", "hunk": 1, "summary": "Missing null check",        "rationale": "token can be undefined mid-request"},
    {"filePath": "src/auth.ts", "hunk": 3, "summary": "Unreachable branch",        "rationale": "condition is always false after the guard above"},
    {"filePath": "src/db.ts",   "hunk": 2, "summary": "N+1 query in loop",         "rationale": "move the query outside and batch-fetch"},
]

subprocess.run(
    ["hunk", "session", "comment", "apply", "--repo", ".", "--stdin", "--focus"],
    input=json.dumps({"comments": comments}), text=True, check=True,
)
```

## hunk session comment list

```
Usage: session comment list [options] [sessionId]

list live inline review notes

Options:
  --repo <path>  target the live session whose repo root matches this path
  --file <path>  filter comments to one diff file
  --json         emit structured JSON
  -h, --help     display help for command
```

```bash
# All comments in the session
hunk session comment list --repo . --json

# Comments for one file only
hunk session comment list --repo . --file src/auth.ts --json
```

## hunk session comment rm

```
Usage: session comment rm [options] [sessionId] <commentId>

remove one live inline review note

Options:
  --repo <path>  target the live session whose repo root matches this path
  --json         emit structured JSON
  -h, --help     display help for command
```

```bash
hunk session comment rm --repo . <comment-id>
```

## hunk session comment clear

```
Usage: session comment clear [options] [sessionId]

clear live inline review notes

Options:
  --repo <path>  target the live session whose repo root matches this path
  --file <path>  clear only one diff file's comments
  --yes          confirm destructive live comment clearing
  --json         emit structured JSON
  -h, --help     display help for command
```

`--yes` is required (guards against accidental clears).

```bash
# Clear all comments in the session
hunk session comment clear --repo . --yes

# Clear comments for one file only
hunk session comment clear --repo . --file src/auth.ts --yes
```
