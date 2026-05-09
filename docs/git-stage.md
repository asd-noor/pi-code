# git-stage

Hunk-level interactive TUI for staging and unstaging git changes, accessible via the `/git-stage` command.

## Overview

`git-stage` opens a **centred overlay popup** (95 % width, 95 % height) with a split-panel layout:

- **Left panel** (~35 %) — file list with per-file stage indicators
- **Right panel** (~65 %) — diff viewer showing the selected file's hunks

Individual hunks can be staged or unstaged independently using `git apply --cached` with a temp-file patch, matching the behaviour of `git add -p` but in a persistent, navigable UI.

A footer badge (`⊕ N staged`) tracks how many files have staged changes. It polls every 3 s so the count stays current regardless of how changes are made.

## Command

```
/git-stage
```

Opens the overlay in the current git repository root. Prints an error and exits if not inside a git repo or in a non-interactive mode.

## Layout

```
  ⎇  main  ·  2 staged / 5 total
  ↑↓/jk move  ·  Tab switch  ·  space stage hunk  ·  s stage file  ·  …
 ─────────────────────────────────────────────────────────────────────
  FILES            │  DIFF  src/foo.ts
 ─────────────────│───────────────────────────────────────────────────
   [ ] src/foo.ts  │  ▶ @@ -12,7 +12,9 @@ function init
   [✓] src/bar.ts  │    const x = 1;
   [ ] README.md   │  - const y = 2;
                   │  + const y = 3;
                   │  + const z = 4;
 ─────────────────────────────────────────────────────────────────────
```

## Keybindings

| Key | Panel | Action |
|---|---|---|
| `↑` / `k` | Files | Move file selection up |
| `↓` / `j` | Files | Move file selection down |
| `↑` / `k` | Diff | Move hunk selection up |
| `↓` / `j` | Diff | Move hunk selection down |
| `Tab` | Both | Switch focus between file list and diff viewer |
| `space` | Diff | Stage or unstage the selected hunk |
| `space` | Files | Toggle stage / unstage the entire file |
| `s` | Both | Stage all hunks in current file (`git add`) |
| `u` | Both | Unstage all hunks in current file (`git restore --staged`) |
| `a` | Both | Stage everything (`git add -A`) |
| `r` | Both | Refresh file list and diff |
| `q` / `Esc` | Both | Close |

## File status indicators (left panel)

| Display | Meaning |
|---|---|
| `[✓]` | Fully staged |
| `[±]` | Staged but also has additional unstaged changes |
| `[ ]` | Modified, not staged |
| `[?]` | Untracked |

## Diff viewer (right panel)

- `@@` hunk headers shown in accent colour with `▶` on the selected hunk
- `+` lines in success colour (green)
- `-` lines in error colour (red)
- Context lines in muted colour
- Non-selected hunks dimmed
- Scroll indicator shown when the diff exceeds the panel height

The diff shown depends on the file's state:
- File has **unstaged** changes → shows `git diff -- <file>` (for staging)
- File is **staged only** → shows `git diff --cached -- <file>` (for unstaging)

## Hunk staging mechanics

Staging a hunk writes a minimal patch to a temp file and runs:
```
git apply --cached --whitespace=nowarn /tmp/pi-git-stage-<ts>.patch
```

Unstaging reverses it:
```
git apply --cached -R --whitespace=nowarn /tmp/pi-git-stage-<ts>.patch
```

The temp file is deleted after each operation.

## Footer badge

The badge `⊕ N staged` appears in the status bar whenever files are staged. It polls every **3 seconds** and only calls `setStatus` when the value changes, avoiding flicker.

## Files

| File | Description |
|---|---|
| `extensions/git-stage/index.ts` | Registers `/git-stage` command, 3 s polling badge |
| `extensions/git-stage/component.ts` | `GitStageOverlay` — split-panel rendering, keyboard input, git operations |
| `extensions/git-stage/diff-parser.ts` | `parseDiff` and `buildHunkPatch` utilities |
| `extensions/git-stage/types.ts` | Shared types: `GitFileStatus`, `DiffHunk`, `FileDiff`, `PanelFocus` |
