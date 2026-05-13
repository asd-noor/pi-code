# Response handling

## Response documentation

Responses can be embedded in `.http` files for documentation purposes. A line starting with `HTTP/<version>` triggers response parsing:

```http
GET https://httpbin.org/get

HTTP/1.1 200 - OK
date: Mon, 21 Jun 2021 19:38:05 GMT
content-type: application/json
content-length: 295

{
  "args": {},
  "origin": "79.243.57.74",
  "url": "https://httpbin.org/get"
}
```

> The embedded response is not executed. It is used to pre-populate the display in httpBook.

## Output redirection

Redirect the response body to a file:

| Operator | Behaviour |
|----------|-----------|
| `>> <file>` | Always creates a new file; appends `-n` suffix if file exists |
| `>>! <file>` | Overwrites the file if it already exists |

```http
GET https://httpbin.org/anything

>> ./output.json

###
GET https://httpbin.org/anything

>>! ./output.json
```

## Accessing response in scripts

The `response` object is available in post-response scripts:

```http
GET https://httpbin.org/json

{{
  console.log(response.statusCode);         // 200
  console.log(response.headers['content-type']);
  const body = JSON.parse(response.body);
  exports.slideshowTitle = body.slideshow.title;
}}
```

Key response properties:

| Property | Type | Description |
|----------|------|-------------|
| `statusCode` | number | HTTP status code |
| `headers` | object | Response headers (lowercase keys) |
| `body` | string | Raw response body |
| `parsedBody` | any | Auto-parsed JSON body |
| `timings` | object | Timing breakdown |

## CLI output formats

| Flag | Output |
|------|--------|
| `--output short` | Status line only |
| `--output body` | Response body only |
| `--output headers` | Headers only |
| `--output response` | Status + headers + body |
| `--output exchange` | Full request + response |
| `--output none` | Suppress output |
| `--output-failed <fmt>` | Apply format only for failed requests |
| `--json` | Structured JSON output (CI-friendly) |
| `--junit` | JUnit XML output |

## `@save` metadata

Save response to disk instead of displaying:
```http
# @save
# @extension json
GET https://httpbin.org/json
```

> `@save` and `@openWith` are ignored in CLI and httpBook.
