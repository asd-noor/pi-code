---
name: httpyac
description: Send HTTP, REST, GraphQL, gRPC, WebSocket, and MQTT requests from .http/.rest files using the httpyac CLI or Node.js API. Use when the user wants to execute .http files, manage environments, write request assertions, script dynamic values, or integrate httpyac into CI pipelines.
---

# httpYac

`httpyac` is a command-line REST client (and Node.js library) that executes `.http` / `.rest` files. Regions are separated by `###`. Variables use `@key = value` and are referenced with `{{key}}`.

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

```
httpyac send <fileName...> [options]
```

`fileName` is a path or glob pattern (quote globs to prevent shell expansion).

### Flags

| Flag | Purpose |
|---|---|
| `-a, --all` | Execute every region in the file |
| `-e, --env <env...>` | Active environment(s) |
| `--var <variables...>` | Inject variables at runtime — e.g. `foo="bar"` |
| `-n, --name <name>` | Run only the named region |
| `-l, --line <line>` | Run the region at line `n` |
| `-t, --tag <tag...>` | Filter regions by tag |
| `-o, --output <output>` | Response format: `short` `body` `headers` `response` `exchange` `none` |
| `--output-failed <output>` | Response format for failed requests only (same values) |
| `--raw` | Prevent formatting of response body |
| `--json` | Structured JSON output (CI-friendly) |
| `--junit` | JUnit XML output |
| `--bail` | Stop on first test failure |
| `--filter <filter>` | Filter output — currently accepts `only-failed` |
| `--repeat <count>` | Repeat a request N times |
| `--repeat-mode <mode>` | `sequential` or `parallel` (**default: parallel**) |
| `--parallel <count>` | Send N file-level requests in parallel |
| `--insecure` | Allow insecure SSL/TLS connections |
| `--timeout <timeout>` | Maximum time allowed for connections (ms) |
| `-i, --interactive` | After request completes, return to selection menu instead of exiting |
| `-s, --silent` | Log only request line (suppress response output) |
| `-v, --verbose` | Make output more talkative |
| `--no-color` | Disable color support |
| `--quiet` | Suppress all output |
| `-h, --help` | Display help |

### Examples

```bash
# Run all requests
httpyac send requests.http --all

# Named environment, runtime variable override
httpyac send requests.http --all --env staging --var token=override

# Single request by name or line
httpyac send requests.http --name "Get User"
httpyac send requests.http --line 12

# Full exchange output (debug)
httpyac send requests.http --all --output exchange

# CI: JSON, bail on first failure, show only failures
httpyac send tests.http --all --json --bail --filter only-failed

# Suppress response body formatting
httpyac send api.http --all --raw

# Glob + native parallelism
httpyac send "tests/**/*.http" --all --parallel 4 --env ci --json

# JUnit XML
httpyac send tests.http --all --junit > results.xml
```

## Using parallel and ptc

| Situation | Tool |
|---|---|
| Single send, no output processing | `bash` (one-shot) |
| Parse JSON output, check results, exit code | `ptc` Python script |
| Fan out multiple independent file sends | `parallel` with `bash` slots |
| Multi-step: build env, send, parse, report | `ptc` bash or Python script |

### Fan out with `parallel`

```
parallel([
  bash("httpyac send tests/auth.http  --all --json --silent --env ci"),
  bash("httpyac send tests/users.http --all --json --silent --env ci"),
  bash("httpyac send tests/admin.http --all --json --silent --env ci"),
])
```

### Parse results with `ptc`

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

## CLI — `httpyac oauth2`

```
httpyac oauth2 [options]
```

Generates an OAuth2 token using variables from the environment file and prints it to stdout.

### Flags

| Flag | Purpose |
|---|---|
| `-f, --flow <flow>` | OAuth2 flow to use (default: `client_credentials`) |
| `--prefix <prefix>` | Variable prefix used to look up credentials in env vars |
| `-e, --env <env...>` | Active environment(s) |
| `--var <variables...>` | Inject variables at runtime |
| `-o, --output <output>` | What to print: `access_token` (default), `refresh_token`, `response` |
| `-h, --help` | Display help |

### Examples

```bash
# Fetch an access token using client_credentials flow
httpyac oauth2 --env production

# Use a named variable prefix (looks for <prefix>_clientId, <prefix>_clientSecret, etc.)
httpyac oauth2 --prefix myapp --env staging

# Print the full token response
httpyac oauth2 --env production --output response

# Capture token for use in a shell script
TOKEN=$(httpyac oauth2 --env ci --var clientId=abc --var clientSecret=xyz)
curl -H "Authorization: Bearer $TOKEN" https://api.example.com/data
```

## Workflow patterns

```bash
# CI smoke test
httpyac send tests/smoke.http --all --env ci \
  --json --bail --filter only-failed --output-failed exchange

# Interactive exploration
httpyac send requests.http --interactive --env local
```

## Common errors

| Error | Fix |
|---|---|
| `Cannot find file` | Check glob path; quote patterns with `*` |
| `Environment not found` | Verify key exists in env file and `--env` matches exactly |
| `Assertion failed: status == 200` | Use `--output exchange` to inspect actual response |
| `Ref region not found` | Ensure `@name` matches `@ref` exactly and referenced region runs first |
| `SSL certificate error` | Add `--insecure` for dev only; fix cert in production |
| `Timeout` | Increase with `--timeout <ms>` or `# @timeout <ms>` per-request |


