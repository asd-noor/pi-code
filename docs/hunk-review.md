# hunk-review skill

Interact with live [Hunk](https://hunk.tools) diff review sessions via the `hunk session` CLI. Inspect diffs, navigate files and hunks, reload session contents, and leave inline review comments — all without touching the interactive TUI.

## When to use

- The user has a Hunk session running and wants agent-assisted code review
- Walking through a changeset and leaving contextual comments
- Navigating to a specific file, hunk, or line in a live Hunk window
- Swapping the contents of a live session (e.g. switch branch, filter paths)
- Batch-applying agent-generated review notes in one go

The system prompt enforces this as a **hard trigger**: any task involving a live Hunk session, interactive diff review, or diff navigation must activate this skill.

## Prerequisite

Hunk must already be open in the user's terminal. If no session exists, ask the user to launch it first — do **not** run `hunk diff` or `hunk show` yourself (those open a new interactive TUI).

## Key commands

| Command | Purpose |
|---|---|
| `hunk session list` | Find all live sessions |
| `hunk session get --repo .` | Inspect session path, repo root, and source |
| `hunk session review --repo . --json` | File and hunk structure (no raw diff) |
| `hunk session review --repo . --include-patch --json` | Add raw unified diff text — only when needed |
| `hunk session context --repo .` | Check current focus (file + hunk) |
| `hunk session navigate --repo . --file F --hunk N` | Jump to a specific hunk |
| `hunk session navigate --repo . --file F --new-line L` | Jump by new-side line number |
| `hunk session reload --repo . -- diff` | Swap session contents |
| `hunk session comment add --repo . --file F --new-line L --summary "..."` | Add one comment |
| `hunk session comment apply --repo . --stdin` | Batch-apply comments from stdin JSON |
| `hunk session comment list --repo .` | List all comments |

## Workflow

```
1. hunk session list                                    # find the live session
2. hunk session review --repo . --json                  # understand file/hunk structure
3. hunk session review --repo . --include-patch --json  # read raw diff only when needed
4. hunk session navigate --repo . --file F --hunk N     # steer user's view
5. hunk session comment add / comment apply             # leave review notes
```

**Prefer `comment apply` over multiple `comment add` calls** when you already have several notes ready — it validates the full batch before mutating the session.

```bash
printf '%s\n' '{"comments":[
  {"filePath":"src/auth.ts","newLine":42,"summary":"Missing null check"},
  {"filePath":"src/auth.ts","newLine":87,"summary":"Token not revoked on logout"}
]}' | hunk session comment apply --repo . --stdin --focus
```

## Session selection

Most commands accept `--repo <path>` (matches by repo root) or `<session-id>` (exact match). If only one session is running, it auto-resolves.

`reload` additionally supports:
- `--session-path <path>` — select by the live window's working directory
- `--source <path>` — run the replacement command from a different checkout (advanced)

Always include `--` before the nested Hunk command in `reload`:

```bash
hunk session reload --repo . -- diff main...feature -- src/
hunk session reload --repo . -- show HEAD~1 -- README.md
```

## Navigation reference

| Flag | Meaning |
|---|---|
| `--hunk N` | 1-based hunk index within the file |
| `--new-line L` | 1-based line number on the new (right) side |
| `--old-line L` | 1-based line number on the old (left) side |
| `--next-comment` | Jump to next annotated hunk |
| `--prev-comment` | Jump to previous annotated hunk |

Use exactly one of `--hunk`, `--new-line`, or `--old-line` per navigate call. `--next-comment` and `--prev-comment` are mutually exclusive and do not require `--file`.

## Review guidance

- Start with `review --json` to get structure without inflating context; add `--include-patch` only for files you need to read in full.
- Navigate before commenting so the user's view aligns with what you're discussing.
- Work in the order that tells the clearest story — not necessarily file order.
- Use `--focus` sparingly: only when the comment itself should actively steer the review.
- Don't comment on every hunk — highlight what the user wouldn't spot themselves.

## Common errors

| Error | Fix |
|---|---|
| `No active Hunk sessions` | Ask the user to open Hunk in their terminal |
| `Multiple active sessions match` | Pass `<session-id>` explicitly |
| `No visible diff file matches ...` | Check `context`, then `reload` if needed |
| `Pass the replacement Hunk command after --` | Include `--` before the nested `diff`/`show` |
| `Pass --stdin to read batch comments from stdin JSON` | Pipe JSON payload via stdin to `comment apply` |
| `Specify exactly one navigation target` | Use only one of `--hunk`, `--old-line`, `--new-line` |

## Requirements

- `hunk` CLI installed and in `PATH` — [hunk.tools](https://hunk.tools)
- A live Hunk session open in the user's terminal
