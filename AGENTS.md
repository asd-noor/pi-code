# Agent Development Guidelines

This document contains important patterns and practices to follow when building features for pi-code.

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

---

**This is a living document. Add patterns as they emerge.**
