# Scripting

NodeJS scripts run inside `{{ }}` blocks. Scripts before the request line are pre-request; scripts after are post-response. All exports become variables.

> **Important:** The newline after `{{` is mandatory — without it, it is treated as variable substitution, not a script.

## Script placement

```http
{{
  // pre-request script
  exports.correlationId = `req-${Math.random().toString(36).slice(2)}`;
}}

POST https://httpbin.org/events
X-Correlation-ID: {{correlationId}}

{{
  // post-response script (access `response`)
  const body = JSON.parse(response.body);
  exports.eventId = body.id;
}}
```

## Event hooks

| Syntax | Trigger |
|--------|--------|
| `{{ ... }}` | Pre-request (before sending) |
| `{{response ... }}` or `{{@response ... }}` | After response received |
| `{{@streaming ... }}` | During client streaming |
| `{{after ... }}` | After all requests in file finish |
| `{{+ ... }}` | Before **every** request in the file (global pre) |
| `{{+response ... }}` | After **every** response in the file |
| `{{+after ... }}` | After **every** request finishes |

## Global scripts

Scripts in a region with no request are global — executed before/after every request:

```http
{{
  console.info('on every run');
}}

###
GET https://httpbin.org/json
GET https://httpbin.org/json
```

## Available global variables in scripts

| Variable | Description | Condition |
|----------|-------------|-----------|
| `$global` | Persistent cross-file global store | always |
| `$requestClient` | Stream client for sending additional body | streaming |
| `httpFile` | Current `HttpFile` instance | always |
| `httpRegion` | Current `HttpRegion` instance | always |
| `oauth2Session` | OAuth2 token response | only with OAuth2 |
| `request` | Outgoing request object (pre-request) | always |
| `response` | Response of last executed request | post-response only |
| `sleep` | `sleep(ms) => Promise` — wait helper | always |
| `test` | Test helper function | always |
| `__dirname` | Current working directory path | always |
| `__filename` | Current file path | always |

## Async/await

Export the Promise so httpyac waits for it:

```http
{{
  async function wait() {
    await sleep(2000);
    return new Date().getTime();
  }
  exports.wait = wait();
}}
GET https://httpbin.org/anything?delay={{wait}}
```

## Require

```http
{{
  const { authenticate } = require('./auth.cjs');
  exports.authentication = authenticate(new Date(), request);
}}
```

Built-in dependencies (no install needed): `@cloudamqp/amqp-client`, `@xmldom/xmldom`, `dayjs`, `eventsource`, `got`, `@grpc/grpc-js`, `httpyac`, `mqtt`, `uuid`, `ws`, `xpath`, Node.js built-ins.

## Test helper

```http
{{
  test('status is 200', () => response.statusCode === 200);
  test.status(200);
  test.totalTime(300);
  test.header('content-type', 'application/json');
  test.headerContains('content-type', 'json');
  test.hasResponseBody();
}}
```

## Cancel current region from script

```http
{{
  exports.$cancel = true;  // stop executing this region
}}
GET https://httpbin.org/json
```

## Intellij script support

```http
POST https://httpbin.org/anything
Content-Type: application/x-www-form-urlencoded

email=user@domain.loc&password=2

> {% client.global.set("email", response.body.form.email); %}
```

Or as external file: `> ./script.js`

## Debugging

1. `npm install -g httpyac`
2. Add `debugger;` in the script
3. Open JavaScript Debug Terminal in VSCode
4. Run `httpyac send file.http -l <line>`
