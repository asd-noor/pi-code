---
name: doc-library
description: Searches for latest documentation on libraries and tools using Context7 MCP Server via mcporter. Use this skill when you need to look up API references, library docs, or code examples.
---

# Documentation Library

This skill provides documentation retrieval capabilities through the Context7 MCP server, accessed via the `mcporter` tool (provided by the `pi-mcporter` package).

## How to call Context7 tools

All Context7 tools are called through the `mcporter` tool with `action: "call"` and the selector format `context7.<tool_name>`.

### Basic pattern

```
mcporter(action: "call", selector: "context7.<tool_name>", args: { ... })
```

## Available tools

### 1. resolve-library-id — Find the library ID

**Must be called first** before querying docs, unless the user provides a library ID directly (format: `/org/project`).

```
mcporter(action: "call", selector: "context7.resolve-library-id", args: {
  "query": "How to set up authentication with JWT in Express.js",
  "libraryName": "express"
})
```

Parameters:
- `query` (required): The question or task — used to rank results by relevance
- `libraryName` (required): Library/package name to search for

Returns a list of matching libraries, each with:
- **Library ID**: Context7-compatible identifier (`/org/project`)
- **Name**: Library or package name
- **Description**: Short summary
- **Code Snippets**: Number of available code examples
- **Source Reputation**: High, Medium, Low, or Unknown
- **Benchmark Score**: Quality indicator (100 is highest)
- **Versions**: Available versions (format: `/org/project/version`)

**Selection criteria** (in priority order):
1. Exact name match
2. Description relevance to query intent
3. Higher code snippet count
4. High or Medium source reputation
5. Higher benchmark score

### 2. query-docs — Retrieve documentation

Fetches up-to-date documentation and code examples for a specific library.

```
mcporter(action: "call", selector: "context7.query-docs", args: {
  "libraryId": "/expressjs/express",
  "query": "How to set up authentication with JWT"
})
```

Parameters:
- `libraryId` (required): Exact Context7 library ID from `resolve-library-id` (e.g., `/mongodb/docs`, `/vercel/next.js`)
- `query` (required): Specific question — be detailed for better results

## Workflow

### Standard documentation lookup

1. **Resolve**: Call `resolve-library-id` with the library name and the user's question
2. **Select**: Pick the best matching library ID from the results
3. **Query**: Call `query-docs` with the selected library ID and the specific question
4. **Respond**: Synthesize the documentation into a clear answer

### Example: "How do I use Redis with Next.js?"

Step 1 — Resolve:
```
mcporter(action: "call", selector: "context7.resolve-library-id", args: {
  "query": "How to use Redis with Next.js",
  "libraryName": "upstash redis"
})
```

Step 2 — Query:
```
mcporter(action: "call", selector: "context7.query-docs", args: {
  "libraryId": "/upstash/redis",
  "query": "How to configure and use Upstash Redis in a Next.js application"
})
```

### When the user provides a library ID directly

If the user says something like "look up /vercel/next.js docs for middleware", skip `resolve-library-id` and go straight to `query-docs`.

## Best practices

- **Be specific in queries**: "How to set up JWT authentication in Express.js" is much better than "auth" or "hooks".
- **Call resolve-library-id at most 3 times** per question. If no good match after 3 attempts, use the best result.
- **Call query-docs at most 3 times** per question. Use the best information you have after that.
- **Use versioned IDs** when the user specifies a version (e.g., `/vercel/next.js/v14.3.0`).
- **Cite the library ID** in your response so the user knows which docs were consulted.
- **Do not include sensitive information** (API keys, passwords, credentials) in query parameters.

## Output-example hardening (programmatic_tool_call + `mcporter` CLI)

Use these patterns so scripted wrappers are deterministic and easy to parse.

### Hardening rules

- Prefer `mcporter call ... --args '<json>' --output json` for machine-readable output.
- Build request JSON with `jq -nc` (or Python) to avoid shell-escaping errors.
- Keep each step explicit: resolve library ID first, then query docs.
- Validate required fields before continuing (`libraryId`, non-empty result docs).
- Emit one compact JSON summary line at the end for downstream parsing.

### Script-safe example

```bash
set -euo pipefail

QUERY="How do I implement JWT auth middleware in Express?"
LIB="express"

resolve_args=$(jq -nc --arg q "$QUERY" --arg n "$LIB" '{query:$q, libraryName:$n}')
resolve_json=$(mcporter call context7.resolve-library-id --args "$resolve_args" --output json)

library_id=$(printf '%s' "$resolve_json" | jq -r '
  .content[0].text
  | fromjson
  | .libraries[0].libraryId // empty
')

if [ -z "$library_id" ]; then
  echo "ERROR: no libraryId resolved" >&2
  exit 1
fi

query_args=$(jq -nc --arg id "$library_id" --arg q "$QUERY" '{libraryId:$id, query:$q}')
query_json=$(mcporter call context7.query-docs --args "$query_args" --output json)

# final normalized output for wrappers
printf '%s' "$query_json" | jq -c --arg libraryId "$library_id" '{libraryId:$libraryId, raw:.}'
```

