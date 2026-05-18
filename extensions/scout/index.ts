/**
 * Scout extension — native wrappers for Tavily CLI (tvly) and Context7 CLI (ctx7).
 *
 * API keys are read from ~/.pi/agent/pi-code.json:
 * {
 *   "scout": {
 *     "tavilyApiKey": "tvly-...",
 *     "context7ApiKey": "ctx7sk-..."
 *   }
 * }
 *
 * Tools registered:
 *   Tavily:  web_search, web_extract, web_crawl, web_map, web_research
 *   Context7: find_library_id, query_library_docs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { getExtensionTempDir } from "../_config/index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

// ── Config ────────────────────────────────────────────────────────────────────

interface ScoutConfig {
  tavilyApiKey?: string;
  context7ApiKey?: string;
}

function loadConfig(): ScoutConfig {
  try {
    const path = join(homedir(), ".pi", "agent", "pi-code.json");
    const json = JSON.parse(readFileSync(path, "utf-8"));
    return {
      tavilyApiKey: json?.scout?.tavilyApiKey,
      context7ApiKey: json?.scout?.context7ApiKey,
    };
  } catch {
    return {};
  }
}

// ── CLI runner ────────────────────────────────────────────────────────────────

interface CLIResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runCLI(
  cmd: string,
  args: string[],
  extraEnv: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CLIResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      env: { ...process.env, ...extraEnv },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Scout: ${cmd} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    const onAbort = () => {
      clearTimeout(timer);
      proc.kill("SIGTERM");
      reject(new Error("Scout: operation aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

function ok(text: string): AgentToolResult<null> {
  return { content: [{ type: "text", text: text.trim() }], details: null };
}

function fail(toolName: string, result: CLIResult): AgentToolResult<null> {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return {
    content: [{ type: "text", text: `${toolName} failed (exit ${result.code}):\n${detail}` }],
    details: null,
  };
}

function toResult(toolName: string, result: CLIResult): AgentToolResult<null> {
  return result.code === 0 ? ok(result.stdout) : fail(toolName, result);
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const cfg = loadConfig();
  const tavilyEnv: Record<string, string>  = cfg.tavilyApiKey   ? { TAVILY_API_KEY: cfg.tavilyApiKey }     : {};
  const ctx7Env: Record<string, string>    = cfg.context7ApiKey ? { CONTEXT7_API_KEY: cfg.context7ApiKey } : {};

  // ── web_search ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web for current information, news, or facts using Tavily's AI-optimized search engine. Returns URLs, titles, and snippets. Use for real-time data beyond the knowledge cutoff.",
    promptSnippet: "Search the web for real-time information on any topic",
    parameters: Type.Object({
      query: Type.String({ description: "The search query." }),
      max_results: Type.Optional(
        Type.Number({ description: "Number of results to return (1–20). Default: 5.", minimum: 1, maximum: 20 }),
      ),
      depth: Type.Optional(
        Type.Union(
          [Type.Literal("basic"), Type.Literal("advanced"), Type.Literal("fast"), Type.Literal("ultra-fast")],
          { description: "Search depth. 'basic' is default; 'advanced' is more thorough; 'fast'/'ultra-fast' prioritise latency." },
        ),
      ),
      topic: Type.Optional(
        Type.Union(
          [Type.Literal("general"), Type.Literal("news"), Type.Literal("finance")],
          { description: "Search topic category. Default: general." },
        ),
      ),
      time_range: Type.Optional(
        Type.Union(
          [Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")],
          { description: "Filter results to a relative time window." },
        ),
      ),
      include_domains: Type.Optional(
        Type.Array(Type.String(), { description: "Restrict results to these domains." }),
      ),
      exclude_domains: Type.Optional(
        Type.Array(Type.String(), { description: "Exclude results from these domains." }),
      ),
      include_answer: Type.Optional(
        Type.Union(
          [Type.Literal("basic"), Type.Literal("advanced")],
          { description: "Include an AI-generated answer alongside results." },
        ),
      ),
      include_raw_content: Type.Optional(
        Type.Union(
          [Type.Literal("markdown"), Type.Literal("text")],
          { description: "Include full page content for each result." },
        ),
      ),
    }),
    async execute(_id, params, signal) {
      const args = ["search", params.query, "--json"];
      if (params.max_results    != null) args.push("--max-results",       String(params.max_results));
      if (params.depth)                  args.push("--depth",             params.depth);
      if (params.topic)                  args.push("--topic",             params.topic);
      if (params.time_range)             args.push("--time-range",        params.time_range);
      if (params.include_domains?.length)  args.push("--include-domains", params.include_domains.join(","));
      if (params.exclude_domains?.length)  args.push("--exclude-domains", params.exclude_domains.join(","));
      if (params.include_answer)         args.push("--include-answer",    params.include_answer);
      if (params.include_raw_content)    args.push("--include-raw-content", params.include_raw_content);
      return toResult("web_search", await runCLI("tvly", args, tavilyEnv, 30_000, signal));
    },
  });

  // ── web_extract ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "web_extract",
    label: "Web Extract",
    description:
      "Extract clean, readable content from one or more URLs (up to 20). Use 'advanced' extract_depth for JavaScript-rendered pages, paywalled content, or tables. Optionally rerank chunks by relevance to a query.",
    promptSnippet: "Extract full content from one or more web page URLs",
    parameters: Type.Object({
      urls: Type.Array(Type.String(), {
        description: "One or more URLs to extract content from (up to 20).",
        minItems: 1,
        maxItems: 20,
      }),
      query: Type.Optional(
        Type.String({ description: "Rerank extracted chunks by relevance to this query." }),
      ),
      extract_depth: Type.Optional(
        Type.Union(
          [Type.Literal("basic"), Type.Literal("advanced")],
          { description: "'advanced' handles JavaScript-rendered pages and embedded content. Default: basic." },
        ),
      ),
      format: Type.Optional(
        Type.Union(
          [Type.Literal("markdown"), Type.Literal("text")],
          { description: "Output format for extracted content. Default: markdown." },
        ),
      ),
      chunks_per_source: Type.Optional(
        Type.Number({ description: "Number of content chunks per URL (1–5). Requires query.", minimum: 1, maximum: 5 }),
      ),
    }),
    async execute(_id, params, signal) {
      const args = ["extract", ...params.urls, "--json"];
      if (params.query)                  args.push("--query",             params.query);
      if (params.extract_depth)          args.push("--extract-depth",     params.extract_depth);
      if (params.format)                 args.push("--format",            params.format);
      if (params.chunks_per_source != null) args.push("--chunks-per-source", String(params.chunks_per_source));
      return toResult("web_extract", await runCLI("tvly", args, tavilyEnv, 60_000, signal));
    },
  });

  // ── web_crawl ──────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "web_crawl",
    label: "Web Crawl",
    description:
      "Crawl a website starting from a root URL and extract content from every discovered page. Control depth, breadth, page limit, and path filtering. Good for mirroring documentation sites.",
    promptSnippet: "Crawl a website and extract content from all discovered pages",
    parameters: Type.Object({
      url: Type.String({ description: "The root URL to begin crawling from." }),
      max_depth: Type.Optional(
        Type.Number({ description: "Levels deep to crawl from the root. Default: 1.", minimum: 1, maximum: 5 }),
      ),
      max_breadth: Type.Optional(
        Type.Number({ description: "Max links to follow per page. Default: 20.", minimum: 1 }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Total pages cap before stopping. Default: 50.", minimum: 1 }),
      ),
      instructions: Type.Optional(
        Type.String({ description: "Natural language guidance for the crawler (e.g., 'only follow documentation pages')." }),
      ),
      select_paths: Type.Optional(
        Type.Array(Type.String(), { description: "Regex patterns to restrict crawling to matching URL paths (e.g., '/docs/.*')." }),
      ),
      extract_depth: Type.Optional(
        Type.Union(
          [Type.Literal("basic"), Type.Literal("advanced")],
          { description: "Extraction depth for each page. 'advanced' handles JS-rendered content. Default: basic." },
        ),
      ),
      format: Type.Optional(
        Type.Union(
          [Type.Literal("markdown"), Type.Literal("text")],
          { description: "Output format. Default: markdown." },
        ),
      ),
    }),
    async execute(_id, params, signal) {
      const args = ["crawl", params.url, "--json"];
      if (params.max_depth    != null)   args.push("--max-depth",     String(params.max_depth));
      if (params.max_breadth  != null)   args.push("--max-breadth",   String(params.max_breadth));
      if (params.limit        != null)   args.push("--limit",         String(params.limit));
      if (params.instructions)           args.push("--instructions",  params.instructions);
      if (params.select_paths?.length)   args.push("--select-paths",  params.select_paths.join(","));
      if (params.extract_depth)          args.push("--extract-depth", params.extract_depth);
      if (params.format)                 args.push("--format",        params.format);
      return toResult("web_crawl", await runCLI("tvly", args, tavilyEnv, 120_000, signal));
    },
  });

  // ── web_map ────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "web_map",
    label: "Web Map",
    description:
      "Discover all URLs on a website without extracting content. Returns the URL graph of a site. Use before targeted extraction or crawling to understand site structure.",
    promptSnippet: "Map all URLs on a website without fetching page content",
    parameters: Type.Object({
      url: Type.String({ description: "The root URL to begin mapping." }),
      max_depth: Type.Optional(
        Type.Number({ description: "Levels deep to discover links. Default: 1.", minimum: 1, maximum: 5 }),
      ),
      max_breadth: Type.Optional(
        Type.Number({ description: "Max links to follow per page. Default: 20.", minimum: 1 }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Maximum total URLs to discover. Default: 50.", minimum: 1 }),
      ),
      instructions: Type.Optional(
        Type.String({ description: "Natural language guidance for URL discovery." }),
      ),
      select_paths: Type.Optional(
        Type.Array(Type.String(), { description: "Only include URLs matching these path regex patterns." }),
      ),
    }),
    async execute(_id, params, signal) {
      const args = ["map", params.url, "--json"];
      if (params.max_depth   != null)  args.push("--max-depth",    String(params.max_depth));
      if (params.max_breadth != null)  args.push("--max-breadth",  String(params.max_breadth));
      if (params.limit       != null)  args.push("--limit",        String(params.limit));
      if (params.instructions)         args.push("--instructions", params.instructions);
      if (params.select_paths?.length) args.push("--select-paths", params.select_paths.join(","));
      return toResult("web_map", await runCLI("tvly", args, tavilyEnv, 60_000, signal));
    },
  });

  // ── web_research ───────────────────────────────────────────────────────────

  pi.registerTool({
    name: "web_research",
    label: "Web Research",
    description:
      "Run deep, multi-step AI research on any topic. Tavily searches the web autonomously, synthesizes sources, and returns a comprehensive report with citations. Use for broad or complex research questions. May take several minutes.",
    promptSnippet: "Run deep AI-powered web research and get a synthesized report with citations",
    parameters: Type.Object({
      topic: Type.String({ description: "A comprehensive description of the research task or question." }),
      model: Type.Optional(
        Type.Union(
          [Type.Literal("mini"), Type.Literal("pro"), Type.Literal("auto")],
          { description: "'mini' is faster for narrow tasks; 'pro' is thorough for broad tasks; 'auto' picks the best fit. Default: auto." },
        ),
      ),
    }),
    async execute(_id, params, signal) {
      const args = ["research", params.topic, "--json"];
      if (params.model && params.model !== "auto") args.push("--model", params.model);
      // Research can take several minutes — 10 minute timeout
      return toResult("web_research", await runCLI("tvly", args, tavilyEnv, 600_000, signal));
    },
  });

  // ── find_library_id ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "find_library_id",
    label: "Find Library ID",
    description:
      "Resolve a library or package name to its Context7-compatible library ID. Always call this before query_library_docs. Returns matches ranked by name similarity, snippet coverage, and source reputation. Select the best match.",
    promptSnippet: "Resolve a library name to a Context7 library ID (required before querying docs)",
    parameters: Type.Object({
      library_name: Type.String({
        description: "The library or package name with proper capitalisation (e.g., 'react', 'Next.js', 'Three.js').",
      }),
      query: Type.String({
        description: "Describe what you're trying to accomplish — used to rank results by relevance.",
      }),
    }),
    async execute(_id, params, signal) {
      const args = ["library", params.library_name, params.query, "--json"];
      return toResult("find_library_id", await runCLI("ctx7", args, ctx7Env, 30_000, signal));
    },
  });

  // ── query_library_docs ─────────────────────────────────────────────────────

  pi.registerTool({
    name: "query_library_docs",
    label: "Query Library Docs",
    description:
      "Fetch up-to-date documentation and code examples for a library from Context7. Requires a library ID from find_library_id (format: '/org/project' or '/org/project/version'). Ask specific, descriptive questions for best results.",
    promptSnippet: "Fetch current library documentation and code examples from Context7",
    parameters: Type.Object({
      library_id: Type.String({
        description: "Context7 library ID from find_library_id (e.g., '/facebook/react', '/vercel/next.js/v14.3.0-canary.87').",
      }),
      query: Type.String({
        description: "Specific question or task — be descriptive. Good: 'How to set up JWT auth in Express.js'. Bad: 'auth'.",
      }),
    }),
    async execute(_id, params, signal) {
      const args = ["docs", params.library_id, params.query, "--json"];
      return toResult("query_library_docs", await runCLI("ctx7", args, ctx7Env, 30_000, signal));
    },
  });

  // ── System prompt instructions ────────────────────────────────────────────

  const SCOUT_INSTRUCTION = `
## Scout — web search and library docs

### Hard triggers (always use these tools directly)

- Task requires library API references, code examples, or tool docs → \`find_library_id\` then \`query_library_docs\`. **Never hallucinate APIs** — look them up.
- Task requires real-time web data, news, or facts beyond the knowledge cutoff → \`web_search\`.
- Broad or complex research requiring cross-source synthesis → \`web_research\` (takes several minutes).
- Fetching specific URLs → \`web_extract\`; mirroring a docs site → \`web_crawl\`; discovering site structure → \`web_map\`.

### Sequencing rules

- Always call \`find_library_id\` first — never pass a library name directly to \`query_library_docs\`.
- If the project already pins an older library version, flag it and ask before upgrading.
- Prefer \`web_search\` (fast) over \`web_research\` (deep); only escalate when search results are insufficient.
`.trim();

  pi.on("session_start", async (_event, ctx) => {
    getExtensionTempDir("scout", ctx.cwd);
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${SCOUT_INSTRUCTION}`,
  }));
}
