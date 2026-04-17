---
name: web-scout
description: Perform web research, content extraction, and site mapping using Tavily MCP tools via mcporter. Use when you need real-time data, news, documentation, or deep topic analysis from the web.
---

# Web Scout

This skill provides web research capabilities through the Tavily MCP server, accessed via the `mcporter` tool (provided by the `pi-mcporter` package).


## Shared runtime policy

Follow global runtime/tool policy in `/Users/noor/.pi/agent/AGENTS.md` for:
- MCP usage (`mcporter` tool vs `mcporter` CLI inside scripts)
- Script-first decision rules and mandatory pre-call checks
- Bash/programmatic execution discipline

This skill file intentionally focuses on domain-specific workflows below.

## How to call Tavily tools

All Tavily tools are called through the `mcporter` tool with `action: "call"` and the selector format `tavily.<tool_name>`.

### Basic pattern

```
mcporter(action: "call", selector: "tavily.<tool_name>", args: { ... })
```

### Discovery (if needed)

```
mcporter(action: "search", query: "tavily")
mcporter(action: "describe", selector: "tavily.tavily_search")
```

## Available tools

### 1. tavily_search — Quick web search

Best for: specific facts, recent news, finding URLs, quick lookups.

```
mcporter(action: "call", selector: "tavily.tavily_search", args: {
  "query": "latest developments in quantum computing 2026",
  "max_results": 5,
  "search_depth": "basic"
})
```

Key parameters:
- `query` (required): Search query string
- `max_results`: Number of results (default 5)
- `search_depth`: `"basic"` | `"advanced"` | `"fast"` | `"ultra-fast"`
- `topic`: `"general"` (default)
- `time_range`: `"day"` | `"week"` | `"month"` | `"year"`
- `include_raw_content`: Set `true` to get full page content
- `include_domains`: Array of domains to restrict to
- `exclude_domains`: Array of domains to exclude

### 2. tavily_research — Deep research

Best for: broad topics, multi-source synthesis, comprehensive analysis. Slower but higher quality.

```
mcporter(action: "call", selector: "tavily.tavily_research", args: {
  "input": "Compare the major cloud providers' AI/ML offerings in 2026",
  "model": "pro"
})
```

Key parameters:
- `input` (required): Detailed description of the research task
- `model`: `"mini"` (narrow/fast) | `"pro"` (broad/thorough) | `"auto"` (default)

### 3. tavily_extract — Extract page content

Best for: reading full articles, pulling content from specific URLs, scraping pages.

```
mcporter(action: "call", selector: "tavily.tavily_extract", args: {
  "urls": ["https://example.com/article"],
  "format": "markdown"
})
```

Key parameters:
- `urls` (required): Array of URLs to extract from
- `extract_depth`: `"basic"` | `"advanced"` (use advanced for protected sites, LinkedIn, tables)
- `format`: `"markdown"` | `"text"`
- `query`: Rerank extracted content chunks by relevance to this query

### 4. tavily_map — Map site structure

Best for: discovering pages on a domain, finding documentation sections, understanding site layout.

```
mcporter(action: "call", selector: "tavily.tavily_map", args: {
  "url": "https://docs.example.com",
  "max_depth": 2,
  "limit": 50
})
```

Key parameters:
- `url` (required): Root URL to map
- `max_depth`: How deep to crawl (default 1)
- `max_breadth`: Links per page (default 20)
- `limit`: Total links to process (default 50)
- `instructions`: Natural language filter (e.g., "only documentation pages")
- `select_paths`: Regex patterns for URL paths (e.g., `["/docs/.*"]`)

### 5. tavily_crawl — Crawl and extract multi-page

Best for: ingesting documentation sites, blog archives, multi-page content.

```
mcporter(action: "call", selector: "tavily.tavily_crawl", args: {
  "url": "https://docs.example.com/getting-started",
  "max_depth": 2,
  "limit": 20,
  "format": "markdown"
})
```

Key parameters:
- `url` (required): Root URL to begin crawl
- `max_depth`: Crawl depth (default 1)
- `max_breadth`: Links per page (default 20)
- `limit`: Max pages to process (default 50)
- `instructions`: Natural language crawler guidance
- `select_paths`: Regex for URL path filtering
- `select_domains`: Regex for domain filtering
- `format`: `"markdown"` | `"text"`

## Workflow strategies

### Quick fact lookup
1. `tavily_search` with a specific query
2. If results are snippets, use `tavily_extract` on the best URL for full content

### Deep research
1. `tavily_research` with a detailed description of the topic
2. Synthesize the response, cite sources

### Documentation ingestion
1. `tavily_map` to discover the site structure
2. Select relevant URLs from the map
3. `tavily_extract` on the selected URLs (or `tavily_crawl` for bulk)

### Site exploration
1. `tavily_map` to list pages
2. `tavily_crawl` with `instructions` to filter relevant pages
3. Summarize the extracted content

## Best practices

- **Cite sources**: Always include URLs from Tavily results when reporting findings.
- **Search first, extract second**: Use `tavily_search` to find relevant URLs, then `tavily_extract` for full content. Don't guess URLs.
- **Use research for broad topics**: `tavily_research` with `model: "pro"` gives much better results than multiple `tavily_search` calls for open-ended questions.
- **Respect rate limits**: `tavily_research` has a 20 req/min limit. Use `tavily_search` for quick lookups.
- **Use advanced extraction**: Set `extract_depth: "advanced"` for protected sites, LinkedIn, or pages with tables/embedded content.
- **Filter crawls**: Use `instructions`, `select_paths`, and `select_domains` to avoid crawling irrelevant pages.

## Output-example hardening (programmatic_tool_call + `mcporter` CLI)

Use these patterns to make Tavily workflows script-safe and parser-friendly.

### Hardening rules

- Prefer `--output json` and normalize final output into one compact JSON object.
- Build argument payloads with `jq -nc` to avoid quoting bugs.
- For fact lookup flows, do **search → extract** and explicitly carry URL state between steps.
- Fail fast when required values are missing (no results, empty URL list, extraction errors).
- Include source URLs in normalized output to preserve citation traceability.

### Script-safe example (search then extract)

```bash
set -euo pipefail

QUERY="latest developments in quantum computing 2026"

search_args=$(jq -nc --arg q "$QUERY" '{query:$q, max_results:5, search_depth:"basic"}')
search_json=$(mcporter call tavily.tavily_search --args "$search_args" --output json)

urls_json=$(printf '%s' "$search_json" | jq -c '
  .content[0].text
  | fromjson
  | (.results // [])
  | map(.url)
')

if [ "$(printf '%s' "$urls_json" | jq 'length')" -eq 0 ]; then
  echo "ERROR: tavily_search returned no URLs" >&2
  exit 1
fi

extract_args=$(jq -nc --argjson urls "$urls_json" '{urls:$urls, format:"markdown"}')
extract_json=$(mcporter call tavily.tavily_extract --args "$extract_args" --output json)

printf '%s' "$extract_json" | jq -c --arg query "$QUERY" --argjson urls "$urls_json" '{query:$query, urls:$urls, raw:.}'
```

