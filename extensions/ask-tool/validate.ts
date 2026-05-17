/**
 * ask-tool parameter validation and question normalization.
 *
 * Pure functions — no IO or side effects.
 */

import type {
  AskOption,
  AskParams,
  AskQuestion,
  AskQuestionInput,
  AskQuestionType,
  AskValidationIssue,
} from "./types.ts";

// ── Validation ────────────────────────────────────────────────────────────────

export function validateParams(
  params: AskParams,
  opts: { allowFreeform?: boolean } = {},
): { ok: true } | { ok: false; issues: AskValidationIssue[] } {
  const issues: AskValidationIssue[] = [];

  const questions = params.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    issues.push({ path: "questions", message: "At least one question is required" });
    return { ok: false, issues };
  }

  const seenIds = new Set<string>();
  for (const [qi, q] of questions.entries()) {
    const qPath = `questions[${qi}]`;
    const qn = qi + 1;

    // type
    if (q.type !== undefined && q.type !== "single" && q.type !== "multi") {
      issues.push({ path: `${qPath}.type`, message: `Question ${qn}: invalid type "${q.type}"; expected single or multi` });
    }

    // id
    const id = q.id?.trim();
    if (!id) {
      issues.push({ path: `${qPath}.id`, message: `Question ${qn}: id is required` });
    } else if (seenIds.has(id)) {
      issues.push({ path: `${qPath}.id`, message: `Question ${qn}: duplicate question id "${id}"` });
    } else {
      seenIds.add(id);
    }

    // label (optional but if present must not be empty)
    if (q.label !== undefined && !q.label.trim()) {
      issues.push({ path: `${qPath}.label`, message: `Question ${qn}: label must not be empty` });
    }

    // prompt
    if (!q.prompt?.trim()) {
      issues.push({ path: `${qPath}.prompt`, message: `Question ${qn}: prompt is required` });
    }

    // options
    if (!Array.isArray(q.options) || q.options.length === 0) {
      issues.push({ path: `${qPath}.options`, message: `Question ${qn}: at least one option is required` });
      continue;
    }

    const qType = normalizeType(q.type);
    const seenValues = new Set<string>();
    for (const [oi, o] of q.options.entries()) {
      const oPath = `${qPath}.options[${oi}]`;
      const on = oi + 1;
      const prefix = `Question ${qn}, option ${on}`;

      const val = o.value?.trim();
      if (!val) {
        issues.push({ path: `${oPath}.value`, message: `${prefix}: value is required` });
      } else if (seenValues.has(val)) {
        issues.push({ path: `${oPath}.value`, message: `${prefix}: duplicate option value "${val}"` });
      } else {
        seenValues.add(val);
      }

      if (!o.label?.trim()) {
        issues.push({ path: `${oPath}.label`, message: `${prefix}: label is required` });
      }

      if (o.description !== undefined && !o.description.trim()) {
        issues.push({ path: `${oPath}.description`, message: `${prefix}: description must not be empty` });
      }
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

// ── Normalization ─────────────────────────────────────────────────────────────

export function normalizeQuestions(params: AskParams): AskQuestion[] {
  return params.questions.map((q, i) => normalizeQuestion(q, i));
}

function normalizeQuestion(q: AskQuestionInput, index: number): AskQuestion {
  return {
    id: q.id!.trim(),
    label: q.label?.trim() || `Q${index + 1}`,
    prompt: q.prompt!.trim(),
    type: normalizeType(q.type),
    required: q.required ?? false,
    options: q.options.map(normalizeOption),
  };
}

function normalizeOption(o: AskQuestionInput["options"][number]): AskOption {
  return {
    value: o.value!.trim(),
    label: o.label!.trim(),
    ...(o.description ? { description: o.description.trim() } : {}),
  };
}

function normalizeType(t: string | undefined): AskQuestionType {
  return t === "multi" ? t : "single";
}
