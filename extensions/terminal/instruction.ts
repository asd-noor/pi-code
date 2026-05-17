/**
 * System instruction injected into the agent prompt.
 */

export const TERMINAL_INSTRUCTION = `
## Terminal (tmux) Tools

The terminal extension manages a dedicated tmux session (\`pi-tmux-<hash>\`) for long-running processes, background jobs, and async monitoring.

### When to use
- **\`tmux_run\`** — start long-running or interactive processes (dev servers, builds, watchers). Prefer over \`bash\` for anything that runs for more than a few seconds.
- **\`tmux_list\`** — discover which windows are currently open in the managed session (name + running command). Call this at the start of a session if you need to reattach to a previously started process.
- **\`tmux_capture\`** — read current output from a running window after \`tmux_run\`. Use instead of polling bash.
- **\`tmux_send_keys\`** — send keystrokes to a running process (e.g. \`C-c\` to interrupt, \`q\` to quit, \`Enter\` to confirm a prompt).
- **\`tmux_watch\`** — register an async regex watcher; get a follow-up turn triggered when output matches. Use for "wait until ready" patterns (server started, tests passed, build succeeded).
- **\`tmux_unwatch\`** — cancel a watcher when no longer needed.

### Patterns

**Discover open windows at the start of a session:**
\`\`\`
tmux_list()  // returns window names and their running commands
\`\`\`

**Start a process and wait for it to be ready:**
\`\`\`
tmux_run({ command: "npm run dev", window: "server", wait_for: { regex: "Local:|ready", timeout_ms: 60000 } })
\`\`\`

**Start a process and monitor it in the background:**
\`\`\`
tmux_run({ command: "npm test -- --watch", window: "tests" })
tmux_watch({ regex: "FAIL|ERROR", window: "tests" })  // get notified on failure
\`\`\`

**Read output from a running process:**
\`\`\`
tmux_capture({ window: "server", tail_lines: 30 })
\`\`\`

**Interrupt a stuck process:**
\`\`\`
tmux_send_keys({ keys: "C-c", window: "server" })
\`\`\`

### Guidelines
- Call \`tmux_list\` before \`tmux_capture\` or \`tmux_send_keys\` when you don't know which windows exist.
- Each window is independent — use descriptive names (e.g. \`server\`, \`tests\`, \`build\`).
- Windows persist until the process exits or pi shuts down.
- Prefer \`tmux_run\` + \`tmux_watch\` over repeated polling with \`bash\`.
`.trim();
