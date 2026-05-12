# Inspect commands

Read session state. All four are independent — fan them out with `parallel` when you need more than one.

## hunk session list

```
Usage: session list [options]

list live Hunk sessions

Options:
  --json      emit structured JSON
  -h, --help  display help for command
```

**Use `--json` always** — plain-text output is for humans.

## hunk session get

```
Usage: session get [options] [sessionId]

show one live Hunk session

Options:
  --repo <path>  target the live session whose repo root matches this path
  --json         emit structured JSON
  -h, --help     display help for command
```

Shows `Path`, `Repo`, and `Source`. Use when you need to distinguish `--repo` from `--session-path` before a reload.
- `Repo` is what `--repo` matches
- `Path` is what `--session-path` matches

## hunk session context

```
Usage: session context [options] [sessionId]

show the selected file and hunk for one live Hunk session

Options:
  --repo <path>  target the live session whose repo root matches this path
  --json         emit structured JSON
  -h, --help     display help for command
```

Returns the currently focused file and hunk number. Check this before navigating to understand where the user's view is.

## hunk session review

```
Usage: session review [options] [sessionId]

export the live review model for one Hunk session

Options:
  --repo <path>    target the live session whose repo root matches this path
  --json           emit structured JSON
  --include-patch  include raw unified diff text for each file in review output
  -h, --help       display help for command
```

- Default (`--json` only): returns file list and hunk structure — use this first to understand shape
- `--include-patch`: adds raw unified diff text — opt in only for files you actually need to read
- Prefer targeted patch fetch via `parallel` + `jq` over pulling `--include-patch` for the full session
