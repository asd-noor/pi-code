/**
 * ask-tool extension types.
 *
 * Shared types used across validate, state, ui, and index modules.
 */

export type AskQuestionType = "single" | "multi";

export interface AskOption {
  value: string;
  label: string;
  description?: string;
}

/** Raw input as passed by the LLM (all fields are Optional in the schema). */
export interface AskQuestionInput {
  id?: string;
  label?: string;
  prompt?: string;
  type?: string;
  required?: boolean;
  options: Array<{
    value?: string;
    label?: string;
    description?: string;
  }>;
}

export interface AskParams {
  title?: string;
  questions: AskQuestionInput[];
}

/** Normalized question — all fields are guaranteed non-null after normalization. */
export interface AskQuestion {
  id: string;
  label: string;
  prompt: string;
  type: AskQuestionType;
  required: boolean;
  options: AskOption[];
}

export interface AskValidationIssue {
  path: string;
  message: string;
}

export type AskView = "navigate" | "input" | "note" | "submit";

export interface AskNoteTarget {
  questionId: string;
  /** undefined = question-level note; set = option-level note */
  optionValue?: string;
}

export interface AskState {
  title?: string;
  questions: AskQuestion[];
  activeTabIndex: number;
  activeOptionIndex: number;
  activeSubmitIndex: number;
  /** Selected option values per question id. */
  answers: Record<string, string[]>;
  /** Freeform text per question id. */
  customText: Record<string, string>;
  /** Whether the freeform "Type your own" option is selected per question id. */
  customSelected: Record<string, boolean>;
  view: AskView;
  /** Set when view === "input". */
  editingQuestionId?: string;
  /** Set when view === "note". */
  noteTarget?: AskNoteTarget;
  /** Question-level notes keyed by question id. */
  questionNotes: Record<string, string>;
  /** Option-level notes keyed by question id → option value. */
  optionNotes: Record<string, Record<string, string>>;
  completed: boolean;
  cancelled: boolean;
  mode: "submit" | "elaborate";
}

export interface AskResultAnswer {
  values: string[];
  labels: string[];
  /** Question-level note, if any. */
  note?: string;
  /** Option-level notes keyed by option value. */
  optionNotes?: Record<string, string>;
}

export interface AskResult {
  title?: string;
  cancelled: boolean;
  mode: "submit" | "elaborate";
  questions: Array<{ id: string; label: string; prompt: string; type: AskQuestionType }>;
  answers: Record<string, AskResultAnswer>;
}
