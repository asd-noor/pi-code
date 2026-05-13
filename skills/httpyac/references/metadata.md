# Metadata / annotations

All lines starting with `#` (or `//`) are comments. Lines in the form `# @foo bar` are metadata annotations that influence request processing.

## Quick reference

| Annotation | Effect |
|-----------|--------|
| `# @name <id>` | Names the region; response auto-captured as variable `<id>` |
| `# @title <text>` | Display title in CLI output / outline view |
| `# @description <text>` | Description shown in CLI output / outline view |
| `# @ref <name>` | Run named region first (uses cache if available) |
| `# @forceRef <name>` | Always re-run the referenced region |
| `# @import <file>` | Import regions/variables from another `.http` file |
| `# @disabled` | Skip this region (accepts JS expression: `# @disabled !flag`) |
| `# @jwt <prop>` | Auto-decode JWT in response property; adds `${prop}_parsed` |
| `# @injectVariables` | Inject variables into request body (Intellij compat) |
| `# @note <text>` | Show confirmation dialog before sending |
| `# @loop for <n>` | Repeat N times; `$index` injected |
| `# @loop for <var> of <arr>` | Iterate over array variable; `$index` + `<var>` injected |
| `# @loop while <expr>` | Repeat while expression is truthy |
| `# @grpc-reflection` | Enable gRPC reflection lookup |
| `# @save` | Save response to file instead of displaying |
| `# @openWith <viewType>` | Preview response in custom VSCode editor |
| `# @extension <ext>` | Override file extension for save/openWith |
| `# @ratelimit ...` | Throttle requests (see below) |
| `# @sleep <ms>` | Wait N milliseconds before sending |
| `# @timeout <ms>` | Per-request timeout |
| `# @no-log` | Suppress request logging |
| `# @no-response-view` | Prevent opening response in VSCode editor |
| `# @noStreamingLog` | Suppress intermediate streaming logs |
| `# @no-cookie-jar` | Disable cookie jar for this request |
| `# @no-client-cert` | Skip SSL client certificate |
| `# @no-redirect` | Prevent following redirects |
| `# @no-reject-unauthorized` | Ignore invalid SSL certificates |
| `# @proxy <url>` | Set proxy for this request |
| `# @no-proxy` | Ignore system proxy setting |
| `# @debug` | Enable debug log level |
| `# @verbose` | Enable trace log level |
| `# @keepStreaming` | Keep MQTT / SSE / WebSocket open until manually stopped |

## Name and response capture

```http
# @name Login
POST https://api.example.com/auth/login
Content-Type: application/json

{ "username": "alice", "password": "secret" }

###
# @ref Login
GET https://api.example.com/me
Authorization: Bearer {{Login.body.access_token}}
```

> `@name` must be a valid JavaScript identifier. Names are globally unique across all imported files.

## Loop

```http
# @loop for 4
GET https://httpbin.org/anything?item={{$index}}

###
{{ exports.data = [1, 2, 3]; }}
# @loop for item of data
GET https://httpbin.org/anything?item={{item}}

###
# @loop while expression.index < 3
GET /anything?item={{expression.index++}}
```

Loop + name: index is appended (`foo0`, `foo1`, ...) so later `@ref foo` resolves to `foo0`.

## Rate limiting

```http
# minIdleTime between requests (ms)
# @ratelimit minIdleTime 10000

# max N requests per expire window (ms)
# @ratelimit max 10 expire: 60000

# named slot (shared across regions with same slot name)
# @ratelimit slot bar minIdleTime 10000

# combined
# @ratelimit minIdleTime 10000 max 10 expire: 60000
```

## Disabling dynamically

```http
@callRequest={{false}}

# @disabled !callRequest
GET https://httpbin.org/json
```

Or from a script: `httpRegion.metaData.disabled = true`.
