# Assertions

Declarative assertions use `??` syntax. Script-based assertions use the `test()` helper.

## `??` assertion syntax

```
?? <field> <condition> [expected]
```

```http
GET https://httpbin.org/json

?? status == 200
?? header content-type contains application/json
?? body $.slideshow.author == Yours Truly
?? duration < 3000
```

## Assert fields

| Field | Syntax | Description |
|-------|--------|-------------|
| Status | `?? status <cond> <val>` | HTTP status code |
| Header | `?? header <name> <cond> [val]` | Response header value |
| Body (string) | `?? body <cond> <val>` | Full body as string |
| Body (JSON path) | `?? body <prop> <cond> <val>` | JSON property by path |
| Duration | `?? duration [timing] <cond> <val>` | Request duration (ms) |
| JS expression | `?? js <expr> <cond> <val>` | Arbitrary JS |
| XPath | `?? xpath <query> <cond> <val>` | XPath on XML body |

**Duration timing identifiers:** `firstByte`, `download`, `wait`, `request`, `tcp`, `tls`, `total`

## Conditions

| Condition | Example |
|-----------|--------|
| `== <value>` | `?? status == 200` |
| `!= <value>` | `?? status != 404` |
| `> <value>` | `?? status > 199` |
| `>= <value>` | `?? status >= 200` |
| `< <value>` | `?? duration < 300` |
| `<= <value>` | `?? status <= 200` |
| `startsWith <prefix>` | `?? body $.name startsWith Al` |
| `endsWith <suffix>` | `?? status endsWith 00` |
| `includes` / `contains` | `?? header content-type includes json` |
| `exists` / `isTrue` | `?? header range exists` |
| `isFalse` | `?? header range isFalse` |
| `isNumber` | `?? body $.price isNumber` |
| `isBoolean` | `?? body $.active isBoolean` |
| `isString` | `?? body $.id isString` |
| `isArray` | `?? body $.links isArray` |
| `matches <regex>` | `?? body $.email matches ^.+@` |
| `sha256 <hash>` | `?? body sha256 eji/gfOD9...` |
| `sha512 <hash>` | `?? body sha512 DbaK1OQd...` |
| `md5 <hash>` | `?? body md5 m7WPJhku...` |

## Script-based assertions

Using Node.js `assert`:
```http
GET https://httpbin.org/json

{{
  const { equal } = require('assert');
  test('status 200', () => { equal(response.statusCode, 200); });
}}
```

Using Chai:
```http
{{
  const { expect } = require('chai');
  test('status 200', () => { expect(response.statusCode).to.equal(200); });
}}
```

Using `test` helpers:
```http
{{
  test.status(200);
  test.totalTime(300);
  test.header('content-type', 'application/json');
  test.headerContains('content-type', 'json');
  test.hasResponseBody();
  // test.hasNoResponseBody();
}}
```

## Examples

```http
GET https://httpbin.org/anything

?? status == 200
?? header content-type contains application/json
?? body $.url startsWith https
?? body $.headers isArray isFalse
?? js response.parsedBody.slideshow.slides[0].title == Wake up to WonderWidgets!
?? xpath /slideshow/@title == Sample Slide Show
?? duration < 2000
```
