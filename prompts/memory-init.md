---
description: Initialize memory by analyzing project structure and storing key information
argument-hint: "[analysis-depth]"
---

## Memory Initialization

You are initializing the memory system for this project. Your task is to:

1. **Check memory status**: Use `memory_list` tool to determine if any `.md` files exist
   - If `memory_list` returns files → memory already initialized, report status and contents
   - If `memory_list` returns empty → proceed with analysis and storage

2. **If initializing (no `.md` files found)**:

Analyze the current project directory and extract key information:
   - **Project Overview**: README, package.json, purpose, goals, scope in natural language; technical jargons go to architecture file.
   - **Architecture**: Directory structure, main entry points, key modules/components, tech stack, constraints.
   - **Dependencies**: Notable libraries, external services, APIs.
   - **Configuration**: Environment setup, build process, tooling.
   - **Development Workflow**: How to run, test, build, deploy.

3. **Store memories using the canonical files**:

Always prefer these standard files. Create additional files only when content clearly does not fit any of them:

| File | Purpose |
|------|---------|
| `architecture.md` | Project architecture, tech stack, codebase reference, constraints |
| `project.md` | Categorised natural language description of the project, its goals, and scope |
| `setup.md` | Development setup, dependencies, configuration |
| `decisions.md` | Decisions made during the project — rationale and alternatives considered |
| `workflow.md` | Short summaries of actions taken; living chronological context of steps, challenges, and solutions |
| `notes.md` | Arbitrary notes — challenges faced, lessons learned, future considerations |

For each file:
   - Use `memory_create_file` to create the file (name must not contain `/`, must not start with `.`, must not include `.md`)
   - Use `memory_new` to add sections. The path is derived from the **filename + heading nesting**:
     - The filename (without `.md`) is always the first path segment
     - `#` is a decorative title only — ignored for path derivation
     - `##` headings become the second path segment: `file/heading-slug`
     - `###` headings become the third: `file/parent-slug/heading-slug`
     - `####` headings become the fourth: `file/grandparent/parent/heading-slug`
     - Slugification: lowercase, spaces → `-`, all non-alphanumeric characters except `-` stripped
     - Example: `architecture.md` + `## Tech Stack` → `architecture/tech-stack`; `### Frontend` → `architecture/tech-stack/frontend`
   - **Use nesting — don't flatten.** A `##` should cover one coherent topic. Sub-topics, categories, or distinct facts belong under `###` or `####`. Avoid cramming multiple concepts into a single `##` body — break them into child sections instead. This keeps each section small, focused, and easy to retrieve.
   - Store factual, concise information suitable for future reference
   - Include paths, commands, and specific details where relevant
   - After writing to a file, run `memory_validate_file` to check for duplicate paths, skipped heading levels, and multiple title headings

4. **Report back**:

After initialization, use `memory_list` to verify and report:
   - Memory files created
   - Key sections stored per file
   - Total sections indexed
   - Next steps: "Memory initialized and ready for use across sessions"

**Acceptance Guard**: Memory is initialized when ≥3 memory files exist with ≥2 sections each, covering project overview, architecture, and setup/workflow.
