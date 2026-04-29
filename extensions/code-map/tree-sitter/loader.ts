/**
 * Dynamically loads tree-sitter and grammar packages from the cache dir
 * using absolute-path require() via createRequire — no bundled deps.
 */

import { createRequire } from "node:module";
import { join } from "node:path";

export interface LoadedGrammars {
  /** The tree-sitter Parser constructor. */
  Parser: any;
  /** Map from file extension (e.g. ".ts") to language object. */
  languages: Map<string, any>;
}

/**
 * Grammar packages and how to load each extension from them.
 * tree-sitter-typescript exports { typescript, tsx } — others export the language directly.
 */
const EXT_TO_PKG: Array<{ exts: string[]; pkg: string; key?: string }> = [
  { exts: [".ts"],                                 pkg: "tree-sitter-typescript", key: "typescript" },
  { exts: [".tsx"],                                pkg: "tree-sitter-typescript", key: "tsx" },
  { exts: [".js", ".jsx", ".mjs", ".cjs"],        pkg: "tree-sitter-javascript" },
  { exts: [".py"],                                 pkg: "tree-sitter-python" },
  { exts: [".go"],                                 pkg: "tree-sitter-go" },
  { exts: [".zig"],                                pkg: "tree-sitter-zig" },
  { exts: [".lua"],                                pkg: "tree-sitter-lua" },
];

/**
 * Load tree-sitter and all supported grammars from the given install directory.
 * Returns null if the core tree-sitter package cannot be loaded.
 * @param log  Optional callback to report the native load error for diagnostics.
 */
export function loadGrammars(tsDir: string, log?: (msg: string) => void): LoadedGrammars | null {
  // Create a require function rooted at tsDir/node_modules so that
  // "tree-sitter" resolves to the installed package (native addon).
  const req = createRequire(join(tsDir, "_loader.js"));

  let Parser: any;
  try {
    Parser = req("tree-sitter");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log?.(`tree-sitter native addon failed to load: ${reason}`);
    return null;
  }

  const languages = new Map<string, any>();

  for (const { exts, pkg, key } of EXT_TO_PKG) {
    try {
      const grammar = req(pkg);
      const lang = key ? grammar[key] : grammar;
      if (!lang) continue;
      for (const ext of exts) {
        languages.set(ext, lang);
      }
    } catch (_) {
      // Skip grammars that failed to load — graceful degradation
    }
  }

  return { Parser, languages };
}
