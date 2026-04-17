# web-scout skill

Real-time web research, content extraction, and site mapping via the Tavily MCP server, accessed through `pi-mcporter`.

## When to use

- Any question requiring current data, news, or information beyond the model's training cutoff
- Deep research across multiple sources on a broad topic
- Reading the full content of a specific URL
- Discovering or ingesting documentation sites
- Verifying facts that may have changed recently

The system prompt enforces this as a **hard trigger**: any task requiring real-time web data must activate this skill.

## Tools (via mcporter)

| Tool | Best for |
|---|---|
| `tavily.tavily_search` | Specific facts, recent news, quick lookups, finding URLs |
| `tavily.tavily_research` | Broad topics, multi-source synthesis, comprehensive analysis |
| `tavily.tavily_extract` | Reading full content from specific URLs |
| `tavily.tavily_map` | Discovering pages on a site, understanding site structure |
| `tavily.tavily_crawl` | Bulk ingestion of multi-page documentation or blogs |

## Workflow strategies

**Quick fact lookup**
```
1. tavily_search   query:"..." max_results:5
2. tavily_extract  urls:[best URL from results]  format:"markdown"
```

**Deep research**
```
1. tavily_research  input:"detailed description"  model:"pro"
```

**Documentation ingestion**
```
1. tavily_map    url:"https://docs.example.com"  max_depth:2
2. tavily_crawl  url:"..."  instructions:"only API reference pages"
```

## Best practices

- Always cite source URLs in responses.
- Use `tavily_search` to find URLs, then `tavily_extract` for full content — don't guess URLs.
- Use `tavily_research model:"pro"` for open-ended questions instead of many search calls.
- Set `extract_depth:"advanced"` for protected sites, LinkedIn, or pages with embedded tables.

## Requirements

- `pi-mcporter` package installed (bundled with pi-code)
- Tavily MCP server configured in mcporter
