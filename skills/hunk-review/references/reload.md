# Reload command

Swaps the live session's diff contents without opening a new Hunk window.

## hunk session reload

```
Usage: session reload [options] [sessionId]

replace the contents of one live Hunk session

Options:
  --repo <path>          target the live session whose repo root matches this path
  --session-path <path>  target a live session rooted at a different path
  --source <path>        load the diff from this directory instead of the session's own
  --json                 emit structured JSON
  -h, --help             display help for command

Examples:
  hunk session reload --repo . -- diff
  hunk session reload --repo . -- diff main...feature -- src/ui
  hunk session reload --repo . -- show HEAD~1 -- README.md
  hunk session reload --session-path /path/to/session --source /path/to/repo -- diff
```

## Rules

- Always include `--` before the nested Hunk command (`diff` or `show`)
- `--repo` or `<session-id>` selects which live session to target
- `--session-path` selects by the live window's working directory (use when `--repo` doesn't match)
- `--source` changes where the replacement command runs — it does **not** select the session; use it only when the checkout you want to load differs from the live session's directory

## When to use which selector

| Situation | Use |
|---|---|
| Normal case — session already shows the repo you want | `--repo <path>` |
| Multiple sessions, need exact match | `<session-id>` |
| Need to keep session selection separate from reload source | `--session-path` + `--source` |

## Examples

```bash
# Reload working tree diff
hunk session reload --repo . -- diff

# Reload a branch comparison, scoped to a subdirectory
hunk session reload --repo . -- diff main...feature -- src/ui

# Reload a specific commit
hunk session reload --repo . -- show HEAD~1

# Reload a commit scoped to one file
hunk session reload --repo . -- show HEAD~1 -- README.md

# Reload staged changes only
hunk session reload --repo . -- diff --staged

# Exclude untracked files
hunk session reload --repo . -- diff --exclude-untracked

# Advanced: live window at one path, load diff from another checkout
hunk session reload --session-path /path/to/session --source /path/to/repo -- diff
```
