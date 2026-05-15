import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import type { Root, Heading, RootContent } from "mdast";

export interface ParsedFile {
  title: string;        // text of the # heading (empty if absent)
  description: string;  // body text between # heading and first ## heading
  sections: ParsedSection[];
}

export interface ParsedSection {
  path: string;         // e.g. "architecture/tech-stack/frontend"
  heading: string;      // raw heading text
  level: number;        // 2–6
  content: string;      // immediate body (markdown string, no child headings)
  children: ParsedSection[];
  // Line numbers (0-based, exclusive-end)
  headingLine: number;
  bodyStartLine: number;
  bodyEndLine: number;
  sectionEndLine: number;
}

/** Slugify a heading string to a path segment. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

/** Extract plain text from an mdast Heading node. */
function headingText(node: Heading): string {
  return node.children
    .map((c) => ("value" in c ? c.value : ""))
    .join("")
    .trim();
}

/**
 * Serialize a list of mdast nodes back to markdown.
 * Used to extract immediate body content between two headings.
 */
function nodesToMarkdown(nodes: RootContent[]): string {
  const root: Root = { type: "root", children: nodes };
  return toMarkdown(root).trim();
}

export function parseFile(content: string, fileName: string): ParsedFile {
  const lines = content.split("\n");
  const tree = fromMarkdown(content);
  const nodes = tree.children;

  let title = "";
  let description = "";
  const sectionStack: Array<ParsedSection & { pathSegments: string[] }> = [];
  const roots: ParsedSection[] = [];
  let bodyBuffer: RootContent[] = [];
  let inTitle = false;
  let titleFlushed = false;

  // Build a map of heading node → 0-based line number using mdast position
  const headingLineMap = new Map<Heading, number>();
  for (const node of nodes) {
    if (node.type === "heading" && node.position) {
      headingLineMap.set(node as Heading, node.position.start.line - 1);
    }
  }

  // All heading lines in document order
  const allHeadingLines: Array<{ line: number; level: number }> = [];
  for (const node of nodes) {
    if (node.type === "heading" && node.position) {
      allHeadingLines.push({ line: node.position.start.line - 1, level: node.depth });
    }
  }

  const flushBuffer = () => {
    const text = nodesToMarkdown(bodyBuffer);
    bodyBuffer = [];
    return text;
  };

  const sectionOrder: Array<ParsedSection & { pathSegments: string[]; _hline: number }> = [];

  for (const node of nodes) {
    if (node.type === "heading") {
      const level = node.depth;
      const text = headingText(node as Heading);
      const hline = headingLineMap.get(node as Heading) ?? 0;

      if (level === 1) {
        description = flushBuffer();
        title = text;
        inTitle = true;
        titleFlushed = false;
        continue;
      }

      const bodyText = flushBuffer();
      if (inTitle && !titleFlushed) { description = bodyText; inTitle = false; titleFlushed = true; }
      else if (sectionStack.length > 0) { sectionStack[sectionStack.length - 1].content = bodyText; }

      while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1].level >= level) {
        sectionStack.pop();
      }

      const parent = sectionStack[sectionStack.length - 1];
      const slug = slugify(text);
      const pathSegments = parent ? [...parent.pathSegments, slug] : [fileName, slug];

      const section: ParsedSection & { pathSegments: string[]; _hline: number } = {
        path: pathSegments.join("/"),
        heading: text,
        level,
        content: "",
        children: [],
        pathSegments,
        _hline: hline,
        headingLine: hline,
        bodyStartLine: hline + 1,
        bodyEndLine: 0,
        sectionEndLine: 0,
      };

      if (parent) parent.children.push(section);
      else roots.push(section);
      sectionStack.push(section);
      sectionOrder.push(section);
    } else {
      bodyBuffer.push(node);
    }
  }

  const finalBody = flushBuffer();
  if (inTitle && !titleFlushed) description = finalBody;
  else if (sectionStack.length > 0) sectionStack[sectionStack.length - 1].content = finalBody;
  else if (!title) description = finalBody;

  // Compute bodyEndLine and sectionEndLine for each section
  const totalLines = lines.length;
  for (let i = 0; i < sectionOrder.length; i++) {
    const s = sectionOrder[i];
    const sLine = s._hline;

    let sectionEnd = totalLines;
    for (const h of allHeadingLines) {
      if (h.line > sLine && h.level <= s.level) { sectionEnd = h.line; break; }
    }
    s.sectionEndLine = sectionEnd;

    let bodyEnd = sectionEnd;
    for (const h of allHeadingLines) {
      if (h.line > sLine && h.line < sectionEnd && h.level > s.level) { bodyEnd = h.line; break; }
    }
    s.bodyEndLine = bodyEnd;
  }

  return { title, description, sections: roots };
}

/** Flatten a section tree into document order (depth-first). */
export function flattenSections(sections: ParsedSection[]): ParsedSection[] {
  const result: ParsedSection[] = [];
  function walk(s: ParsedSection) {
    result.push(s);
    for (const child of s.children) walk(child);
  }
  for (const s of sections) walk(s);
  return result;
}
