# Request format

An HTTP request starts with a request line, followed by optional headers, body, and response handlers. Regions are separated by `###`.

## Request line

```http
GET https://www.google.de HTTP/1.1

# Method defaults to GET if omitted
https://www.google.de

# HTTP version controls HTTP/2 usage
GET https://www.google.de HTTP/2.0
```

Allowed methods (uppercase only):

| | | | | |
|---|---|---|---|---|
| GET | POST | PUT | DELETE | PATCH |
| OPTIONS | CONNECT | TRACE | PROPFIND | PROPPATCH |
| COPY | MOVE | LOCK | UNLOCK | CHECKOUT |
| REPORT | MERGE | MKACTIVITY | MKWORKSPACE | VERSION-CONTROL |

## Query strings

```http
# Inline
GET https://httpbin.org/anything?q=httpyac

# Split across lines
GET https://httpbin.org/anything
  ?q=httpyac
  &ie=UTF-8
```

## Headers

```http
GET https://httpbin.org/anything
Content-Type: text/html
Authorization: Bearer token
```

Spread headers via object spread from a global script:

```http
{{+
  exports.defaultHeaders = {
    'Content-Type': 'text/html',
    'Authorization': 'Bearer token'
  };
}}
###
GET https://httpbin.org/anything
...defaultHeaders
```

## Cookie

CookieJar (tough-cookie) is enabled by default. Received `Set-Cookie` headers are sent back automatically.

```http
GET https://httpbin.org/cookies
Cookie: bar=foo

# Disable per-request
# @no-cookie-jar
GET https://www.google.de
```

## Request body

```http
POST https://httpbin.org/anything
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
```

**Import from file:**
```http
POST https://httpbin.org/anything
Content-Type: application/json

< ./body.json          # read as-is
<@ ./body.json         # with variable substitution
<@latin1 ./body.json   # with encoding
< {{assetsDir}}body.json  # variable in path
```

**multipart/form-data:**
```http
POST https://httpbin.org/post
Content-Type: multipart/form-data; boundary=WebKitFormBoundary

--WebKitFormBoundary
Content-Disposition: form-data; name="text"

invoice_text
--WebKitFormBoundary
Content-Disposition: form-data; name="invoice"; filename="invoice.pdf"
Content-Type: application/pdf

< ./dummy.pdf
--WebKitFormBoundary--
```

## GraphQL

```http
POST https://countries.trevorblades.com/graphql
Content-Type: application/json

query Continents($code: String!) {
  continents(filter: {code: {eq: $code}}) { code name }
}

{
  "code": "EU"
}
```

Import from `.gql` file:
```http
gql Continents < ./graphql.gql

{ "code": "EU" }
```

## Region separators / global regions

```http
@host=https://httpbin.org
###
GET /post HTTP/1.1

GET /post HTTP/1.1
```

Global regions (no request) apply metadata/variables/scripts to every request in the file.

## gRPC

```http
proto < ./hello.proto

GRPC grpc.postman-echo.com/HelloService/sayHello
{ "greeting": "world" }
```

Proto-loader options as headers:
```http
proto < ./hello.proto
keepCase: true
longs: String
enums: String

GRPC grpc.postman-echo.com/HelloService/sayHello
{ "greeting": "world" }
```

RPC types: **Unary** (default), **Server Streaming**, **Client Streaming** (use `@streaming` hook + `$requestClient.send()`), **Bidirectional** (body segments with `===`).

## SSE / WebSocket / MQTT / AMQP

| Method | Protocol |
|--------|----------|
| `SSE <url>` | Server-Sent Events (EventSource) |
| `WS <url>` | WebSocket |
| `MQTT <broker>` | MQTT via mqtt.js |
| `AMQP <broker>` | RabbitMQ via @cloudamqp/amqp-client |

Use `@streaming` event hook to keep connection open; `===` to send multiple body parts; `=== wait-for-server` to wait for a server message.

```http
# @keepStreaming
WS wss://socketsbay.com/wss/v2/1/demo/

{ "test": "httpyac" }
```

**MQTT publish/subscribe headers:** `Topic`, `subscribe`, `publish`, `Qos`, `username`, `password`.

**AMQP method header:** `amqp_method` = `publish` | `consume` | `ack` | `nack` | `cancel` | `purge` | `declare` | `bind` | `unbind` | `delete`.
