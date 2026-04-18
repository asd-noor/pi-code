# TypeScript

## TypeScript 5.7

TypeScript 5.7 was released in November 2024, bringing significant improvements to developer experience, type safety, and performance.

**Key Information:**
- Release Date: November 2024
- Installation: `npm install -D typescript@5.7`
- Major Focus: Error detection, direct TS execution, ECMAScript 2024 support

**Official Sources:**
- Release Notes: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-7.html
- Blog Announcement: https://devblogs.microsoft.com/typescript/announcing-typescript-5-7/
- InfoWorld Article: https://www.infoworld.com/article/3557641/typescript-5-7-arrives-with-improved-error-reporting.html
- UnravelJS Coverage: https://www.unraveljs.com/updates/2026-02-08-typescript-5-7-released

### Never-Initialized Variables

Improved detection of never-initialized variables. Previously failed when variables accessed in nested functions.

**What's New:**
- Reports errors when variables *never* initialized (not just possibly uninitialized)
- Example: `let result: number; function print() { console.log(result); }` now errors

**Source:** https://github.com/microsoft/TypeScript/pull/55887 (contributor: Zzzen)

### Path Rewriting

New `--rewriteRelativeImportExtensions` compiler option.

**What it does:**
- Rewrites relative import paths from TS to JS extensions during compilation
- `import * as foo from "./foo.ts"` → `import * as foo from "./foo.js"`
- Only rewrites relative paths (starts with `./` or `../`)
- Enables running `.ts` files in-place AND compiling to `.js` for distribution

**Limitations:**
- Doesn't rewrite non-relative imports, baseUrl/paths, or package.json exports/imports
- Dynamic imports not rewritten

**Use Case:** Library authors can test TS files directly but publish JS files.

**Source:** https://github.com/microsoft/TypeScript/pull/59767

### ECMAScript 2024 Support

New `--target es2024` and `--lib es2024` compiler options.

**New APIs:**
- Object.groupBy() - Group iterable elements
- Map.groupBy() - Group map elements
- Promise.withResolvers() - Better promise handling with improved type inference
- Enhanced SharedArrayBuffer and ArrayBuffer support
- Atomics.waitAsync (moved from es2022)

**Breaking Change:**
TypedArrays (like Uint8Array) now generic over ArrayBufferLike. May need to update @types/node.

**Sources:**
- https://github.com/microsoft/TypeScript/pull/58573
- https://github.com/microsoft/TypeScript/pull/59417
- Contributor: Kenta Moriuchi

### Performance Improvements

**V8 Compile Caching:**
- Leverages Node.js 22+ `module.enableCompileCache()` API
- 2.5x faster `tsc --version` (48ms vs 122ms)
- Reuses parsing and compilation work between runs

**General Compilation:**
- Up to 15% faster on large codebases
- Optimizations for composite projects and monorepos

**Source:** https://github.com/microsoft/TypeScript/pull/59720

### Editor Improvements

**Ancestor Configuration Search:**
TSServer now continues walking directory tree to find appropriate tsconfig.json files, enabling more flexible project organization.

**Faster Composite Project Checks:**
When probing composite projects, TypeScript only checks root set of files (not all transitively referenced files), dramatically faster for large codebases.

**Impact:** Much faster editor startup in large monorepos.

**Sources:**
- https://github.com/microsoft/TypeScript/pull/57196
- https://github.com/microsoft/TypeScript/pull/59688

### JSON Imports Validation

Under `--module nodenext`, JSON imports now:
- Require `with { type: "json" }` import attribute
- Only accessible via default import (no named exports)
- Example: `import myConfig from "./config.json" with { type: "json" };`

**Source:** https://github.com/microsoft/TypeScript/pull/60019

### Type System Improvements

**Index Signatures from Computed Properties:**
Classes with computed symbol property names now generate proper index signatures, matching object literal behavior.

**More Implicit any Errors:**
Function expressions returning null/undefined now trigger implicit any errors under noImplicitAny (even without strictNullChecks).

**Other Improvements:**
- Stricter never type checking
- readonly modifier for mapped types
- Improved Promise.withResolvers() type inference

**Sources:**
- https://github.com/microsoft/TypeScript/pull/59860
- https://github.com/microsoft/TypeScript/pull/59661
- https://www.unraveljs.com/updates/2026-02-08-typescript-5-7-released

### Breaking Changes

**1. TypedArrays Now Generic**
All TypedArray types generic over ArrayBufferLike. Update @types/node if you see Buffer assignability errors.

**2. lib.d.ts DOM Changes**
DOM type definitions may have changed. See: https://github.com/microsoft/TypeScript/pull/60061

**3. Stricter Type Checking**
- Stricter never type resolution
- More implicit any errors
- --moduleResolution bundler behavior changes

**4. Generic Constraint Inference**
More accurate but may reveal existing type issues.

**Migration Tip:** Run `tsc --noEmit` before upgrading to check for issues.

**Source:** https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-7.html

### New Compiler Options

**--rewriteRelativeImportExtensions**
Rewrites relative import paths from TS to JS extensions. See: Path Rewriting section.

**--target es2024**
Enables targeting ECMAScript 2024 runtimes.

**--lib es2024**
Provides type definitions for ES2024 features (Object.groupBy, Map.groupBy, Promise.withResolvers, etc).

**Related Options:**
- `--allowImportingTsExtensions` - Allows importing .ts files (use with --rewriteRelativeImportExtensions)
- `--module nodenext` - Required for JSON import validation
