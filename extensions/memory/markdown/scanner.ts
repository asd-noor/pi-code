import { readFileSync } from "node:fs";
import type { MemoryDB } from "../daemon/db.ts";

const HEADING_RE = /^(#{1,6})\s+/;

interface HeadingEntry {
  line: number;   // 0-based
  level: number;
  slug: string;   // last path segment
}

/** Extract all ATX headings from raw file content. O(lines), no parser needed. */
function scanHeadings(content: string): HeadingEntry[] {
  const entries: HeadingEntry[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING_RE);
    if (!m) continue;
    const level = m[1].length;
    if (level === 1) continue; // skip # title
    const text = lines[i].slice(m[0].length).trim();
    const label = text.indexOf(" | ") !== -1 ? text.slice(0, text.indexOf(" | ")).trim() : text;
    const slug = label.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    entries.push({ line: i, level, slug });
  }
  return entries;
}

/**
 * Re-scan a file and update all line-number columns in SQLite.
 * Called after every mutation. Does NOT update content, embeddings, or FTS.
 */
export function rescanLineNumbers(filePath: string, fileName: string, db: MemoryDB): void {
  const content = readFileSync(filePath, "utf8");
  const totalLines = content.split("\n").length;
  const headings = scanHeadings(content);

  const updates: Array<{
    path: string;
    headingLine: number;
    bodyStartLine: number;
    bodyEndLine: number;
    sectionEndLine: number;
  }> = [];

  // Reconstruct paths from the heading stack (mirrors parser.ts logic)
  const stack: Array<{ level: number; pathSegments: string[] }> = [];

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];

    // Pop stack to parent level
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop();

    const parentSegments = stack.length > 0 ? stack[stack.length - 1].pathSegments : [fileName];
    const pathSegments = [...parentSegments, h.slug];
    stack.push({ level: h.level, pathSegments });
    const path = pathSegments.join("/");

    // section_end_line: next heading at same or higher level, or EOF
    let sectionEnd = totalLines;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) { sectionEnd = headings[j].line; break; }
    }

    // body_end_line: first child heading, or section_end_line
    let bodyEnd = sectionEnd;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].line >= sectionEnd) break;
      if (headings[j].level > h.level) { bodyEnd = headings[j].line; break; }
    }

    updates.push({
      path,
      headingLine:    h.line,
      bodyStartLine:  h.line + 1,
      bodyEndLine:    bodyEnd,
      sectionEndLine: sectionEnd,
    });
  }

  db.updateLineNumbers(fileName, updates);
}
