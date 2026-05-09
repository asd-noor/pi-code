/**
 * ask-tool pure state transitions.
 *
 * No IO or side effects — all functions take a state and return a new state.
 */

import type { AskOption, AskParams, AskQuestion, AskResult, AskState } from "./types.ts";
import { normalizeQuestions } from "./validate.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

export const OTHER_VALUE = "__other__";
export const OTHER_LABEL = "Type your own";

const SUBMIT_ACTION_COUNT = 3;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the full renderable option list including the "Type your own" sentinel. */
export function getRenderableOptions(question: AskQuestion): AskOption[] {
  return [...question.options, { value: OTHER_VALUE, label: OTHER_LABEL }];
}

/** Returns true if the given value is selected for a question. */
export function isOptionSelected(state: AskState, questionId: string, value: string): boolean {
  if (value === OTHER_VALUE) return !!state.customSelected[questionId];
  return (state.answers[questionId] ?? []).includes(value);
}

/** True when the active tab is the submit/review tab. */
export function isSubmitTab(state: AskState): boolean {
  return state.activeTabIndex >= state.questions.length;
}

/** Returns the active question, or undefined on the submit tab. */
export function getCurrentQuestion(state: AskState): AskQuestion | undefined {
  return state.questions[state.activeTabIndex];
}

/** Returns the currently highlighted renderable option. */
export function getCurrentOption(state: AskState): AskOption | undefined {
  const q = getCurrentQuestion(state);
  if (!q) return undefined;
  return getRenderableOptions(q)[state.activeOptionIndex];
}

// ── createInitialState ────────────────────────────────────────────────────────

export function createInitialState(params: AskParams): AskState {
  return {
    title: params.title,
    questions: normalizeQuestions(params),
    activeTabIndex: 0,
    activeOptionIndex: 0,
    activeSubmitIndex: 0,
    answers: {},
    customText: {},
    customSelected: {},
    view: "navigate",
    completed: false,
    cancelled: false,
    mode: "submit",
  };
}

// ── Tab navigation ────────────────────────────────────────────────────────────

export function moveTab(state: AskState, delta: 1 | -1): AskState {
  const total = state.questions.length + 1;
  const next = (state.activeTabIndex + delta + total) % total;
  return {
    ...state,
    activeTabIndex: next,
    activeOptionIndex: 0,
    activeSubmitIndex: 0,
    view: next >= state.questions.length ? "submit" : "navigate",
    editingQuestionId: undefined,
  };
}

// ── Option navigation ─────────────────────────────────────────────────────────

export function moveOption(state: AskState, delta: 1 | -1): AskState {
  if (isSubmitTab(state)) {
    const next = Math.max(0, Math.min(SUBMIT_ACTION_COUNT - 1, state.activeSubmitIndex + delta));
    return { ...state, activeSubmitIndex: next };
  }
  const q = getCurrentQuestion(state);
  if (!q) return state;
  const opts = getRenderableOptions(q);
  const next = Math.max(0, Math.min(opts.length - 1, state.activeOptionIndex + delta));
  return { ...state, activeOptionIndex: next };
}

// ── confirm (Enter) ───────────────────────────────────────────────────────────

export function confirm(state: AskState): AskState {
  if (isSubmitTab(state)) {
    return executeSubmitAction(state);
  }

  const q = getCurrentQuestion(state);
  if (!q) return state;
  const opt = getCurrentOption(state);
  if (!opt) return state;

  if (opt.value === OTHER_VALUE) {
    // Enter on "Type your own" → open input
    return enterInput(state, q.id);
  }

  if (q.type === "multi") {
    // Enter on multi: just advance
    return advanceTab(state);
  }

  // Single/preview: select and advance
  const next = setSelection(state, q.id, [opt.value]);
  return advanceTab(next);
}

// ── toggle (Space) ────────────────────────────────────────────────────────────

export function toggle(state: AskState): AskState {
  if (isSubmitTab(state)) {
    const next = (state.activeSubmitIndex + 1) % SUBMIT_ACTION_COUNT;
    return { ...state, activeSubmitIndex: next };
  }

  const q = getCurrentQuestion(state);
  if (!q) return state;
  const opt = getCurrentOption(state);
  if (!opt) return state;

  if (opt.value === OTHER_VALUE) {
    // Space on "Type your own": open input
    return enterInput(state, q.id);
  }

  if (q.type === "multi") {
    return toggleMultiOption(state, q.id, opt.value);
  }

  // Single: toggle off if already selected, else select (don't advance)
  const current = state.answers[q.id] ?? [];
  const selected = current.includes(opt.value);
  return setSelection(state, q.id, selected ? [] : [opt.value]);
}

