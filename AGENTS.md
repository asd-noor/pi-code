# Agent Development Guidelines

This document contains important patterns and practices to follow when building features for pi-code.

## ⚠️ CRITICAL RULE: Mandatory Code Review

**NEVER commit code without review.**

After making ANY code changes:
1. Stage all changes: `git add <files>`
2. Either:
   - Ask human: "Staged X files. Ready for review."
   - OR spawn Reviewer subagent with detailed context (see Code Review Process below)
3. Wait for approval before committing

No exceptions. Even "trivial" changes must be reviewed.

## Logging

**Always add debug logging when implementing new features or complex logic.**

### Required

- Import the logger: `import { createLogger } from "../_config/index.ts"`
- Create a logger instance: `const debug = createLogger("extension-name");`
- Add debug calls at key decision points:
  - Function entry: `debug("functionName called", ...args)`
  - Success paths: `debug("operation completed", result)`
  - Error paths: `debug("operation failed", error)`
  - State transitions: `debug("state changed from X to Y")`
  - External interactions: `debug("calling API", endpoint)`

### Example

```typescript
import { createLogger } from "../_config/index.ts";

const debug = createLogger("agenda");

async function openPreview(agendaId: number) {
  debug("openPreview called for agenda", agendaId);
  
  try {
    const agenda = await fetchAgenda(agendaId);
    if (!agenda) {
      debug("openPreview: agenda not found", agendaId);
      return;
    }
    
    debug("openPreview: fetching tasks and evaluation");
    const tasks = await getTasks(agendaId);
    
    debug("openPreview: writing preview to", tempFile);
    writeFileSync(tempFile, content);
    
    debug("openPreview: success");
  } catch (error) {
    debug("openPreview: error", error);
    throw error;
  }
}
```

### Why

- Makes debugging easier without reading code
- Helps trace execution flow in production
- Documents what the code is doing at runtime
- No performance cost (logs only when DEBUG env var is set)

## Code Style

### Extension Structure

Each extension should:
- Export a default function that takes `ExtensionAPI`
- Initialize logger at module level
- Create temp directories in `session_start` handler
- Clean up resources in `session_shutdown` handler
- Use `getExtensionTempDir()` for extension-specific temp files

### Event Patterns

When emitting events across extensions:
- Close TUIs before emitting events that open new TUIs/modals
- Use return values to signal intent (e.g., negative IDs for preview requests)
- Handle event emission in the caller, not inside TUI callbacks
- Add debug logging before and after event emission

### Error Handling

- Always log errors with `debug("operation: error", error)`
- Set user-friendly error messages in UI state
- Preserve error context for debugging
- Don't swallow errors silently

## Testing Checklist

Before committing:
- [ ] Added debug logs at key points
- [ ] Tested happy path
- [ ] Tested error conditions
- [ ] Verified no TypeScript errors
- [ ] Checked logs make sense when reading them
- [ ] Verified cleanup happens on session end

## Code Review Process

**After making any code changes (this is mandatory, not optional):**

1. **Stage all changes immediately:**
   ```bash
   git add <modified-files>
   ```

2. **Stop. Do not commit yet. Choose review path:**

   **Option A: Ask human to review**
   ```
   Staged X files with Y changes. Ready for your review.
   ```

   **Option B: Spawn reviewer subagent**
   
   Provide a clear, detailed prompt explaining:
   - What was changed and why
   - Which files were modified
   - What functionality was added/fixed/refactored
   - Any architectural decisions made
   - Edge cases to pay attention to
   
   Example:
   ```typescript
   Subagent({
     subagent_type: "Reviewer",
     description: "Review agenda preview changes",
     prompt: `Review the staged changes in extensions/agenda/.
     
     Changes made:
     - Added tmux preview integration to agenda browser
     - Browser now closes before opening preview to avoid modal conflicts
     - Return negative agenda ID to signal preview request
     - Handler in index.ts opens preview after browser closes
     - Added debug logging throughout
     
     Focus areas:
     - Event emission timing and TUI lifecycle
     - Error handling in openPreview()
     - Signal convention (negative IDs)
     - File path construction and cleanup
     
     Files modified:
     - extensions/agenda/browser.ts (+debug, preview logic)
     - extensions/agenda/index.ts (+preview handler)
     `,
     run_in_background: true,
     agenda_id: <current-agenda-id>
   })
   ```

3. **❌ STOP - Never commit without review ❌**
   
   Wait for:
   - Human approval: "Looks good, commit it"
   - OR Reviewer agent completion with no critical issues
   
   If issues found → fix them → stage → review again → repeat until approved

### Why

- Catches bugs before they reach main branch
- Validates architectural decisions
- Ensures code follows project patterns
- Documents intent for future reference
- Prevents silent regressions

---

**This is a living document. Add patterns as they emerge.**
