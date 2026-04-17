---
name: memory-md
description: Store, retrieve, and search persistent memory backed by plain markdown files. Use when you need to remember decisions, facts, or context across sessions — or when the user asks you to recall, save, update, or look up something from memory.
compatibility: Requires the memory-md binary in PATH and the daemon running (managed automatically by pi-code). Optionally requires uv for vector search on Apple Silicon.
allowed-tools: memory_list memory_get memory_search memory_new memory_update memory_delete memory_create_file memory_delete_file memory_validate_file
---

# memory-md skill

Use this skill when you need to store, retrieve, or search persistent memory.
Memory is organised as markdown files (topic areas) containing nested sections.

## Decision guide

| Situation | Tool |
|---|---|
| Don't know what files exist | `memory_list` |
| Don't know what sections exist in a file | `memory_list` with `file` param |
| Unsure if something exists | `memory_search` first, then `memory_get` if you find the exact path |
| Know the exact path | `memory_get` |
| Storing new information | `memory_new` (run `memory_create_file` first if needed) |
| Correcting or updating existing content | `memory_update` |
| Removing outdated information | `memory_delete` or `memory_delete_file` |
| After bulk writes or structural edits | `memory_validate_file` |
| Backing up before bulk changes | `/memory snapshot` |

## Path conventions

- File name (without `.md`) is always the first path segment: `auth.md` → paths start with `auth/`
- Heading text is slugified: lowercase, spaces → `-`, non-alphanumeric stripped
  - `"API Keys"` → `api-keys`
  - `"Token Refresh Policy"` → `token-refresh-policy`
- Heading level = path depth: 2 segments → `##`, 3 → `###`, etc.
- The `#` title heading is decorative metadata — not part of any path

## Workflow: storing new information

```
1. memory_list                              check if file exists
2. memory_create_file  name:"auth"          create file if not
3. memory_new          path:"auth/api-keys" add section
                       heading:"API Keys"
                       body:"Keys are hashed with bcrypt."
4. memory_new          path:"auth/api-keys/rotation-policy"
                       heading:"Rotation Policy"
                       body:"Keys rotate every 90 days."
5. memory_validate_file name:"auth"         verify structure
```

## Workflow: retrieving information

```
1. memory_search  query:"key rotation"   find relevant sections
2. memory_get     path:"auth/api-keys"   get exact section if path known
```

## Error reference

| Error | Action |
|---|---|
| `section already exists` | Use `memory_update` instead of `memory_new` |
| `section not found` | Use `memory_search` to find the right path |
| `file not found` | Run `memory_create_file` first |
| `parent section not found` | Create parent section before child |
| `cannot connect to daemon` | Run `/memory restart` |
