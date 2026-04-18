/**
 * Public API surface for the tree-sitter module.
 */

export { isTreeSitterInstalled, installTreeSitter, getTreeSitterDir } from "./installer.ts";
export { loadGrammars, type LoadedGrammars }                          from "./loader.ts";
export { QUERIES, type LangQuery }                                     from "./queries.ts";
export { TreeSitterParser }                                            from "./parser.ts";
