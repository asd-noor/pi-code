/**
 * ask-tool TUI controller.
 *
 * Implements the AskController class consumed by ctx.ui.custom<AskResult>(…).
 * All rendering is pure string-array assembly; all input handling drives state transitions.
 */

import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  cancelFlow,
  confirm,
  createInitialState,
  digitShortcut,
  enterInput,
  enterOptionNote,
  enterQuestionNote,
  exitInput,
  exitNote,
  getCurrentQuestion,
  getRenderableOptions,
  isOptionSelected,
  isSubmitTab,
  moveOption,
  moveTab,
  OTHER_VALUE,
  saveInput,
  saveNote,
  submitFlow,
  submitInput,
  toggle,
  toResult,
} from "./state.ts";
import type { AskOption, AskParams, AskQuestion, AskResult, AskState } from "./types.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

function clamp(s: string, w: number): string {
  return truncateToWidth(s, w);
}

function repeat(ch: string, n: number): string {
  return n > 0 ? ch.repeat(n) : "";
}

function isAnswered(state: AskState, questionId: string): boolean {
  const vals = state.answers[questionId] ?? [];
  return vals.length > 0 || !!(state.customSelected[questionId] && state.customText[questionId]);
}

// ── AskController ─────────────────────────────────────────────────────────────

export class AskController {
  private state: AskState;
  private inputDraft = "";
  private noteDraft = "";

  constructor(
    private params: AskParams,
    private theme: any,
    private done: (r: AskResult) => void,
  ) {
    this.state = createInitialState(params);
  }

  invalidate(): void {}

  // ── Render ─────────────────────────────────────────────────────────────────

  render(width: number): string[] {
    const { state, theme } = this;
    const lines: string[] = [];
    const th = (k: string, s: string) => theme.fg(k, s);

    // 1. Top border
    lines.push(th("accent", repeat("─", width)));

    // 2. Title
    if (state.title) {
      lines.push(clamp(th("text", ` ${state.title}`), width));
    }

    // 3. Tab bar
    lines.push(this.renderTabBar(width));

    // 4. Empty line
    lines.push("");

    // 5. Content
    if (isSubmitTab(state)) {
      this.renderSubmitScreen(lines, width);
    } else {
      const q = getCurrentQuestion(state);
      if (q) this.renderQuestionScreen(lines, q, width);
    }

    // 7. Empty line
    lines.push("");

    // 8. Footer hints
    lines.push(clamp(this.footerHints(), width));

    // 9. Bottom border
    lines.push(th("accent", repeat("─", width)));

    return lines;
  }

  private renderTabBar(width: number): string {
    const { state, theme } = this;
    const th = (k: string, s: string) => theme.fg(k, s);

    const tabs: string[] = [];
    for (const [i, q] of state.questions.entries()) {
      const active = i === state.activeTabIndex;
      const answered = isAnswered(state, q.id);
      const label = ` ${q.label} `;
      if (active) {
        tabs.push(theme.bg("selectedBg", label));
      } else if (answered) {
        tabs.push(th("success", label));
      } else {
        tabs.push(th("muted", label));
      }
    }

    // Review tab
    const reviewActive = isSubmitTab(state);
    const reviewLabel = " ☰ Review ";
    if (reviewActive) {
      tabs.push(theme.bg("selectedBg", reviewLabel));
    } else {
      tabs.push(th("muted", reviewLabel));
    }

    return clamp(tabs.join(th("borderMuted", "│")), width);
  }

  private renderQuestionScreen(lines: string[], q: AskQuestion, width: number): void {
    const { state, theme } = this;
    const th = (k: string, s: string) => theme.fg(k, s);

    // Prompt
    lines.push(clamp(th("text", ` ${q.prompt}`), width));

    // Question-level note
    const inQuestionNote = state.view === "note" && state.noteTarget?.questionId === q.id && !state.noteTarget.optionValue;
    if (inQuestionNote) {
      lines.push(clamp(th("syntaxString", " Note: ") + theme.bg("selectedBg", " " + this.noteDraft + "|  "), width));
    } else if (state.questionNotes[q.id]) {
      lines.push(clamp(th("syntaxString", " Note: ") + th("muted", state.questionNotes[q.id]), width));
    }
    lines.push("");

    const isPreviewWide = q.type === "preview" && width >= 90;
    const opts = getRenderableOptions(q);

    if (isPreviewWide) {
      this.renderPreviewWide(lines, q, opts, width);
      return;
    }

    for (const [i, opt] of opts.entries()) {
      this.renderOption(lines, q, opt, i, width);
    }
  }

