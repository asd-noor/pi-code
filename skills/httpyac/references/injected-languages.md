# Injected languages

httpYac's parser can extract and execute HTTP blocks from non-`.http` files, enabling in-documentation request execution.

## Markdown

Code blocks with language `http` are recognized and executed by httpYac / VSCode extension:

````markdown
## My API

```http
GET https://httpbin.org/json
```
````

In VSCode with the httpYac extension, a "Send" button appears next to each `http` code block.

## Asciidoctor

Code blocks with `[source,http]` are recognized:

```asciidoc
== My API

[source,http]
----
GET https://httpbin.org/json
----
```

## Notes

- All httpYac features (variables, metadata, scripting, assertions) work inside injected blocks.
- Regions are still separated by `###` within the code block.
- The idea is to test endpoints directly from living documentation.
