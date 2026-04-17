# workflow

## Development

No build step — extensions are TypeScript files run directly via Bun or pi's runtime.

```bash
cd /Users/noor/Builds/pi-code
npm install
ls extensions/ skills/ prompts/ docs/
```

## Validation

No automated test suite. Validation steps:

- Install with pi and verify extensions load at startup
- Run `memory_validate_file` to check memory file structure
- Run `code_map_diagnostics` (severity 1) to catch type errors

## Versioning

- Version file: `package.json` (`version` field)
- Changelog: `CHANGELOG.md` (Keep a Changelog format, semver)
- Current version: 1.2.0 (released 2026-04-17)

## Docs Maintenance

- Each extension/skill has a matching doc in `docs/<name>.md`
- README.md is the primary entry point listing all extensions and skills

## Memory File Rules

- Memory stored in `.pi-memory/` (project-local)
- Use `memory_validate_file` after bulk writes
- Heading slugification: "API Keys" becomes `api-keys`; path depth equals heading level (`##` = depth 2)
- Do NOT use markdown tables in memory files — causes goldmark parser panic in memory-md daemon
