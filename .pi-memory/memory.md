
## Prompt rewrite: MEMORY_INSTRUCTION

Decision: Commit staged change to extensions/memory-md/index.ts that rewrites the MEMORY_INSTRUCTION system prompt into a sandwich + checklist structure.

What changed:
- Added mandatory pre-reply checklist blockquote at top (primacy) requiring memory_search and write when appropriate.
- Converted Store hard-triggers into a checkbox list to make write obligations explicit.
- Appended a ⚠️ reminder blockquote at bottom (recency) to prompt final verification before replying.

Why: Improve agent compliance with the memory flush requirement so discoveries/decisions are persisted before responding.

Action taken: Created a conventional commit message and committed the staged change.
