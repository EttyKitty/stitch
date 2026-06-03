# AGENT INSTRUCTIONS

> **⚠️ URGENT: This document must be updated immediately if any statement herein becomes inaccurate. Outdated AGENTS.md is worse than none.**

## Brief Project Overview

Stitch is a GameMaker pipeline development kit by [Butterscotch Shenanigans](https://bscotch.net). This monorepo contains tools for managing GameMaker projects: code parsing, project modeling, asset manipulation, and a VSCode extension providing IDE features for GML (GameMaker Language).

Primary active packages:
- **`packages/parser`** (`@bscotch/gml-parser`) — GML parser and project modeler
- **`packages/vscode`** (`etty-stitch-vscode`) — VSCode extension

Other packages (`yy`, `sprite-source`, `launcher`, `config`, `releases`, etc.) exist as dependencies and are rarely modified directly.

Source of truth for project scope: README.md, package.json definitions, and the `Project` class in `parser/src/project.ts`.

---

## Project Context

### Why it exists
Bscotch develops and ships multiple GameMaker games. The GameMaker IDE lacks programmatic tooling — no way to parse GML externally, no CLI for asset management, no extension points for code analysis. Stitch fills that gap.

### Problems it solves
- No existing GML parser outside GameMaker's internal one
- No way to query project structure (scripts, objects, rooms, sprites) programmatically
- No VSCode extension for GML with features like go-to-definition, hover info, completions, diagnostics
- No automated asset import/management pipelines for GameMaker projects
- No way to run GameMaker projects from VSCode

### How it should work
1. **Parser**: Load a GameMaker project (`.yyp` file) → read all assets → parse GML code using a CST parser (chevrotain) → build a type system with scopes and references → emit diagnostics
2. **VSCode**: Activate extension → find `.yyp` files → create `Project` instances → register VSCode providers (hover, completions, definitions, references, rename, symbols, etc.) that use the parser's API → display diagnostics in-editor

### User experience goals
- VSCode feels like a first-class GML editor: syntax highlighting, semantic tokens, error squiggles, go-to-definition, find references, autocomplete, hover docs, rename symbol
- Stitch Runner: run GameMaker projects from VSCode with output in a terminal/webview
- Asset tree sidebar: browse and manage GameMaker assets without opening the IDE
- Sprite source management: watch folders for sprite changes and auto-import

---

## System Patterns

### Architecture

```
┌─────────────────────────────┐
│     VSCode Extension        │
│  (extension.workspace.mts)  │
│                             │
│  StitchWorkspace            │
│   ├─ GameMakerProject[]     │
│   ├─ GameMakerRunner[]      │
│   └─ Providers:             │
│       hover, completions,   │
│       definitions, refs,    │
│       rename, symbols, ...  │
└──────────┬──────────────────┘
┌──────────▼──────────────────┐
│     @bscotch/gml-parser     │
│  (packages/parser)          │
│                             │
│  Project                    │
│   ├─ Native (spec)          │
│   ├─ Asset[]                │
│   ├─ Code (per asset file)  │
│   ├─ Type system            │
│   └─ Diagnostics            │
└──────────┬──────────────────┘
┌──────────▼──────────────────┐
│     @bscotch/yy             │
│  (packages/yy)              │
│  yy/yyp file types & schemas│
└─────────────────────────────┘
```

### Key technical decisions

1. **Chevrotain for parsing**: GML grammar defined as a chevrotain `CstParser` subclass (`GmlParser`). Produces a CST (Concrete Syntax Tree) with full position info. No AST step — CST is used directly via visitors.

2. **Visitor pattern**: `GmlVisitor` extends chevrotain's auto-generated visitor. Each visitor method handles one CST node type. Key visitor methods:
   - `visitFunctionExpression` → registers function, params, return type
   - `visitIdentifierAccessor` → resolves references, creates Reference objects
   - `visitVariableAssignment` → registers variables, resolves types
   - `visitFunctionStatement` → creates function definition referencable entries
   - See `visitor.ts`, `visitor.assign.ts`, `visitor.functionExpression.ts`, `visitor.identifierAccessor.ts`

3. **Type system**: `Type<T>` class with `kind` discriminant (`Real`, `String`, `Bool`, `Array`, `Struct`, `Function`, `Enum`, `Pointer`, `Any`, `Unknown`, `Undefined`). `TypeStore` wraps collections of types. `StructType` has named members (child `TypeStore`s). Feather strings (`types.feather.ts`) allow type serialization/deserialization.

4. **Scopes and references**: `Scope` class tracks named scopes (global, file, function, block, struct). `Reference` objects connect usages to definitions with position info. `Signifier` represents named symbols with type info and flags.

5. **Dirty file queue**: Code changes trigger re-parse via `dirtyFiles` set. `drainDirtyFileUpdateQueue()` re-processes each dirty file fully (not just diagnostics), preventing gradual state degradation.

6. **VSCode providers pattern**: Each language feature is a separate file:
   - `extension.hover.mts` — HoverProvider
   - `extension.completions.mts` — CompletionItemProvider
   - `extension.definitions.mts` — DefinitionProvider
   - `extension.refs.mts` — ReferenceProvider
   - `extension.rename.mts` — RenameProvider
   - `extension.symbols.mts` — WorkspaceSymbolProvider
   - `extension.highlighting.mts` — SemanticTokensProvider
   - `extension.formatting.mts` — DocumentFormattingEditProvider
   - `extension.lens.mts` — CodeLensProvider
   - `extension.typeDefs.mts` — TypeDefinitionProvider
   - `extension.locations.mts` — LocationProvider

### Critical implementation paths

1. **Parsing flow**: `Code.reload()` → `Project.parseCode()` → `GmlLexer.tokenize()` → `GmlParser.parse()` → `GmlVisitor.visit()` → register signifiers, resolve types, collect references → emit diagnostics
2. **Diagnostics flow**: Parse → collect `GmlParseError[]` + type errors → emit via `onDiagnostics` callback → VSCode translates to `DiagnosticCollection`
3. **Go-to-definition**: User clicks symbol → `StitchDefinitionsProvider` → `Code.findReferences()` → filter by definition → return `Location`
4. **Hover**: User hovers → `StitchHoverProvider` → find Signifier at position → `typeToHoverText()` → format with documentation

---

## Tech Context

### Technologies

| Layer | Technology |
|-------|-----------|
| Monorepo | pnpm workspaces |
| Language | TypeScript (strict) |
| Parser generator | chevrotain 11.1.0 |
| GML file types | `@bscotch/yy` (schemas for .yy/.yyp) |
| Validation | zod |
| Source transforms | magic-string |
| VSCode | Extension API, webviews |
| Webview UI | Svelte (in `packages/vscode/webviews`) |
| TextMate grammars | YAML → JSON (custom build script) |
| Testing | mocha + chai |
| Linting | ESLint |
| Formatting | Prettier |

### Key commands

| Command | Description |
|---------|-------------|
| `pnpm build:all` | Build all packages |
| `pnpm test` (in parser) | Run parser tests |
| `pnpm watch` (in vscode) | Watch for changes, rebuild |
| `pnpm package` (in vscode) | Package .vsix |

### Dependencies

**Parser** (`packages/parser`):
- `chevrotain` — CST parser engine
- `@bscotch/yy` — GameMaker .yy/.yyp file types
- `@bscotch/stitch-config` — Stitch config schema
- `@bscotch/stitch-launcher` — GameMaker IDE launcher utilities
- `@bscotch/gamemaker-releases` — Release version info
- `@bscotch/pathy` — Typed file paths
- `@bscotch/utility` — General utilities
- `magic-string` — Source code string manipulation
- `xml2js` — Legacy format parsing
- `zod` — Runtime validation

**VSCode** (`packages/vscode`):
- Depends on `@bscotch/gml-parser` (parser), `@bscotch/yy`, `@bscotch/sprite-source`, `@bscotch/stitch-launcher`, `@bscotch/stitch-config`
- VSCode API (types defined in `@types/vscode`)
- Grammar: custom TextMate grammar (`syntaxes/gml.tmLanguage.yaml`)
- Build: custom Node.js build script, not webpack/vite

### Package relationships (rarely touched)

| Package | Purpose | Used by |
|---------|---------|---------|
| `packages/yy` | .yy/.yyp schemas, validation | parser, vscode, many |
| `packages/config` | stitch.config.json schema | parser, vscode, launcher |
| `packages/launcher` | GameMaker IDE install/launch | parser, vscode |
| `packages/sprite-source` | Sprite asset pipelines | vscode |
| `packages/releases` | Merged GameMaker release notes | vscode |
| `packages/gcdata` | GameMaker constants data | parser |
| `packages/site` | Documentation site | — |
| `packages/chrome-ext-game-stats` | Chrome extension | — |
| `packages/cl2-editor` | Legacy editor | — |
| `packages/steam-bbcode` | Steam BBCode utilities | — |

---

## Files to know

### Parser (`packages/parser/src/`)

| File | Role |
|------|------|
| `parser.ts` | `GmlParser` class — chevrotain grammar rules for all GML constructs |
| `lexer.ts` | `GmlLexer` — token definitions (keywords, operators, literals, etc.) |
| `project.ts` | `Project` class — orchestrates loading GameMaker projects, manages assets, types, native symbols |
| `project.code.ts` | `Code` class — single GML file: parse, resolve references, get diagnostics |
| `project.asset.ts` | `Asset` class — a GameMaker resource (script, object, sprite, etc.) |
| `project.diagnostics.ts` | Diagnostic types and error reporting |
| `project.location.ts` | `Scope`, `Reference`, `Position`, `Range` |
| `project.native.ts` | `Native` — loads GameMaker built-in functions/constants/enums from spec |
| `visitor.ts` | `GmlVisitor` — CST visitor that builds types, signifiers, references |
| `visitor.assign.ts` | Assignment-specific visitor logic |
| `visitor.functionExpression.ts` | Function expression visitor logic |
| `visitor.identifierAccessor.ts` | Identifier accessor (member access) visitor logic |
| `visitor.globals.ts` | Global variable/resolution visitor logic |
| `visitor.processor.ts` | Post-parse processing |
| `types.ts` | `Type`, `TypeStore`, `StructType` — type system core |
| `types.checks.ts` | Type checking utilities |
| `types.feather.ts` | Feather string type serialization |
| `types.primitives.ts` | Primitive type constants |
| `types.hover.ts` | Type-to-hover-text formatting |
| `types.sprites.ts` | Sprite-specific type utilities |
| `signifiers.ts` | `Signifier` — named symbol with type + flags |
| `signifiers.flags.ts` | Signifier flag constants |
| `tokens.ts` | Token re-exports and token category definitions |
| `tokens.code.ts` | All GML token definitions as chevrotain createToken calls |
| `modules.ts` | Asset import/export modules |
| `modules.types.ts` | Module type definitions |
| `jsdoc.ts` | JSDoc parsing |
| `jsdoc.feather.ts` | JSDoc ↔ Feather string conversion |
| `spine.ts` | Spine animation support |
| `util.ts` | Assertions, path utilities |
| `logger.ts` | Logger interface |

### VSCode (`packages/vscode/src/`)

| File | Role |
|------|------|
| `extension.ts` | Entry point — activates via `StitchWorkspace.activate()` |
| `extension.workspace.mts` | `StitchWorkspace` — central orchestrator: manages projects, runners, providers |
| `extension.activate.mts` | Registers all providers, commands, views during activation |
| `extension.project.mts` | `GameMakerProject` — wraps parser `Project` for VSCode lifecycle |
| `extension.runner.mts` | `GameMakerRunner` — runs GameMaker projects from VSCode |
| `extension.hover.mts` | Hover provider |
| `extension.completions.mts` | Autocomplete provider |
| `extension.definitions.mts` | Go-to-definition provider |
| `extension.refs.mts` | Find references provider |
| `extension.rename.mts` | Rename symbol provider |
| `extension.symbols.mts` | Workspace symbol provider |
| `extension.highlighting.mts` | Semantic token provider |
| `extension.formatting.mts` | .yy/.yyp formatting provider |
| `extension.lens.mts` | Code lens provider |
| `extension.typeDefs.mts` | Type definition provider |
| `extension.locations.mts` | Location provider |
| `extension.copyType.mts` | Copy type as text commands |
| `diagnostics.mts` | VSCode diagnostic collection integration |
| `tree.mts` | Asset tree view |
| `tree.folder.mts` | Folder tree view |
| `tree.items.mts` | Tree item definitions |
| `inspector.mts` | Object inspector view |
| `spriteSources.mts` | Sprite source tree view |
| `webview.igor.mts` | Runner output webview |
| `webviews.spriteEditor.mts` | Sprite editor webview |
| `config.mts` | Stitch config access |
| `lib.mts` | Shared utilities |
| `log.mts` | Logging |
| `events.mts` | Event system |
| `changes.mts` | External change tracking |
| `manifest.mts` | Extension manifest helpers |
| `manifest.commands.mts` | Command definitions from manifest |
| `manifest.types.mts` | Manifest type definitions |
| `manifest.update.mts` | Manifest update script |
| `manifest.when.mts` | When clause helpers |

### VSCode webviews (`packages/vscode/webviews/`)

Svelte-based webview applications for sprite editor and runner.

---

## Development notes

- **Parser tests** use mocha with `--parallel=false` (tests share state via `Project`). Run from `packages/parser`: `pnpm test`
- **VSCode extension** must be built before debugging (F5 launches pre-built extension). Use `pnpm watch` for auto-rebuild.
- **Grammar** defined in YAML (`syntaxes/gml.tmLanguage.yaml`), converted to JSON during build. Edit YAML, then rebuild.
- **Package naming**: npm packages use `@bscotch/` scope. The VSCode extension publisher is `etty`.
- **Build pipeline**: Each package builds independently via `tsc`. The VSCode extension additionally runs custom build scripts (grammar conversion, schema generation, manifest update).