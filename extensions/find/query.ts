import path from "node:path";

export function normalizePathConstraint(
  pathConstraint: string,
  cwd = process.cwd(),
): string | null {
  let trimmed = pathConstraint.trim();
  if (!trimmed) return trimmed;

  if (path.isAbsolute(trimmed)) {
    const relative = path.relative(cwd, trimmed).replaceAll(path.sep, "/");
    if (relative === "") return null;
    if (relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) {
      throw new Error(
        `Path constraint must be relative to the workspace: ${pathConstraint}`,
      );
    }
    trimmed = relative;
  }

  if (trimmed === "." || trimmed === "./") return null;
  if (trimmed.startsWith("./")) trimmed = trimmed.slice(2);

  // Collapse trailing recursive dir globs (`.agents/**`) to a dir-prefix
  // constraint the parser understands. Keep real file globs like `src/**/*.ts`.
  const recursiveDir = trimmed.match(/^(.*)\/\*\*(?:\/\*)?$/);
  if (recursiveDir) {
    const dir = recursiveDir[1];
    if (dir && !/[*?[{]/.test(dir)) return `${dir}/`;
  }

  if (trimmed.startsWith("/") || trimmed.endsWith("/")) return trimmed;
  if (/[*?[{]/.test(trimmed)) return trimmed;
  const lastSegment = trimmed.split("/").pop() ?? "";
  if (/\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSegment)) return trimmed;
  return `${trimmed}/`;
}

export function normalizeExcludes(
  exclude: string | string[] | undefined,
  cwd = process.cwd(),
): string[] {
  if (!exclude) return [];
  const list = Array.isArray(exclude) ? exclude : [exclude];
  const out: string[] = [];
  for (const raw of list) {
    const parts = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
      const stripped = p.startsWith("!") ? p.slice(1) : p;
      const normalized = normalizePathConstraint(stripped, cwd);
      if (normalized) out.push(`!${normalized}`);
    }
  }
  return out;
}

export function buildQuery(
  filePath: string | undefined,
  pattern: string,
  exclude?: string | string[],
  cwd = process.cwd(),
): string {
  const parts: string[] = [];
  if (filePath) {
    const constraint = normalizePathConstraint(filePath, cwd);
    if (constraint) parts.push(constraint);
  }
  parts.push(...normalizeExcludes(exclude, cwd));
  parts.push(pattern);
  return parts.join(" ");
}
