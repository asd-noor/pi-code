---
name: httpyac
description: Send HTTP, REST, GraphQL, gRPC, WebSocket, and MQTT requests from .http/.rest files using the httpyac CLI or Node.js API. Use when the user wants to execute .http files, manage environments, write request assertions, script dynamic values, or integrate httpyac into CI pipelines.
---

# httpYac

`httpyac` is a command-line REST client (and Node.js library) that executes `.http` / `.rest` files. Regions are separated by `###`. Variables use `@key = value` and are referenced with `{{key}}`.

## Installation

```bash
npm install -g httpyac
```

## Reference

Load the relevant reference before working with that feature area.

| Topic | Reference |
|-------|-----------|
| Request format | [references/request.md](references/request.md) |
| Metadata / annotations | [references/metadata.md](references/metadata.md) |
| Variables | [references/variables.md](references/variables.md) |
| Environments | [references/environments.md](references/environments.md) |
| Scripting | [references/scripting.md](references/scripting.md) |
| Assertions | [references/assert.md](references/assert.md) |
| Comments | [references/comment.md](references/comment.md) |
| Hooks | [references/hooks.md](references/hooks.md) |
| Response handling | [references/response.md](references/response.md) |
| Injected languages | [references/injected-languages.md](references/injected-languages.md) |

## CLI — `httpyac send`

### Common flags

| Flag | Purpose |
|---|---|
| `-a, --all` | Execute every region in the file |
| `-e, --env <env...>` | Active environment(s) from env file |
| `--var <k=v...>` | Inject variables at runtime |
| `-n, --name <name>` | Run only the named region |
| `-l, --line <n>` | Run the region at line `n` |
| `-t, --tag <tag...>` | Filter by tag |
| `-o, --output <fmt>` | Response format: `short` `body` `headers` `response` `exchange` `none` |
| `--output-failed <fmt>` | Format for failed responses only |
| `--json` | Structured JSON output (CI-friendly) |
| `--junit` | JUnit XML output |
| `--bail` | Stop on first test failure |
| `--filter only-failed` | Print only failed requests |
| `--repeat <n>` | Repeat a request N times |
| `--repeat-mode <mode>` | `sequential` or `parallel` (default) |
| `--parallel <n>` | Run N file requests in parallel |
| `--insecure` | Allow self-signed SSL certificates |
| `--timeout <ms>` | Connection timeout |
| `--interactive` | Menu-driven interactive mode |
| `-s, --silent` | Log only request lines |
| `-v, --verbose` | Verbose output |

### Usage examples

```bash
# Run all requests in a file
httpyac send requests.http --all

# Run with a named environment
httpyac send requests.http --all --env staging

# Override a variable at runtime
httpyac send requests.http --all --env production --var token=override-token

# Run only one named request
httpyac send requests.http --name "Get User"

# Run by line number
httpyac send requests.http --line 12

# Run by tag
httpyac send requests.http --tag smoke

# Show full request + response exchange
httpyac send requests.http --all --output exchange

# CI: JSON output, stop on failure, only print failures
httpyac send tests.http --all --json --bail --filter only-failed

# JUnit XML for CI
httpyac send tests.http --all --junit > results.xml

# Glob over multiple files, 4 parallel workers
httpyac send "tests/**/*.http" --all --parallel 4

# Load-test: repeat one request 10 times in parallel
httpyac send requests.http --name "Load Test" --repeat 10 --repeat-mode parallel
```

## .http file format

### Variables and regions

```http
# File-scoped variables
@baseUrl = https://api.example.com
@token   = my-secret

###
# @name GetUser
# @description Fetch user by ID
GET {{baseUrl}}/users/1
Authorization: Bearer {{token}}
Accept: application/json

###
# @name CreatePost
POST {{baseUrl}}/posts
Content-Type: application/json

{
  "title": "Hello",
  "timestamp": "{{$datetime iso8601}}"
}
```

### Built-in variable helpers

| Expression | Description |
|---|---|
| `{{$datetime iso8601}}` | Current datetime in ISO 8601 |
| `{{$timestamp}}` | Unix timestamp |
| `{{$randomInt}}` | Random integer |
| `{{$uuid}}` | Random UUID |
| `{{$env VAR}}` | OS environment variable |

### Request annotations

```http
# @name Login            — named region (required for @ref and response capture)
# @description <text>    — human description
# @tag smoke             — tag for --tag filtering
# @ref Login             — run Login first; exposes Login.body.* variables
# @import ./auth.http    — import regions from another file
# @sleep 2000            — wait 2 s before sending
# @timeout 30000         — per-request timeout (ms)
# @proxy http://proxy:8080
# @disabled              — skip this region
# @no-redirect           — prevent following redirects
# @loop for 3            — repeat 3 times ($index available)
# @loop for item of items — iterate over an array variable
# @loop while counter < 5
```

