
## Package Details

**Package Name**: `tree-sitter-zig`
**Latest Version**: 0.2.0
**Maintainer**: GrayJack (Eric Shimizu Karbstein <gr41.j4ck@gmail.com>)
**Repository**: https://github.com/GrayJack/tree-sitter-zig
**License**: BSD-3-Clause

**Key Dependencies**:
- Peer dependency: `tree-sitter@^0.21.0`
- Native bindings via `node-gyp-build`
- Uses `node-addon-api@^7.1.0` for native module

**Published Files**:
- grammar.js (tree-sitter grammar definition)
- bindings/node/* (compiled native bindings)
- queries/* (tree-sitter query files)
- src/* (native C++ source)

## Export Shape

**Entry Point**: `bindings/node` (native binding)
**CommonJS Export**: Direct Language object

```javascript
const zig = require('tree-sitter-zig');

// zig is a Language object:
// {
//   name: 'zig',
//   language: <WASM binary>,
//   nodeTypeInfo: [<node type metadata>]
// }
```

**Unlike** `tree-sitter-typescript` (which exports `{ typescript, tsx }`), tree-sitter-zig exports the language directly as a single object, not as a named export.

**TypeScript Definition**:
```typescript
declare const language: Language;
export = language;

type Language = {
  name: string;
  language: unknown;  // WASM binary
  nodeTypeInfo: NodeInfo[];
};
```

**Usage with tree-sitter**:
```javascript
const Parser = require('tree-sitter');
const Zig = require('tree-sitter-zig');

const parser = new Parser();
parser.setLanguage(Zig);
const tree = parser.parse(zigCode);
```

## Node Types Reference

**Top-Level Declarations** (used in const/var assignments):
- `struct_expression` — Struct type definition: `struct { ... }`
- `enum_expression` — Enum type: `enum { variants... }`
- `union_expression` — Union type: `union(TagType) { fields... }`
- `error_expression` — Error set: `error { ErrorName, ... }`

**Function Declarations**:
- `function_declaration` — Full function: `fn name(...) ReturnType { body }`
- `function_signature` — Function signature only (used with pub)
- `parameters` — Parameter list container
- `parameter` — Single parameter

**Test Declarations**:
- `test_expression` — Test block: `test "name" { ... }`

**Component Nodes**:
- `struct_expression` → `_struct_standalone` → `field_declaration` (nested)
- `field_declaration` — Struct/union field: `name: Type = default`
- `variant_declaration` — Enum variant: `name = value`
- `union_field_variant` — Union field variant

**Identifier Aliases** (specialized identifier nodes):
- `identifier` — Generic name (variables, functions)
- `type_identifier` — Type names
- `field_identifier` — Field access (`.field`)
- `enum_identifier` — Enum variant names (aliased identifier)
- `union_identifier` — Union field names (aliased identifier)
- `error_identifier` — Error names (aliased identifier)
- `label_identifier` — Loop labels

**Statement Containers**:
- `assignment_statement` — `const/var name = value;`
- `function_declaration` — Full function declaration
- `block` — Code block `{ ... }` (scope boundaries)
- `if_expression`, `while_expression`, `for_expression`, `test_expression` — Scoped blocks

**Comment Nodes**:
- `line_comment` — `// ...` comments
- `doc_comment` — `/// ...` documentation comments

## Tree-Sitter Query Examples (S-expressions)

**Function Declarations**
```scheme
; Capture function name and body
(function_declaration
  name: (identifier) @function.name
  body: (block) @function.definition) @function

; Capture function signatures separately
(function_signature
  name: (identifier) @function.name)
```

**Struct Definitions**
```scheme
; Capture struct assigned to const/var
(assignment_statement
  name: (identifier) @struct.name
  value: (struct_expression
    (field_declaration
      name: (identifier) @field.name
      type: (_) @field.type) @field)) @struct

; Simpler: just capture struct expression names
(struct_expression) @struct
```

**Enum Definitions**
```scheme
(assignment_statement
  name: (identifier) @enum.name
  value: (enum_expression
    (variant_declaration
      name: (identifier) @variant.name) @variant)) @enum
```

**Union Definitions**
```scheme
(assignment_statement
  name: (identifier) @union.name
  value: (union_expression
    (union_field_variant
      name: (identifier) @field.name) @field)) @union

; Capture tagged union tag type
(union_expression
  "(" @paren
  (type: (_) @tag.type)
  ")" @paren)
```

**Error Sets**
```scheme
(assignment_statement
  name: (identifier) @error.set.name
  value: (error_expression
    (error_identifier) @error.name)) @error_set
```

**Tests**
```scheme
(test_expression
  test_name: (string_literal) @test.name
  body: (block) @test.body) @test
```

**Key Capture Patterns** from `locals.scm`:
```scheme
; Define a symbol
(function_declaration
  name: (identifier) @definition.function)

; Reference a symbol
(identifier) @reference

; Define a variable
(assignment_statement
  name: (identifier) @definition.var)

; Scope boundaries
[
  (block)
  (if_expression)
  (while_expression)
  (for_expression)
  (test_expression)
] @scope
```

## Zig Language Server (ZLS)

**IMPORTANT CLARIFICATION**: The npm package `zls@1.0.0` is NOT the Zig Language Server—it's a Node CLI tool for listing directories. The actual ZLS is a separate project.

## Real ZLS (Zig Language Server)

**Repository**: https://github.com/zigtools/zls
**Language**: Zig (written in Zig, not JavaScript)
**Latest Release**: 0.16.0 (as of 2026-04-16)
**Distribution**: Prebuilt binaries (not npm)

**Binary Name**: `zls` (lowercase)

**Invocation**:
- **Standard LSP mode**: `zls --stdio` (reads JSON-RPC from stdin, writes to stdout)
- **Bare invocation**: `zls` (enters interactive mode or REPL)
- **Editor integration**: Most editors automatically invoke with `--stdio`

**Available Prebuilts** (0.16.0):
- x86_64-linux.tar.xz (887 downloads)
- x86_64-macos.tar.xz (26 downloads)
- x86_64-windows.zip (370 downloads)
- aarch64-macos.tar.xz (384 downloads)
- aarch64-linux.tar.xz (34 downloads)
- Plus builds for ARM, RISC-V, PowerPC64le, WebAssembly, s390x, loongarch64

**Installation**:
- Download from: https://github.com/zigtools/zls/releases
- Extract to system PATH or editor-specific location
- Editor auto-detection typically handles setup

**Features**:
- Completions
- Hover information
- Go to definition
- Find references
- Semantic analysis (work-in-progress)
- Supports comptime, using namespace, payload capture, custom packages, cImport
- Type function support

**LSP Compliance**: Full Language Server Protocol implementation

**Documentation**: https://zigtools.org/zls/install/ (editor setup and installation guide)

## Tagged Unions

**Zig Representation**:
```zig
const U = union(Tag) {
  int_value: i32,
  float_value: f32,
};
```

**Tree-Sitter Structure**:
Tagged unions are parsed as `union_expression` with:
- Optional `union_expression` with a tag type in parentheses: `"(" field("type", ...) ")"`
- Multiple `union_field_variant` children

**Grammar Rule**:
```javascript
union_expression: ($) =>
  seq(
    optional(alias(choice("packed", "extern"), $.union_modifier)),
    "union",
    optional(
      seq(
        "(",
        field("type", choice($._type, alias("enum", $.inference_type))),
        ")"
      )
    ),
    "{",
    field("field_variant", sepBy(",", $.union_field_variant)),
    optional(repeat($._statement)),
    "}"
  ),
```

**Tree-Sitter Query to Capture Tagged Unions**:
```scheme
; Capture union with explicit tag type
(assignment_statement
  name: (identifier) @union.name
  value: (union_expression
    "(" @tag.start
    type: (_) @tag.type
    ")" @tag.end
    (union_field_variant
      name: (identifier) @field.name
      type: (_) @field.type) @field)) @tagged_union

; Or simpler: identify by presence of tag
(union_expression
  "(" @has_tag) @tagged_union
```

**Differentiation from Regular Unions**:
- **Tagged union**: Has a tag type in parentheses `union(TagType) { ... }`
- **Regular union**: No tag `union { ... }`
- Both use `union_expression` node type; differentiate by presence of `"("` token after `"union"`
