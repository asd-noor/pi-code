/**
 * diff-parser.ts — Parse git diff output into structured FileDiff / DiffHunk objects.
 */

import type { FileDiff, DiffHunk } from "./types.ts";

// Regex to parse @@ -oldStart[,oldCount] +newStart[,newCount] @@
const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * Parse the output of `git diff` (or `git diff --cached`) into an array of FileDiff objects.
 */
export function parseDiff(output: string): FileDiff[] {
  if (!output.trim()) return [];

  const result: FileDiff[] = [];

  // Split on "diff --git" boundaries
  const fileSections = output.split(/^(?=diff --git )/m).filter(Boolean);

  for (const section of fileSections) {
    const rawLines = section.split("\n");

    // Find the first @@ line
    const firstHunkIdx = rawLines.findIndex((l) => l.startsWith("@@"));
    if (firstHunkIdx === -1) {
      // No hunks (e.g. binary files), skip
      continue;
    }

    // Extract file path from "diff --git a/path b/path"
    const diffGitLine = rawLines[0] ?? "";
    const pathMatch = diffGitLine.match(/^diff --git a\/(.+) b\/(.+)$/);
    const path = pathMatch ? (pathMatch[2] ?? "unknown") : "unknown";

    const diffHeader = rawLines.slice(0, firstHunkIdx);

    // Split remainder into hunks
    const hunkLines = rawLines.slice(firstHunkIdx);
    const hunks: DiffHunk[] = [];
    let currentHunk: string[] | null = null;

    for (const line of hunkLines) {
      if (line.startsWith("@@")) {
        if (currentHunk) {
          hunks.push(parseHunk(currentHunk));
        }
        currentHunk = [line];
      } else if (currentHunk) {
        currentHunk.push(line);
      }
    }
    if (currentHunk && currentHunk.length > 0) {
      hunks.push(parseHunk(currentHunk));
    }

    if (hunks.length > 0) {
      result.push({ path, diffHeader, hunks });
    }
  }

  return result;
}

function parseHunk(lines: string[]): DiffHunk {
  const header = lines[0] ?? "";
  const m = header.match(HUNK_HEADER_RE);
  const oldStart = m ? parseInt(m[1]!, 10) : 1;
  const oldCount = m ? (m[2] !== undefined ? parseInt(m[2], 10) : 1) : 0;
  const newStart = m ? parseInt(m[3]!, 10) : 1;
  const newCount = m ? (m[4] !== undefined ? parseInt(m[4], 10) : 1) : 0;

  // Remove trailing empty line artifact from split
  const trimmed = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;

  return { header, lines: trimmed, oldStart, oldCount, newStart, newCount };
}

/**
 * Build a minimal valid patch string for a single hunk.
 * The patch includes the file headers and the single hunk body.
 */
export function buildHunkPatch(fileDiff: FileDiff, hunk: DiffHunk): string {
  const parts: string[] = [];
  for (const h of fileDiff.diffHeader) {
    parts.push(h);
  }
  for (const line of hunk.lines) {
    parts.push(line);
  }
  // git apply requires a trailing newline
  parts.push("");
  return parts.join("\n");
}
