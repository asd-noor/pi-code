# system-prompt extension

Package-wide runtime policy injected into the system prompt on every turn via `before_agent_start`.

## What it covers

Individual extensions own their own domain-specific instructions. This extension covers cross-cutting policy that applies regardless of which tools are loaded.

| Section | Purpose |
|---|---|
| Skill routing | Deterministic pass before every non-trivial action to select the right skill |
| Mandatory pre-call check | Clarification gate, dependency check, and tool-selection decision before every action |
| Tool selection | `ptc` as default; `parallel` for fan-out; when to use `bash`/`read`/`edit` directly |
| pi-processes | Use the `process` tool for long-running commands — never shell background tricks |
| Change safety | Minimal targeted changes; understand context before editing |
| Memory / agenda integration | Hard triggers for writing to memory; discoveries-to-memory workflow after `agenda_complete` |

## Extension-owned instructions

These instructions are injected by their respective extensions, not by this file:

| Extension | Instruction coverage |
|---|---|
| `ptc.ts` | PTC decision tree, script type priority, `parallel` with ptc slots, uv shebang |
| `parallel.ts` | All supported parallel slots by category, edit/memory write safety |
| `finder` | When to use `ffgrep`/`fffind` vs `ls`/`bash`, @-mention autocomplete, `/fff-mode` |
| `scout` | Hard triggers for web/library tools, `find_library_id` sequencing, never hallucinate APIs |
| `code-map` | Code intelligence tool preferences |
| `memory-md` | Memory write triggers, memory file structure |
| `agenda` | Agenda discipline, task granularity, Ralph-loop workflow |
| `ask-tool` | `ask_user` hard triggers, clarification-first policy |

## File

`extensions/pi-code-prompt.ts`