### Chained requests (response capture)

```http
###
# @name Login
POST {{baseUrl}}/auth/login
Content-Type: application/json

{ "username": "alice", "password": "secret" }

###
# @name GetProfile
# @ref Login
GET {{baseUrl}}/me
Authorization: Bearer {{Login.body.access_token}}
```

## Assertions (`??`)

Declarative assertions are written after the request body:

```http
###
# @name CheckUser
GET {{baseUrl}}/users/1

?? status == 200
?? header content-type contains application/json
?? body $.name == Alice
?? body $.age isNumber
?? body $.age >= 18
?? body $.email startsWith alice
?? body $.email matches ^alice@
?? duration < 3000
```

### Assertion predicates

| Predicate | Example |
|---|---|
| `== <value>` | `?? status == 200` |
| `!= <value>` | `?? status != 404` |
| `>= / <=` | `?? body $.count >= 1` |
| `contains <substr>` | `?? header content-type contains json` |
| `startsWith <prefix>` | `?? body $.name startsWith Al` |
| `matches <regex>` | `?? body $.email matches ^.+@` |
| `isNumber` | `?? body $.price isNumber` |
| `isString` | `?? body $.id isString` |
| `isBoolean` | `?? body $.active isBoolean` |

## Inline scripting

Scripts use `{{ ... }}` blocks and have access to `request`, `response`, and all current variables. Use `exports` to share values with later regions.

```http
###
# Pre-request: compute dynamic values
{{
  const now = new Date().toISOString();
  exports.requestTime = now;
  exports.correlationId = `req-${Math.random().toString(36).slice(2)}`;
}}

# @name DynamicRequest
POST {{baseUrl}}/events
Content-Type: application/json
X-Correlation-ID: {{correlationId}}

{ "time": "{{requestTime}}" }

# Post-response: inspect + capture
{{response
  const body = JSON.parse(response.body);
  test('status is 200', () => response.statusCode === 200);
  exports.eventId = body.id;
  console.log('created event:', body.id);
}}
```

### Script event hooks

| Hook syntax | When it runs |
|---|---|
| `{{ ... }}` | Before the request (pre-request) |
| `{{response ... }}` | After the response arrives |
| `{{after ... }}` | After all regions in the file finish |
| `{{+ ... }}` | Before **every** request in the file (global pre) |

## Environment configuration

### `http-client.env.json`

Place next to your `.http` files:

```json
{
  "$shared": {
    "apiVersion": "v2"
  },
  "$default": {
    "baseUrl": "http://localhost:3000",
    "token": "dev-token"
  },
  "staging": {
    "baseUrl": "https://staging.api.example.com",
    "token": "staging-token"
  },
  "production": {
    "baseUrl": "https://api.example.com",
    "token": "prod-token"
  }
}
```

Activate with `--env staging`. `$shared` variables are always loaded; `$default` applies when no `--env` is given.

### Variable resolution order (highest → lowest)

1. `--var` CLI flag
2. `.env` file in working directory
3. `http-client.env.json` named environment
4. `http-client.env.json` `$default`
5. `http-client.env.json` `$shared`
6. Inline `@variable = value` in the file
7. `.httpyac.js` `provideVariables` hook

## Output formats

### JSON (`--json`)

```bash
httpyac send tests.http --all --json
```

Returns a structured object with `summary` (totals) and `requests[]` (per-region results including `response`, `testResults`, `duration`).

### JUnit (`--junit`)

```bash
httpyac send tests.http --all --junit > results.xml
```

Compatible with most CI systems (GitHub Actions, Jenkins, GitLab CI).

## Plugin / hook configuration (`.httpyac.js`)

Place at the project root to intercept requests or inject variables:

```js
// .httpyac.js
module.exports.configureHooks = function (api) {
  // Add a header to every request
  api.hooks.onRequest.addHook('addCorrelation', async (request) => {
    request.headers = request.headers || {};
    request.headers['X-App-Version'] = '2.0.0';
  });

  // Provide custom variables
  api.hooks.provideVariables.addHook('custom', async (envs) => {
    return { customVar: 'hello-from-plugin' };
  });
};
```

## Node.js programmatic API

