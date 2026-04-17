export const AGENDA_STATES = ["not_started", "in_progress", "paused", "completed"] as const;
export const TASK_STATES = ["not_started", "in_progress", "completed"] as const;

export type AgendaState = (typeof AGENDA_STATES)[number];
export type TaskState = (typeof TASK_STATES)[number];

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

export type AgendaRow = {
  id: number;
  title: string;
  description: string;
  acceptance_guard: string;
  state: AgendaState;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type TaskRow = {
  id: number;
  agenda_id: number;
  task_order: number;
  note: string;
  state: TaskState;
  created_at: string;
  updated_at: string;
};

export type EvaluationRow = {
  id: number;
  agenda_id: number;
  revision: number;
  evaluation_summary: string;
  evidence_json: string;
  verdict: "pass" | "fail";
  created_at: string;
};

export type AgendaBrowserFilters = {
  state: "all" | AgendaState;
  withUnfinishedTasks: boolean;
};

export type AgendaBrowserRow = {
  agenda: AgendaRow;
  total: number;
  unfinished: number;
};
