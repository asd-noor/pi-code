# Environments

An environment is a named set of variables. Activate with `--env <name>`. Multiple environments can be active simultaneously.

## Intellij env file (`http-client.env.json`)

```json
{
  "$shared": {
    "host": "https://mydomain"
  },
  "$default": {
    "user": "dev-user",
    "password": "dev-pass"
  },
  "dev": {
    "user": "mario",
    "password": "123456"
  },
  "prod": {
    "user": "mario",
    "password": "password$ecure123"
  }
}
```

- `$shared` — always loaded
- `$default` — used when no `--env` flag is given
- Named keys — loaded when `--env <name>` matches

**Private overrides:** `http-client.private.env.json` (same format, not committed).

Search order: same directory as `*.http` file → project root → `env/` folder in project root.

## Dotenv (`.env`)

```ini
authHost=https://my.openid.de
auth_tokenEndpoint={{authHost}}/auth/realms/test/protocol/openid-connect/token
```

All environment variables are expanded automatically.

**Env-specific `.env` files:**

```
.env            # global (all environments)
.env.local      # only for env "local"
local.env       # only for env "local"
```

Search order: same directory as `*.http` → project root → `env/` folder in project root → path in `HTTPYAC_ENV` env var.

## JSON via `.httpyac.js`

```js
// .httpyac.js
module.exports = {
  environments: {
    "$shared": { "host": "https://mydomain" },
    "dev":  { "user": "mario", "password": "123456" },
    "prod": { "user": "mario", "password": "secure" }
  }
};
```

## Variable resolution order (highest wins)

1. `--var` CLI flag
2. `.env` file
3. Named environment in `http-client.env.json`
4. `$default` in `http-client.env.json`
5. `$shared` in `http-client.env.json`
6. Inline `@variable = value` in the `.http` file
7. `.httpyac.js` `provideVariables` hook

## Special environment variables

| Variable | Effect |
|----------|--------|
| `request_rejectUnauthorized=false` | Ignore invalid SSL certs |
| `request_proxy=socks://localhost:1080` | Set proxy for all requests |

## CLI usage

```bash
# Single environment
httpyac send requests.http --all --env staging

# Multiple environments (merged, left-to-right precedence)
httpyac send requests.http --all --env base staging

# Runtime override
httpyac send requests.http --all --env staging --var token=override
```
