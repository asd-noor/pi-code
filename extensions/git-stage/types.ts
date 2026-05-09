/**
 * Shared types for the git-stage extension.
 */

export interface GitFileStatus {
  path: string;
  xStatus: string;    // index status (staged)
  yStatus: string;    // worktree status (unstaged)
  staged: boolean;    // has any staged changes
  unstaged: boolean;  // has any unstaged changes
  untracked: boolean;
  newFile: boolean;   // completely new (A in index)
  deleted: boolean;
}

export interface DiffHunk {
  header: string;       // @@ -a,b +c,d @@ context
  lines: string[];      // diff lines (including the @@ line)
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface FileDiff {
  path: string;
  diffHeader: string[]; // lines before first @@ (diff --git, index, ---, +++)
  hunks: DiffHunk[];
}

export type PanelFocus = "files" | "hunks";
