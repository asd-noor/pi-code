# web-scout skill

Real-time web research, content extraction, and site mapping via the built-in scout tools (`web_search`, `web_extract`, `web_crawl`, `web_map`, `web_research`).

## When to use

- Any question requiring current data, news, or information beyond the model's training cutoff
- Deep research across multiple sources on a broad topic
- Reading the full content of a specific URL
- Discovering or ingesting documentation sites
- Verifying facts that may have changed recently

The system prompt enforces this as a **hard trigger**: any task requiring real-time web data must activate this skill.

## Tools

| Tool | Best for |
|---|---|
| `web_search` | Specific facts, recent news, quick lookups, finding URLs |
| `web_research` | Broad topics, multi-source synthesis, comprehensive analysis |
| `web_extract` | Reading full content from specific URLs |
| `web_map` | Discovering pages on a site, understanding site structure |
| `web_crawl` | Bulk ingestion of multi-page documentation or blogs |

## Workflow strategies

**Quick fact lookup**
```
1. web_search   query:"..." max_results:5
2. web_extract  urls:[best URL from results]  format:"markdown"
```

**Deep research**
```
1. web_research  topic:"detailed description"  model:"pro"
```

**Documentation ingestion**
```
1. web_map    url:"https://docs.example.com"  max_depth:2
2. web_crawl  url:"..."  instructions:"only API reference pages"
```

## Best practices

- Always cite source URLs in responses.
- Use `web_search` to find URLs, then `web_extract` for full content — don't guess URLs.
- Use `web_research model:"pro"` for open-ended questions instead of many search calls.
- Set `extract_depth:"advanced"` for protected sites, LinkedIn, or pages with embedded tables.

## Requirements

- Scout extension loaded (`extensions/scout/index.ts`)
- API keys configured in `~/.pi/agent/pi-code.json` under `scout.tavilyApiKey`
