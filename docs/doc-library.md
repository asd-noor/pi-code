# doc-library skill

Retrieves up-to-date library documentation and API references via the Context7 MCP server, accessed through `pi-mcporter`.

## When to use

- Looking up any library or framework API before writing code
- Confirming the latest stable version of a dependency
- Finding code examples for a specific use case
- Any time you'd otherwise guess at an API from training data

The system prompt enforces this as a **hard trigger**: any task involving third-party library APIs must activate this skill before writing code.

## Tools (via mcporter)

| Tool | Purpose |
|---|---|
| `context7.resolve-library-id` | Resolve a library name to a Context7 ID — always call first |
| `context7.query-docs` | Fetch docs and code examples for a specific library ID |

## Workflow

```
1. resolve-library-id  query:"How to use JWT auth in Express" libraryName:"express"
2. query-docs          libraryId:"/expressjs/express"  query:"JWT authentication middleware"
```

Skip step 1 if the user provides a library ID directly (format: `/org/project`).

## Library version policy

- Prefer the latest stable version unless the project explicitly pins an older one.
- If a project pins an older version, flag it to the user and ask whether to upgrade before proceeding.
- Always cite the library ID used so the user knows which docs were consulted.

## Requirements

- `pi-mcporter` package installed (bundled with pi-code)
- Context7 MCP server configured in mcporter
