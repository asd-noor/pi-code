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
  { exts: [".c", ".h"],                             pkg: "tree-sitter-c" },
  // zig and lua dropped: their npm packages (tree-sitter-zig@0.2.0,
  // tree-sitter-lua@2.1.3) use the pre-v0.21 export format and cannot
  // be loaded under tree-sitter v0.25 ("Invalid language object").
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
      // tree-sitter v0.21+ wraps the native binding in { language, nodeTypeInfo }.
      // Old-format packages that expose the binding directly won't have .language
      // and fail with "Invalid language object" when used with Parser.Query.
      // Treat absence of .language as a package incompatibility and skip.
      if (lang.language === undefined) {
        log?.(`skipping ${pkg}: no .language binding — package incompatible with tree-sitter v0.25`);
        continue;
      }
      for (const ext of exts) {
        languages.set(ext, lang);
      }
    } catch (_) {
      // Skip grammars that failed to load — graceful degradation
    }
  }

  return { Parser, languages };
}
