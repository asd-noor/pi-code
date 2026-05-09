/**
 * ask-tool extension types.
 *
 * Shared types used across validate, state, ui, and index modules.
 */

export type AskQuestionType = "single" | "multi" | "preview";

export interface AskOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
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
    preview?: string;
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

export type AskView = "navigate" | "input" | "submit";

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
  completed: boolean;
  cancelled: boolean;
  mode: "submit" | "elaborate";
}

export interface AskResultAnswer {
  values: string[];
  labels: string[];
}

export interface AskResult {
  title?: string;
  cancelled: boolean;
  mode: "submit" | "elaborate";
  questions: Array<{ id: string; label: string; prompt: string; type: AskQuestionType }>;
  answers: Record<string, AskResultAnswer>;
}