  private renderOption(
    lines: string[],
    q: AskQuestion,
    opt: AskOption,
    index: number,
    width: number,
  ): void {
    const { state, theme } = this;
    const th = (k: string, s: string) => theme.fg(k, s);
    const isActive = state.activeOptionIndex === index && !isSubmitTab(state) && getCurrentQuestion(state)?.id === q.id;
    const selected = isOptionSelected(state, q.id, opt.value);
    const isCustom = opt.value === OTHER_VALUE;

    const pointer = isActive ? "❯ " : "  ";
    const color = isActive ? "accent" : selected ? "success" : "text";
    const multiPrefix = q.type === "multi" ? (selected ? "[x] " : "[ ] ") : "";
    const label = isCustom ? opt.label : `${index + 1}. ${multiPrefix}${opt.label}`;

    lines.push(clamp(theme.fg(color, pointer + label), width));

    // Description
    if (opt.description) {
      lines.push(clamp(theme.fg("muted", "     " + opt.description), width));
    }

    // Input box when actively editing this question's custom option
    if (isCustom && state.view === "input" && state.editingQuestionId === q.id) {
      const boxContent = this.inputDraft + "|";
      lines.push(clamp(theme.bg("selectedBg", "  " + boxContent), width));
    } else if (isCustom && state.customText[q.id] && !state.customSelected[q.id]) {
      // Show saved text in muted if not selected
      lines.push(clamp(theme.fg("muted", "  " + state.customText[q.id]), width));
    } else if (isCustom && state.customText[q.id] && state.customSelected[q.id]) {
      lines.push(clamp(theme.fg("success", "  ✓ " + state.customText[q.id]), width));
    }

    // Option-level note (only for real options, not the custom sentinel)
    if (!isCustom) {
      const inOptNote = state.view === "note" && state.noteTarget?.questionId === q.id && state.noteTarget.optionValue === opt.value;
      if (inOptNote) {
        lines.push(clamp(th("syntaxString", "     note: ") + theme.bg("selectedBg", " " + this.noteDraft + "|  "), width));
      } else if (state.optionNotes[q.id]?.[opt.value]) {
        lines.push(clamp(th("syntaxString", "     note: ") + th("muted", state.optionNotes[q.id][opt.value]), width));
      }
    }
  }

  private renderPreviewWide(lines: string[], q: AskQuestion, opts: AskOption[], width: number): void {
    const { state, theme } = this;
    const leftW = Math.floor(width * 0.4);
    const rightW = width - leftW - 3; // 3 for border chars

    // Left: option list
    const leftLines: string[] = [];
    for (const [i, opt] of opts.entries()) {
      const isActive = state.activeOptionIndex === i;
      const selected = isOptionSelected(state, q.id, opt.value);
      const pointer = isActive ? "❯ " : "  ";
      const color = isActive ? "accent" : selected ? "success" : "text";
      leftLines.push(clamp(theme.fg(color, `${pointer}${i + 1}. ${opt.label}`), leftW));
    }

    // Right: preview for active option
    const activeOpt = opts[state.activeOptionIndex];
    const preview = activeOpt?.preview ?? "";
    const previewLines: string[] = [];
    previewLines.push(theme.fg("borderMuted", "┌" + repeat("─", rightW - 2) + "┐"));
    const pWords = preview.split("\n");
    for (const pw of pWords) {
      previewLines.push(theme.fg("borderMuted", "│") + clamp(" " + pw, rightW - 2) + theme.fg("borderMuted", "│"));
    }
    previewLines.push(theme.fg("borderMuted", "└" + repeat("─", rightW - 2) + "┘"));

    const maxLines = Math.max(leftLines.length, previewLines.length);
    const blank = repeat(" ", leftW);
    const blankR = repeat(" ", rightW);
    for (let i = 0; i < maxLines; i++) {
      const l = leftLines[i] ?? blank;
      const r = previewLines[i] ?? blankR;
      lines.push(clamp(l + " " + r, width));
    }
  }

  private renderSubmitScreen(lines: string[], width: number): void {
    const { state, theme } = this;
    const th = (k: string, s: string) => theme.fg(k, s);

    lines.push(clamp(th("accent", " Review answers"), width));
    lines.push("");

    for (const q of state.questions) {
      const ans = state.answers[q.id] ?? [];
      const labels = ans.map((v) => q.options.find((o) => o.value === v)?.label ?? v);
      if (state.customSelected[q.id] && state.customText[q.id]) {
        labels.push(state.customText[q.id]);
      }
      const answerText = labels.length > 0 ? labels.join(", ") : th("dim", "(unanswered)");
      lines.push(clamp(th("text", ` ${q.label}: ${answerText}`), width));
      // Question note
      if (state.questionNotes[q.id]) {
        lines.push(clamp(th("syntaxString", "   note: ") + th("dim", state.questionNotes[q.id]), width));
      }
      // Option notes
      for (const v of ans) {
        const optNote = state.optionNotes[q.id]?.[v];
        if (optNote) {
          const optLabel = q.options.find((o) => o.value === v)?.label ?? v;
          lines.push(clamp(th("syntaxString", `   ${optLabel} note: `) + th("dim", optNote), width));
        }
      }
    }

    lines.push("");

    const actions = ["Submit", "Elaborate", "Cancel"];
    for (const [i, label] of actions.entries()) {
      const isActive = state.activeSubmitIndex === i;
      const pointer = isActive ? "❯ " : "  ";
      const color = isActive ? "accent" : "text";
      lines.push(clamp(th(color, `${pointer}${i + 1}. ${label}`), width));
    }
  }

