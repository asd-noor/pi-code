import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { MemoryDB } from "../daemon/db.ts";
import { rescanLineNumbers } from "./scanner.ts";

function atomicWrite(filePath: string, lines: string[]): void {
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, lines.join("\n"), "utf8");
  renameSync(tmp, filePath);
}

function readLines(filePath: string): string[] {
  return readFileSync(filePath, "utf8").split("\n");
}

/**
 * Replace the immediate body of a section.
 * Splices lines [bodyStartLine, bodyEndLine) with the new body.
 * The heading and all child sections are untouched.
 */
export function updateSection(
  filePath: string,
  fileName: string,
  sectionPath: string,
  newBody: string,
  db: MemoryDB,
): void {
  const row = db.getSection(sectionPath);
  if (!row) throw new Error(`section not found: ${sectionPath}`);

  const lines = readLines(filePath);
  const newBodyLines = newBody.split("\n");

  lines.splice(
    row.bodyStartLine,
    row.bodyEndLine - row.bodyStartLine,
    "",
    ...newBodyLines,
    "",
  );

  atomicWrite(filePath, lines);
  rescanLineNumbers(filePath, fileName, db);
}

/**
 * Delete a section and its entire subtree.
 * Splices lines [headingLine, sectionEndLine) out of the file.
 */
export function deleteSection(
  filePath: string,
  fileName: string,
  sectionPath: string,
  db: MemoryDB,
): void {
  const row = db.getSection(sectionPath);
  if (!row) throw new Error(`section not found: ${sectionPath}`);

  const lines = readLines(filePath);
  lines.splice(row.headingLine, row.sectionEndLine - row.headingLine);

  atomicWrite(filePath, lines);
  // Remove from DB; the watcher will trigger a full re-index on mtime change
  db.deleteFile(fileName);
}

/**
 * Insert a new section.
 * If the parent section exists, inserts before the parent's first child.
 * If no parent (top-level ##), appends at end of file.
 */
export function newSection(
  filePath: string,
  fileName: string,
  sectionPath: string,
  heading: string,
  body: string,
  db: MemoryDB,
): void {
  if (db.getSection(sectionPath)) throw new Error(`section already exists: ${sectionPath}`);

  const segments = sectionPath.split("/");
  const level = segments.length; // fileName + path segments
  const headingMarker = "#".repeat(level);

  const newLines = [
    `${headingMarker} ${heading || segments[segments.length - 1]}`,
    "",
    ...body.split("\n"),
    "",
  ];

  const lines = readLines(filePath);

  const parentPath = segments.slice(0, -1).join("/");
  const parentRow = segments.length > 2 ? db.getSection(parentPath) : undefined;
  const insertAt = parentRow ? parentRow.bodyEndLine : lines.length;

  lines.splice(insertAt, 0, ...newLines);
  atomicWrite(filePath, lines);
  rescanLineNumbers(filePath, fileName, db);
}

/** Create a new .md file with a # title and optional description. Throws if it already exists. */
export function createFile(
  memDir: string,
  name: string,
  title: string,
  description: string,
): void {
  const filePath = join(memDir, `${name}.md`);
  if (existsSync(filePath)) throw new Error(`file already exists: ${name}`);
  const fileLines = [`# ${title}`, ""];
  if (description) fileLines.push(description, "");
  writeFileSync(filePath, fileLines.join("\n"), "utf8");
}
