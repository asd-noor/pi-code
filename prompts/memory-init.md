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
   - **Project Overview**: README, package.json, purpose, tech stack
   - **Architecture**: Directory structure, main entry points, key modules/components
   - **Dependencies**: Notable libraries, external services, APIs
   - **Configuration**: Environment setup, build process, tooling
   - **Constraints**: Known issues, technical debt, limitations
   - **Development Workflow**: How to run, test, build, deploy

3. **Store memories effectively**:

Use these memory file topics as a starting point:
   - `project.md` — Project overview, purpose, tech stack
   - `architecture.md` — Directory structure, modules, entry points
   - `setup.md` — Development setup, dependencies, configuration
   - `workflow.md` — Build, test, deploy processes
   - `decisions.md` — Important architectural decisions and constraints

For each file:
   - Use `memory_create_file` to create each topic file
   - Use `memory_new` to add sections. The path is derived from the **filename + heading nesting**:
     - The filename (without `.md`) is always the first path segment
     - `#` is a decorative title only — ignored for path derivation
     - `##` headings become the second path segment: `file/heading-slug`
     - `###` headings become the third: `file/parent-slug/heading-slug`
     - Example: `project.md` + `## Tech Stack` → path `project/tech-stack`
   - Store factual, concise information suitable for future reference
   - Include paths, commands, and specific details where relevant
   - Use `memory_search` to check for related information when linking sections
   - After writing to a file, run `memory_validate_file` to check for duplicate paths, skipped heading levels, and multiple title headings

4. **Report back**:

After initialization, use `memory_list` to verify and report:
   - Memory files created
   - Key sections stored per file
   - Total sections indexed
   - Next steps: "Memory initialized and ready for use across sessions"

**Acceptance Guard**: Memory is initialized when ≥3 memory files exist with ≥2 sections each, covering project overview, architecture, and setup/workflow.
