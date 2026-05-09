# git-stage

Interactive TUI for staging and unstaging git files, accessible via the `/git-stage` command.

## Overview

`git-stage` opens a full-screen file picker showing every file in the git working tree — staged, modified, and untracked. Navigate with the keyboard, toggle staging with `space`, and commit with the git-commit subagent when ready.

A footer badge (`⊕ N staged`) tracks how many files are staged at a glance. It updates automatically after each agent turn.

## Command

```
/git-stage
```

Opens the TUI in the current git repository. Prints an error and exits if not inside a git repo or in a non-interactive mode.

## Keybindings

| Key | Action |
|---|---|
| `↑` / `k` | Move selection up |
| `↓` / `j` | Move selection down |
| `space` / `enter` | Toggle stage / unstage selected file |
| `a` | Stage all (`git add -A`) |
| `u` | Unstage all (`git restore --staged .`) |
| `x` | Remove selected file from index (`git rm --cached`) |
| `r` | Refresh file list |
| `q` / `Esc` | Close |

## File status indicators

| Display | Meaning |
|---|---|
| `[✓] ✓ path` | Fully staged |
| `[✓] ± path` | Staged but also has additional unstaged changes |
| `[ ] M path` | Modified, not staged |
| `[ ] ? path` | Untracked |

## Footer badge

The badge `⊕ N staged` appears in the status bar whenever files are staged. It refreshes:

- On session start
- After every agent turn (`agent_end`)
- When the TUI closes

## Files

| File | Description |
|---|---|
| `extensions/git-stage/index.ts` | Registers `/git-stage` command, manages footer badge |
| `extensions/git-stage/component.ts` | `GitStageComponent` TUI — rendering, keyboard input, git operations |