function toggleMultiOption(state: AskState, questionId: string, value: string): AskState {
  const current = state.answers[questionId] ?? [];
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value];
  const answers = { ...state.answers };
  if (next.length === 0) {
    delete answers[questionId];
  } else {
    answers[questionId] = next;
  }
  return { ...state, answers };
}

function setSelection(state: AskState, questionId: string, values: string[]): AskState {
  const answers = { ...state.answers };
  if (values.length === 0) {
    delete answers[questionId];
  } else {
    answers[questionId] = values;
  }
  // If switching to a regular option on a single question, deselect custom
  const customSelected = { ...state.customSelected };
  if (values.length > 0) delete customSelected[questionId];
  return { ...state, answers, customSelected };
}

// ── Digit shortcuts ───────────────────────────────────────────────────────────

export function digitShortcut(state: AskState, n: number): AskState {
  if (n <= 0) return state;

  if (isSubmitTab(state)) {
    if (n > SUBMIT_ACTION_COUNT) return state;
    return executeSubmitAction({ ...state, activeSubmitIndex: n - 1 });
  }

  const q = getCurrentQuestion(state);
  if (!q) return state;
  const opts = getRenderableOptions(q);
  const opt = opts[n - 1];
  if (!opt) return state;

  const nextState = { ...state, activeOptionIndex: n - 1 };

  if (opt.value === OTHER_VALUE) {
    return enterInput(nextState, q.id);
  }
  if (q.type === "multi") {
    return toggleMultiOption(nextState, q.id, opt.value);
  }
  return advanceTab(setSelection(nextState, q.id, [opt.value]));
}

// ── Input mode ────────────────────────────────────────────────────────────────

export function enterInput(state: AskState, questionId: string): AskState {
  return { ...state, view: "input", editingQuestionId: questionId };
}

export function exitInput(state: AskState): AskState {
  return {
    ...state,
    view: isSubmitTab(state) ? "submit" : "navigate",
    editingQuestionId: undefined,
  };
}

export function saveInput(state: AskState, text: string): AskState {
  if (!state.editingQuestionId) return state;
  const qId = state.editingQuestionId;
  if (!text.trim()) {
    // Clear custom text + selection
    const customText = { ...state.customText };
    const customSelected = { ...state.customSelected };
    delete customText[qId];
    delete customSelected[qId];
    return { ...state, customText, customSelected };
  }
  return {
    ...state,
    customText: { ...state.customText, [qId]: text },
    customSelected: { ...state.customSelected, [qId]: true },
  };
}

export function submitInput(state: AskState, text: string): AskState {
  const saved = saveInput(state, text);
  const exited = exitInput(saved);
  if (!state.editingQuestionId) return exited;
  const q = state.questions.find((q) => q.id === state.editingQuestionId);
  if (!q) return exited;
  // For single questions advance if there is content
  if (q.type !== "multi" && text.trim()) {
    return advanceTab(exited);
  }
  return exited;
}

// ── Cancel / submit / elaborate ───────────────────────────────────────────────

export function cancelFlow(state: AskState): AskState {
  return { ...state, cancelled: true, completed: true };
}

export function submitFlow(state: AskState): AskState {
  return { ...state, mode: "submit", completed: true };
}

export function elaborateFlow(state: AskState): AskState {
  return { ...state, mode: "elaborate", completed: true };
}

// ── toResult ──────────────────────────────────────────────────────────────────

export function toResult(state: AskState): AskResult {
  const answers: AskResult["answers"] = {};
  for (const q of state.questions) {
    const selected = state.answers[q.id] ?? [];
    const values: string[] = [...selected];
    const labels: string[] = selected.map(
      (v) => q.options.find((o) => o.value === v)?.label ?? v,
    );
    if (state.customSelected[q.id] && state.customText[q.id]) {
      values.push(state.customText[q.id]);
      labels.push(state.customText[q.id]);
    }
    if (values.length > 0) {
      answers[q.id] = { values, labels };
    }
  }
  return {
    title: state.title,
    cancelled: state.cancelled,
    mode: state.mode,
    questions: state.questions.map((q) => ({ id: q.id, label: q.label, prompt: q.prompt, type: q.type })),
    answers,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function advanceTab(state: AskState): AskState {
  const next = Math.min(state.activeTabIndex + 1, state.questions.length);
  return {
    ...state,
    activeTabIndex: next,
    activeOptionIndex: 0,
    activeSubmitIndex: 0,
    view: next >= state.questions.length ? "submit" : "navigate",
    editingQuestionId: undefined,
  };
}

function executeSubmitAction(state: AskState): AskState {
  if (state.activeSubmitIndex === 2) return cancelFlow(state);
  if (state.activeSubmitIndex === 1) return elaborateFlow(state);
  return submitFlow(state);
}