```typescript
import { send, getVariables, getEnvironments } from 'httpyac';
import { HttpFileStore } from 'httpyac/store';
import { promises as fs } from 'fs';

const store = new HttpFileStore();

// Parse a .http file
const httpFile = await store.getOrCreate(
  './requests.http',
  () => fs.readFile('./requests.http', 'utf8'),
  0,
  { workingDir: process.cwd(), config: { request: { timeout: 10000 } } }
);

// List environments
const envs = await getEnvironments({ httpFile });

// Resolve all variables for an environment
const variables = await getVariables({ httpFile, activeEnvironment: ['staging'] });

// Execute all regions
const ok = await send({
  httpFile,
  activeEnvironment: ['staging'],
  variables: { extraVar: 'runtime' },
  logResponse: async (response, region) => {
    console.log(`[${region.symbol.name}] ${response.statusCode}`);
  },
});

// Execute a single named region
const region = httpFile.findHttpRegion('GetUser');
if (region) {
  await send({ httpFile, httpRegion: region, activeEnvironment: ['production'] });
}
```

## Using parallel and ptc

Use `ptc` for any multi-step httpyac workflow. Use a raw `bash` slot (or a one-shot `bash` call) only when the command is genuinely single-step and you don't need to process the output.

### Decision guide

| Situation | Tool |
|---|---|
| Single `httpyac send` with no output processing | `bash` (one-shot) |
| Parse JSON output, check results, exit with code | `ptc` Python script |
| Fan out multiple independent file sends | `parallel` with `bash` or `ptc` slots |
| Multi-step: build env file, send, parse, report | `ptc` bash or Python script |

### Fan out independent file sends with `parallel`

Use `parallel` when the sends are independent of each other:

```
parallel([
  bash("httpyac send tests/auth.http  --all --json --silent --env ci"),
  bash("httpyac send tests/users.http --all --json --silent --env ci"),
  bash("httpyac send tests/admin.http --all --json --silent --env ci"),
])
```

Then aggregate the three JSON blobs in the same turn.

### Parse and assert results with `ptc`

Prefer `ptc` with `--json` output whenever you need to inspect, filter, or act on results:

```python
#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
import subprocess, json, sys

result = subprocess.run(
    ["httpyac", "send", "tests.http", "--all", "--json", "--silent", "--env", "ci"],
    capture_output=True, text=True,
)
data = json.loads(result.stdout)
failed = [r for r in data["requests"] if r["summary"]["failedTests"] > 0]
for r in failed:
    print(f"FAIL  {r['name']}: {r['summary']['failedTests']} assertion(s) failed")
    for t in r["testResults"]:
        if t["status"] != "SUCCESS":
            print(f"       ✗ {t['message']}")
sys.exit(1 if failed else 0)
```

### Aggregate results across multiple files with `ptc`

```python
#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
import subprocess, json, sys, glob

total = {"success": 0, "failed": 0}
for path in glob.glob("tests/**/*.http", recursive=True):
    r = subprocess.run(
        ["httpyac", "send", path, "--all", "--json", "--silent", "--env", "ci"],
        capture_output=True, text=True,
    )
    if not r.stdout.strip():
        continue
    data = json.loads(r.stdout)
    s = data["summary"]
    total["success"] += s["successRequests"]
    total["failed"]  += s["failedRequests"]
    if s["failedRequests"]:
        print(f"FAIL  {path}")
        for req in data["requests"]:
            if req["summary"]["failedTests"]:
                print(f"  {req['name']}")
                for t in req["testResults"]:
                    if t["status"] != "SUCCESS":
                        print(f"    ✗ {t['message']}")

print(f"\n{total['success']} passed, {total['failed']} failed")
sys.exit(1 if total["failed"] else 0)
```

### Multi-step: inject env file, send, report via `ptc` bash script

```bash
#!/usr/bin/env bash
set -euo pipefail

# Write a throwaway env override
cat > /tmp/ci-env.json <<EOF
{ "ci": { "baseUrl": "${BASE_URL}", "token": "${API_TOKEN}" } }
EOF

httpyac send tests/smoke.http \
  --all --env ci --json --bail \
  --filter only-failed --output-failed exchange \
  | tee /tmp/httpyac-results.json

rm /tmp/ci-env.json
```

## Workflow patterns

### CI smoke test

```bash
httpyac send tests/smoke.http --all --env ci \
  --json --bail --filter only-failed \
  --output-failed exchange
```

### Parallel file execution (httpyac-native)

```bash
httpyac send "tests/**/*.http" --all --parallel 4 --env ci --json
```

### Interactive exploration

```bash
httpyac send requests.http --interactive --env local
```

## Common errors

| Error | Fix |
|---|---|
| `Cannot find file` | Check glob path; quote patterns with `*` |
| `Environment not found` | Verify key exists in `http-client.env.json` and `--env` matches exactly |
| `Assertion failed: status == 200` | Check `--output exchange` for actual response; verify env/var |
| `Ref region not found` | Ensure `@name` matches `@ref` exactly and the referenced region runs first |
| `SSL certificate error` | Add `--insecure` or fix cert; never use `--insecure` in production |
| `Timeout` | Increase with `--timeout <ms>` or `# @timeout <ms>` annotation |
