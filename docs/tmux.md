# Tmux Extension

Pi extension that manages a dedicated tmux session per project, exposing tools for running commands, streaming output, and viewing panes in a focus modal inside pi.

## How it works

On first use, the extension creates a detached tmux session named `pi-tmux-<projectHash>`. The hash is derived from the project root, so the session name is stable and project-scoped — the same project always gets the same session. The session is automatically killed when pi shuts down.

Pi does **not** need to be running inside tmux. The extension manages its own tmux server and session independently.

To interact with the full session (multiple panes, windows, tmux keybindings), attach externally:

```sh
tmux attach -t pi-tmux-<hash>
```

## Commands

### `/tmux:preview <file>`

Opens `tail -f <file>` in a new tmux window named after the file, then opens the focus modal to watch it live.

```
/tmux:preview /tmp/pi-subagents/abc123
/tmux:preview /var/log/server.log
```

### `/tmux:focus [window]`

Opens the focus modal for the named window. If no window is given, uses the most recently focused one.

```
/tmux:focus
/tmux:focus main
/tmux:focus server
```

## Shortcut

| Key | Action |
|-----|--------|
| `ctrl+shift+f` | Toggle focus modal |

## Focus Modal

A full-screen overlay rendered inside pi. Output streams via `tmux pipe-pane` — no polling. All keypresses are forwarded directly to the tmux pane. The title bar shows the session and window name.

Press `ctrl+shift+f` again to close the modal.

Users can scroll through output with the scroll wheel. To interact with multi-pane windows or navigate between windows with tmux keybindings, attach to the session externally.

## Tools

### `tmux_run`

Runs a shell command in a named window of the managed session. Creates the window if it doesn't exist. Wraps the command in `bash -lc` and tracks the exit status.

```ts
tmux_run({ command: "npm run dev", window: "server" })
```

Returns immediately by default. Pass `wait_for` to block until output matches a regex or the timeout expires:

```ts
tmux_run({
  command: "npm run dev",
  window: "server",
  wait_for: { regex: "Local:|ready", timeout_ms: 60000 }
})
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `command` | string | Shell command to run |
| `window` | string? | Window name. Defaults to `"main"` |
| `cwd` | string? | Working directory. Defaults to pi cwd |
| `wait_for.regex` | string | JavaScript regex matched against pane output |
| `wait_for.timeout_ms` | number? | Timeout in ms. Default: 30000 |
| `wait_for.poll_ms` | number? | Poll interval in ms. Default: 500 |

---

### `tmux_send_keys`

Sends raw keystrokes to a window. Use for special keys, interrupts, navigation.

```ts
tmux_send_keys({ keys: "C-c", window: "server" })
tmux_send_keys({ keys: "q" })
tmux_send_keys({ keys: "Enter" })
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `keys` | string | Keys to send (tmux key format: `C-c`, `Enter`, `Escape`, `q`, etc.) |
| `window` | string? | Window name. Defaults to first window |

---

### `tmux_capture`

Captures the current visible output of a window.

```ts
tmux_capture({ window: "server", tail_lines: 50 })
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `window` | string? | Window name. Defaults to first window |
| `tail_lines` | number? | Return only the last N lines. Defaults to all |

---

### `tmux_watch`

Starts an async pattern watcher on a window using `pipe-pane`. When the regex matches, triggers a follow-up agent turn with `pi.sendMessage`. Returns a watcher ID immediately.

```ts
const { watchId } = await tmux_watch({
  regex: "Error|FAILED|error",
  window: "server",
  timeout_ms: 300000
})
```

Multiple watchers can run concurrently on the same or different windows.

| Parameter | Type | Description |
|-----------|------|-------------|
| `regex` | string | JavaScript regex matched against streaming pane output |
| `window` | string? | Window to watch. Defaults to first window |
| `timeout_ms` | number? | Auto-cancel after N ms |

---

### `tmux_unwatch`

Cancels a watcher by ID.

```ts
tmux_unwatch({ watch_id: "w1" })
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `watch_id` | string | Watcher ID returned by `tmux_watch` |

## Common patterns

### Run a dev server and watch for errors

```ts
// Start the server
tmux_run({ command: "npm run dev", window: "server" })

// Watch for errors in the background
tmux_watch({ regex: "Error|FAILED", window: "server", timeout_ms: 3600000 })

// Agent gets a follow-up turn if anything goes wrong
```

### Wait for a server to be ready before continuing

```ts
tmux_run({
  command: "docker compose up",
  window: "db",
  wait_for: { regex: "database system is ready", timeout_ms: 60000 }
})
// Continues here only after the DB is ready
```

### Run tests and capture results

```ts
tmux_run({ command: "npm test", window: "test", wait_for: { regex: "passed|failed|Tests:" } })
tmux_capture({ window: "test", tail_lines: 30 })
```

### Preview a subagent session log

```
/tmux:preview /tmp/pi-subagents/<agent-id>
```

## Requirements

- `tmux` must be on `$PATH`
- macOS or Linux
