# Variables

Variables avoid data duplication and enable environment switching. Referenced with `{{variableName}}`.

## Inline variable definition

```http
@foo = bar
@fooExtended = {{foo}}_Extended
GET https://httpbin.org/anything?q={{fooExtended}}
```

**Fixed vs lazy:**
- `@foo = val` — evaluated at definition time (fixed)
- `@foo:= val` — evaluated lazily just before the request

## Variable scope

| Scope | Source |
|-------|--------|
| Environment | `provideVariables` hook, dotenv, env JSON files |
| File global | Variables in a region without a request |
| Request | Variables defined in the current region |

Make a variable global across files:
```http
{{ $global.foo = response.parsedBody.args.foo; }}
```

## Built-in dynamic variables

### Intellij-compatible

| Variable | Description |
|----------|-------------|
| `{{$uuid}}` | UUID v4 |
| `{{$timestamp}}` | Unix timestamp |
| `{{$randomInt}}` | Random integer 0–1000 |
| `{{$isoTimestamp}}` | ISO 8601 datetime |
| `{{$random.uuid}}` | UUID v4 |
| `{{$random.integer(min,max)}}` | Random integer in range |
| `{{$random.float(min,max)}}` | Random float in range |
| `{{$random.alphabetic(n)}}` | Random alphabetic string |
| `{{$random.email}}` | Random email |
| `{{$random.hexadecimal(n)}}` | Random hex string |

### Rest-Client-compatible

| Variable | Description |
|----------|-------------|
| `{{$guid}}` | UUID v4 |
| `{{$randomInt min max}}` | Random integer in range |
| `{{$timestamp [offset unit]}}` | Unix timestamp |
| `{{$datetime rfc1123\|iso8601\|"fmt" [offset unit]}}` | UTC datetime |
| `{{$localDatetime rfc1123\|iso8601\|"fmt" [offset unit]}}` | Local datetime |
| `{{$processEnv KEY}}` | OS environment variable |
| `{{$dotenv KEY}}` | dotenv variable |

## Interactive variables

```http
@query = {{$input input prompt? $value: default}}
@pass  = {{$password prompt? $value: default}}
@pick  = {{$pick select prompt? $value: opt1,opt2}}

# Ask only once (cached)
@query = {{$input-askonce prompt? $value: default}}
@pick  = {{$pick-askonce prompt? $value: opt1,opt2}}
```

## OAuth2 / OpenID Connect

```http
Authorization: openid <grant_type> <prefix>
```

Default `grant_type`: `client_credentials`. Default `prefix`: `oauth2`.

| Grant type | Value |
|-----------|-------|
| Authorization Code | `code` |
| Authorization Code + PKCE | `code <pkce-prefix>` |
| Implicit | `implicit` |
| Resource Owner Password | `password` |
| Client Credentials | `client_credentials` (default) |
| Device Code | `device_code` |

Required variables (replace `oauth2` with your `prefix`):

| Variable | Required for |
|----------|-------------|
| `oauth2_tokenEndpoint` | all flows |
| `oauth2_clientId` | all flows |
| `oauth2_clientSecret` | most flows |
| `oauth2_authorizationEndpoint` | code, implicit |
| `oauth2_username` / `_password` | password flow |
| `oauth2_scope` | all flows (default: `openid`) |
| `oauth2_usePkce=true` | code + PKCE |
| `oauth2_deviceCodeEndpoint` | device_code |

## AWS Signature v4

```http
Authorization: AWS {{accessId}} {{accessKey}} token:{{token}} region:{{region}} service:{{service}}
```

## Authentication helpers

```http
# Basic (auto base64-encodes)
Authorization: Basic {{user}} {{password}}
# With spaces in username/password use :
Authorization: Basic {{user}}:{{password}}

# Digest
Authorization: Digest {{user}} {{password}}
```

## SSL client certificate

Configure in `.httpyac.js` `clientCertificates` setting, or inline:
```http
X-ClientCert: pfx: ./badssl.com-client.p12 passphrase: badssl.com
```

## XPath extraction

```http
$xpath(<varName>:) <xpath-query>
# Example
?? xpath /slideshow/@title == Sample Slide Show
```

Provide namespaces with `@xpath_ns prefix=uri`.

## Import variables from another file

```http
# @import ./variablesInit.http
GET https://httpbin.org/anything?q={{fooExtended}}
```

Only file-global variables are imported. Request variables require `@ref`.
