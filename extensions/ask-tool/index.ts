/**
 * ask-tool extension entry point.
 *
 * Registers the ask_user tool and injects system prompt guidelines.
 * The tool shows an interactive TUI clarification flow and returns
 * structured answers keyed by question id.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateParams } from "./validate.ts";
import { AskController } from "./ui.ts";
import { normalizeQuestions, toResult, createInitialState } from "./state.ts";
import type { AskParams, AskResult } from "./types.ts";

// ── Descriptions ──────────────────────────────────────────────────────────────

const ASK_TOOL_DESCRIPTION =
  "Interactive clarification tool for cases where the next step depends on user preferences, missing requirements, or choosing between multiple valid directions. Ask a short structured interview, collect normalized answers, and continue using those answers explicitly instead of guessing. Supports single-select, multi-select, and preview-pane questions. Always include a machine-readable `value` for every option. Use `preview` only when every option includes `preview` text; descriptions alone are not enough.";

const ASK_TOOL_PROMPT_GUIDELINES = [
  "Use this tool before making preference-sensitive decisions about scope, tone, UX, naming, architecture, docs, or implementation direction.",
  "When multiple valid directions exist, ask 1-3 concise questions instead of committing to one path on your own.",
  "Prefer one focused decision per question. Use short labels. Provide clear, distinct options. Do not add filler options.",
  "Always include a non-empty `value` for every option.",
  "Choose question `type` from the question semantics: `single` means one answer is expected, `multi` means multiple answers could reasonably be selected, and `preview` means options need preview-pane detail and every option includes non-empty `preview` text.",
  "Avoid defaulting mechanically; infer from whether the options are mutually exclusive, can coexist, or need preview-pane detail.",
  'Use `type: "preview"` only when every option includes non-empty `preview` text. Option descriptions do not satisfy this requirement.',
  "After clarifying a note or follow-up question, prefer another structured ask_user follow-up if a choice is still needed instead of switching to plain-text multiple choice in chat.",
  "When prior answers already narrow the branch, bundle the next 2-3 related unresolved decisions into one follow-up ask instead of issuing a long sequence of single-question asks.",
  "Use one-at-a-time follow-up asks only when the next question materially depends on the previous answer.",
] as const;

const ASK_SYSTEM_INSTRUCTION = `
## Clarification first

In interactive mode, always use \`ask_user\` for clarification over silent assumptions whenever a decision
affects scope, approach, risk, or output format. Treat clarification as the default path, not an exception.
If meaningful ambiguity remains after one round, use \`ask_user\` again rather than guessing.

In non-interactive mode (print / JSON / RPC / SDK): proceed with the safest reasonable default
and state assumptions explicitly.

### Hard triggers — always call ask_user

Classify the next step as \`high_stakes\`, \`ambiguous\`, or \`clear\` before acting.

**\`high_stakes\`** — the next step changes:
- architecture, schema, API contract, deployment, or security posture
- production-facing behavior in a costly-to-undo way
- large refactors, migrations, or destructive edits
- legal, financial, medical, career, hiring, vendor, purchasing, or other costly-to-reverse decisions
- public-facing claims, sensitive communications, or consequential recommendations

**\`ambiguous\`** — the next step has:
- missing or conflicting requirements, goals, constraints, or success criteria
- multiple valid options where the trade-off is preference-sensitive
- unclear scope, audience, timeline, risk tolerance, or output format
- any material assumption you would otherwise make silently

Call \`ask_user\` when the classification is \`high_stakes\`, \`ambiguous\`, or both, and the user has not already decided. Do **not** proceed with implementation and ask afterward — clarify first, then act.

Also call \`ask_user\` when the user asks to gather requirements, interview them, compare options, scope research, or plan work. Do not respond with a plain-text questionnaire unless they explicitly asked for a written list.

### Handshake (required before acting on high-stakes or ambiguous steps)

1. Gather evidence first from code/docs/tools.
2. Summarize neutral context (current state, constraints, trade-offs, recommendation).
3. Ask one focused \`ask_user\` call, or bundle 2–5 closely related questions in requirements-gathering mode.
4. Restate the user decision explicitly and proceed with it.
5. Re-open only for materially new ambiguity.

### Question spew prevention

Before any response containing 2+ substantive questions, stop and decide whether they should be interactive.

Use \`ask_user\` instead of prose when answers will materially change the next artifact, plan, implementation,
architecture, research direction, or decision criteria, or when the user has previously asked you to ask interactively.

Plain-text questions are acceptable only when: the user asked for a written checklist, the questions are
rhetorical, or there is exactly one small factual clarification.

### Question budget and escalation

- Max 1 \`ask_user\` call per decision boundary. Max 2 if the first answer was unclear or cancelled.
- Never re-ask the same trade-off without new evidence.
- Attempt 2 must be narrower and always offer \`Proceed with recommended option\` / \`Choose another\` / \`Stop for now\`.
- After attempt 2: for \`high_stakes\` → stop as blocked; for \`ambiguous\` only → proceed with the most reversible default and state the assumption.

### ask_user payload quality

- One concrete decision per question. Short, outcome-oriented option labels.
- Always include a non-empty \`value\`. No filler options.
- \`single\`: one answer expected. \`multi\`: multiple can coexist. \`preview\`: only when every option has non-empty \`preview\` text.
- Avoid defaulting mechanically; infer type from whether options are mutually exclusive or can coexist.
- Use notes (N = question note, n = option note) to capture context before submitting.

### Guardrails

- Do not call \`ask_user\` before reading available context (code, docs, tools).
- Do not use for trivial formatting or style micro-decisions.
- Do not continue implementation after an unclear high-stakes answer.
`.trim();

// ── Schema ────────────────────────────────────────────────────────────────────

const AskParamsSchema = Type.Object({
  title: Type.Optional(
    Type.String({ description: "Optional short title shown above the clarification flow, e.g. README direction" }),
  ),
  questions: Type.Array(
    Type.Object({
      id: Type.Optional(
        Type.String({ description: "Required stable question identifier used as the key in returned answers" }),
      ),
      label: Type.Optional(
        Type.String({ description: "Short tab label, e.g. Goal, Audience, Tone, Scope" }),
      ),
      prompt: Type.Optional(
        Type.String({ description: "Required direct question shown to the user; ask about one decision at a time" }),
      ),
      type: Type.Optional(
        Type.String({
          description:
            'Question type: `single` means one answer is expected, `multi` means multiple answers could reasonably be selected, and `preview` means options need preview-pane detail. Use `preview` only when every option includes `preview` text; descriptions alone are not enough.',
        }),
      ),
      required: Type.Optional(
        Type.Boolean({ description: "Advisory only; marks the question as important but never blocks submission" }),
      ),
      options: Type.Array(
        Type.Object({
          value: Type.Optional(Type.String({ description: "Required machine-readable value returned for this option in the result" })),
          label: Type.Optional(Type.String({ description: "Required short visible option label shown in the list" })),
          description: Type.Optional(Type.String({ description: "Optional one-line explanation to help the user choose" })),
          preview: Type.Optional(Type.String({ description: "Optional preview content shown in the dedicated preview pane for preview questions" })),
        }),
        { description: "Answer options; provide clear, distinct choices and do not add filler options" },
      ),
    }),
    { description: "Questions to ask in the interactive clarification flow" },
  ),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function summarizeResult(result: AskResult): string {
  if (result.cancelled) return "User cancelled the ask flow";
  if (result.mode === "elaborate") {
    const lines: string[] = ["User requested elaboration:"];
    for (const q of result.questions) {
      const ans = result.answers[q.id];
      if (ans) {
        lines.push(`  ${q.label}: ${ans.labels.join(", ")}`);
        if (ans.note) lines.push(`    note: ${ans.note}`);
      } else {
        lines.push(`  ${q.label}: (unanswered)`);
      }
    }
    return lines.join("\n");
  }
  const lines: string[] = [];
  for (const q of result.questions) {
    const ans = result.answers[q.id];
    if (ans) {
      lines.push(`${q.label}: ${ans.labels.join(", ")}`);
      if (ans.note) lines.push(`  note: ${ans.note}`);
      if (ans.optionNotes) {
        for (const [val, note] of Object.entries(ans.optionNotes)) {
          const label = ans.labels[ans.values.indexOf(val)] ?? val;
          lines.push(`  ${label} note: ${note}`);
        }
      }
    }
  }
  return lines.join("\n") || "No answers provided";
}

function formatValidationErrors(issues: Array<{ path: string; message: string }>): string {
  return ["Invalid ask_user payload:", ...issues.map((i) => `- ${i.path}: ${i.message}`)].join("\n");
}

function formatNonInteractiveMessage(params: AskParams): string {
  const questions = params.questions;
  const lines = [
    "Needs user input: ask_user requires interactive UI.",
    "Run same tool call in interactive session, or ask user these questions manually:",
  ];
  for (const [i, q] of questions.entries()) {
    lines.push(`${i + 1}. ${q.label ?? `Q${i + 1}`}: ${q.prompt}`);
    for (const o of q.options ?? []) {
      lines.push(`   - ${o.label} [${o.value}]`);
    }
    lines.push("   - Type your own [custom]");
  }
  return lines.join("\n");
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: ASK_TOOL_DESCRIPTION,
    promptSnippet:
      "Clarify ambiguous or preference-sensitive decisions with a short interactive interview before proceeding",
    promptGuidelines: [...ASK_TOOL_PROMPT_GUIDELINES],
    parameters: AskParamsSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const askParams = params as AskParams;

      // 1. Validate
      const validation = validateParams(askParams);
      if (!validation.ok) {
        return {
          content: [{ type: "text" as const, text: formatValidationErrors(validation.issues) }],
          details: { cancelled: true, mode: "submit", questions: [], answers: {}, error: { kind: "invalid_input", issues: validation.issues } },
        };
      }

      // 2. Non-interactive fallback
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text" as const, text: formatNonInteractiveMessage(askParams) }],
          details: { cancelled: true, mode: "submit", questions: [], answers: {} },
        };
      }

      // 3. Show TUI
      ctx.ui.setWorkingVisible(false);
      const result = await ctx.ui.custom<AskResult>(
        (_tui, theme, _kb, done) => new AskController(askParams, theme, done),
      );
      ctx.ui.setWorkingVisible(true);

      // 4. Return result
      return {
        content: [{ type: "text" as const, text: summarizeResult(result) }],
        details: result,
      };
    },
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: event.systemPrompt + "\n\n" + ASK_SYSTEM_INSTRUCTION,
  }));
}
