/**
 * Tree-sitter S-expression queries for each supported language.
 *
 * Query convention:
 *   @name       — the symbol name node (used to extract .text)
 *   @def_KIND   — the definition node whose range becomes lineStart/lineEnd/colStart
 *                 KIND maps directly to the graph node kind:
 *                 function | method | constructor | class | interface |
 *                 struct   | enum   | typeParam
 *
 * The parser reads the kind from the capture name suffix (after "def_").
 * kindMap is provided for completeness but the parser uses capture-name routing.
 */

export interface LangQuery {
  query: string;
  /** node-type → kind fallback (used if capture name is just "@definition") */
  kindMap: Record<string, string>;
}

export const QUERIES: Record<string, LangQuery> = {
  // ── TypeScript ──────────────────────────────────────────────────────────────
  typescript: {
    kindMap: {},
    query: `
; Named functions
(function_declaration
  name: (identifier) @name) @def_function

; Arrow / function expressions assigned to const or let
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @def_function

; Classes
(class_declaration
  name: [(identifier) (type_identifier)] @name) @def_class

; Methods (covers get/set/regular; constructor handled in parser)
(method_definition
  name: [(property_identifier) (private_property_identifier)] @name) @def_method

; Interfaces
(interface_declaration
  name: (type_identifier) @name) @def_interface

; Type aliases
(type_alias_declaration
  name: (type_identifier) @name) @def_typeParam

; Enums
(enum_declaration
  name: (identifier) @name) @def_enum
`,
  },

  // ── JavaScript ─────────────────────────────────────────────────────────────
  javascript: {
    kindMap: {},
    query: `
; Named functions
(function_declaration
  name: (identifier) @name) @def_function

; Arrow / function expressions assigned to const or let
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @def_function

; Classes
(class_declaration
  name: (identifier) @name) @def_class

; Methods
(method_definition
  name: [(property_identifier) (private_property_identifier)] @name) @def_method
`,
  },

  // ── Python ─────────────────────────────────────────────────────────────────
  python: {
    kindMap: {},
    query: `
; Functions (includes methods — caller differentiates by context)
(function_definition
  name: (identifier) @name) @def_function

; Classes
(class_definition
  name: (identifier) @name) @def_class

; Decorated functions
(decorated_definition
  definition: (function_definition
    name: (identifier) @name)) @def_function

; Decorated classes
(decorated_definition
  definition: (class_definition
    name: (identifier) @name)) @def_class
`,
  },

  // ── Go ──────────────────────────────────────────────────────────────────────
  go: {
    kindMap: {},
    query: `
; Top-level functions
(function_declaration
  name: (identifier) @name) @def_function

; Methods (with receiver)
(method_declaration
  name: (field_identifier) @name) @def_method

; Struct types
(type_spec
  name: (type_identifier) @name
  type: (struct_type)) @def_struct

; Interface types
(type_spec
  name: (type_identifier) @name
  type: (interface_type)) @def_interface
`,
  },

};
