import { parseFile } from "./parser.ts";

/**
 * Validate structural rules of a memory .md file.
 * Returns an array of error strings (empty = clean).
 *
 * Rules:
 *   1. At most one # heading per file
 *   2. # heading must appear before any ## heading
 *   3. Heading levels must not skip (no #### directly under ##)
 *   4. No duplicate paths (two sibling slugs that collide)
 */
export function validateFile(content: string, fileName: string): string[] {
  const issues: string[] = [];
  const lines = content.split("\n");

  let titleCount = 0;
  let titleLine = -1;
  let firstH2Line = -1;
  const seenPaths = new Set<string>();
  let prevLevel = 1;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (!match) continue;
    const level = match[1].length;
    const lineNo = i + 1;

    if (level === 1) {
      titleCount++;
      titleLine = lineNo;
      if (titleCount > 1) {
        issues.push(`${fileName}:${lineNo}: multiple # headings — only one allowed`);
      }
    }

    if (level === 2 && firstH2Line === -1) {
      firstH2Line = lineNo;
      if (titleLine !== -1 && firstH2Line < titleLine) {
        issues.push(`${fileName}:${lineNo}: ## heading appears before # heading`);
      }
    }

    if (level > 2 && level > prevLevel + 1) {
      issues.push(`${fileName}:${lineNo}: heading level skipped (h${prevLevel} → h${level})`);
    }
    if (level >= 2) prevLevel = level;
  }

  // Duplicate path detection
  try {
    const parsed = parseFile(content, fileName);
    function checkDups(sections: ReturnType<typeof parseFile>["sections"]) {
      for (const s of sections) {
        if (seenPaths.has(s.path)) {
          issues.push(`${fileName}: duplicate path: ${s.path}`);
        } else {
          seenPaths.add(s.path);
        }
        checkDups(s.children);
      }
    }
    checkDups(parsed.sections);
  } catch {
    // parse error surfaced elsewhere
  }

  return issues;
}