  private footerHints(): string {
    const { state, theme } = this;
    const dim = (s: string) => theme.fg("dim", s);
    if (state.view === "input") {
      return dim("Enter: confirm  Esc: cancel  Tab: next tab");
    }
    if (state.view === "note") {
      return dim("Enter: save note  Esc: cancel");
    }
    if (isSubmitTab(state)) {
      return dim("↑↓: move  Enter / 1-3: select  Esc: cancel");
    }
    const q = getCurrentQuestion(state);
    const isMulti = q?.type === "multi";
    return dim(isMulti
      ? "Tab: next  ↑↓: move  Space: toggle  Enter: advance  N: q-note  n: opt-note  1-9: shortcut  Esc: cancel"
      : "Tab: next  ↑↓: move  Space: toggle  Enter: select  N: q-note  n: opt-note  1-9: shortcut  Esc: cancel");
  }

  // ── Input handling ─────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.state.view === "input") {
      this.handleInputMode(data);
    } else if (this.state.view === "note") {
      this.handleNoteMode(data);
    } else {
      this.handleNavigateMode(data);
    }
    if (this.state.completed) {
      this.done(toResult(this.state));
    }
  }

  private handleNoteMode(data: string): void {
    if (matchesKey(data, "enter")) {
      this.state = saveNote(this.state, this.noteDraft);
      this.noteDraft = "";
      return;
    }
    if (matchesKey(data, "escape")) {
      this.state = exitNote(this.state);
      this.noteDraft = "";
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.noteDraft = this.noteDraft.slice(0, -1);
      return;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.noteDraft += data;
    }
  }

  private handleInputMode(data: string): void {
    if (matchesKey(data, "enter")) {
      this.state = submitInput(this.state, this.inputDraft);
      this.inputDraft = "";
      return;
    }
    if (matchesKey(data, "escape")) {
      this.state = exitInput(this.state);
      this.inputDraft = "";
      return;
    }
    if (matchesKey(data, "tab")) {
      this.state = saveInput(this.state, this.inputDraft);
      this.state = exitInput(this.state);
      this.state = moveTab(this.state, 1);
      this.inputDraft = "";
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.inputDraft = this.inputDraft.slice(0, -1);
      return;
    }
    // Printable chars
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.inputDraft += data;
    }
  }

  private handleNavigateMode(data: string): void {
    if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
      this.state = cancelFlow(this.state);
      return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "right")) {
      this.state = moveTab(this.state, 1);
      return;
    }
    if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
      this.state = moveTab(this.state, -1);
      return;
    }
    if (matchesKey(data, "up")) {
      this.state = moveOption(this.state, -1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.state = moveOption(this.state, 1);
      return;
    }
    if (matchesKey(data, "space")) {
      this.state = toggle(this.state);
      return;
    }
    if (matchesKey(data, "enter")) {
      this.state = confirm(this.state);
      return;
    }
    // `N` (shift+n) → question note
    if (data === "N") {
      const q = getCurrentQuestion(this.state);
      if (q && !isSubmitTab(this.state)) {
        this.noteDraft = this.state.questionNotes[q.id] ?? "";
        this.state = enterQuestionNote(this.state, q.id);
        return;
      }
    }
    // `n` → option note on current option, or freeform input on "Type your own"
    if (data === "n") {
      const q = getCurrentQuestion(this.state);
      const opts = q ? getRenderableOptions(q) : [];
      const opt = opts[this.state.activeOptionIndex];
      if (q && opt && !isSubmitTab(this.state)) {
        if (opt.value === OTHER_VALUE) {
          this.state = enterInput(this.state, q.id);
        } else {
          this.noteDraft = this.state.optionNotes[q.id]?.[opt.value] ?? "";
          this.state = enterOptionNote(this.state, q.id, opt.value);
        }
        return;
      }
    }
    // Digit shortcuts 1-9
    const digit = data.length === 1 ? parseInt(data, 10) : NaN;
    if (!isNaN(digit) && digit >= 1 && digit <= 9) {
      this.state = digitShortcut(this.state, digit);
    }
  }
}
