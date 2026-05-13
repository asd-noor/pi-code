# Comments

Comments are supported in `.http`/`.rest` files.

## Comment syntax

```http
# single-line comment (type 1)
// single-line comment (type 2)

/*
  multi-line comment
*/
```

> Comments within a request body must start at the beginning of the line (only whitespace before the comment marker).

## Auto-description

The first comment in a region is automatically used as the description for that request:

```http
# Fetch all users
GET https://api.example.com/users
```

Equivalent to `# @description Fetch all users`.

## Metadata annotation style

Metadata uses the `# @key value` form:

```http
# @name GetUser
# @tag smoke
GET https://api.example.com/users/1
```

Intellij alternative: `// @name GetUser`

## httpBook (VSCode Notebook) integration

Comments are used to inject Markdown documentation between requests in httpBook:

```http
/*
# My API (v1.0)

A simple HTTP Request & Response Service
*/

/*
## Auth Endpoints
*/

POST https://api.example.com/auth/login
Content-Type: application/json

{ "username": "alice", "password": "secret" }
```

Multi-line `/* */` blocks render as Markdown sections in the notebook view.
