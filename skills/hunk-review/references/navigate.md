# Navigate command

Moves the live Hunk TUI to a specific file/hunk or jumps between annotated hunks.

## hunk session navigate

```
Usage: session navigate [options] [sessionId]

move a live Hunk session to one diff hunk

Options:
  --file <path>   diff file path as shown by Hunk
  --repo <path>   target the live session whose repo root matches this path
  --hunk <n>      1-based hunk number within the file
  --old-line <n>  1-based line number on the old side
  --new-line <n>  1-based line number on the new side
  --next-comment  jump to the next annotated hunk
  --prev-comment  jump to the previous annotated hunk
  --json          emit structured JSON
  -h, --help      display help for command
```

## Rules

- Absolute navigation requires `--file` **and** exactly one of `--hunk`, `--new-line`, or `--old-line`
- Relative comment navigation (`--next-comment` / `--prev-comment`) does **not** require `--file`
- Never pass both `--next-comment` and `--prev-comment`
- All line/hunk numbers are **1-based**
- Use file paths exactly as shown by Hunk (from `review --json`), not filesystem paths

## Examples

```bash
# Jump to hunk 2 of a specific file
hunk session navigate --repo . --file src/App.tsx --hunk 2

# Jump to a specific new-side line
hunk session navigate --repo . --file src/App.tsx --new-line 372

# Jump to a specific old-side line
hunk session navigate --repo . --file src/App.tsx --old-line 355

# Jump to the next annotated hunk
hunk session navigate --repo . --next-comment

# Jump to the previous annotated hunk
hunk session navigate --repo . --prev-comment
```
