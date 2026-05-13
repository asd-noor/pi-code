# doc-library skill

Retrieves up-to-date library documentation and API references via the built-in scout tools (`find_library_id`, `query_library_docs`).

## When to use

- Looking up any library or framework API before writing code
- Confirming the latest stable version of a dependency
- Finding code examples for a specific use case
- Any time you'd otherwise guess at an API from training data

The system prompt enforces this as a **hard trigger**: any task involving third-party library APIs must activate this skill before writing code.

## Tools

| Tool | Purpose |
|---|---|
| `find_library_id` | Resolve a library name to a Context7 ID — always call first |
| `query_library_docs` | Fetch docs and code examples for a specific library ID |

## Workflow

```
1. find_library_id   library_name:"express"  query:"How to use JWT auth in Express"
2. query_library_docs  library_id:"/expressjs/express"  query:"JWT authentication middleware"
```

Skip step 1 if the user provides a library ID directly (format: `/org/project`).

## Library version policy

- Prefer the latest stable version unless the project explicitly pins an older one.
- If a project pins an older version, flag it to the user and ask whether to upgrade before proceeding.
- Always cite the library ID used so the user knows which docs were consulted.

## Requirements

- Scout extension loaded (`extensions/scout/index.ts`)
- API key configured in `~/.pi/agent/pi-code.json` under `scout.context7ApiKey`
