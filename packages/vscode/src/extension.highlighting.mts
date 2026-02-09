import { Reference, Signifier } from '@bscotch/gml-parser';
import { literal } from '@bscotch/utility';
import vscode from 'vscode';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { locationOf } from './lib.mjs';
import { warn } from './log.mjs';

const semanticTokenTypes = literal([
  'function',
  'variable',
  'enum',
  'macro',
  'class',
  'enumMember',
  'parameter',
  'property',
]);

const semanticTokenModifiers = literal([
  'readonly',
  'defaultLibrary',
  'declaration',
  'static',
  'deprecated',
  'local',
  'asset',
  'global',
]);

const GLOBAL_PREFIX_RE = /global\.\s*$/;
const STATIC_PREFIX_RE = /\bstatic\s+$/;
const VAR_PREFIX_RE = /\bvar\s+$/;
const RESERVED_KEYWORDS = new Set(['self', 'other', 'noone', 'all', 'global']);

export type SemanticTokenType = (typeof semanticTokenTypes)[number];
export type SemanticTokenModifier = (typeof semanticTokenModifiers)[number];

export const semanticTokensLegend = new vscode.SemanticTokensLegend(
  [...semanticTokenTypes],
  [...semanticTokenModifiers],
);

/**
 * GML Scope categories to avoid magic strings.
 */
export type GmlScope =
  | 'global'
  | 'static'
  | 'local'
  | 'parameter'
  | 'property'
  | 'native';

export class GameMakerSemanticTokenProvider
  implements vscode.DocumentSemanticTokensProvider {
  constructor(private readonly workspace: StitchWorkspace) { }

  private _onDidChangeSemanticTokens = new vscode.EventEmitter<void>();
  readonly onDidChangeSemanticTokens = this._onDidChangeSemanticTokens.event;

  refresh(): void {
    this._onDidChangeSemanticTokens.fire();
  }

  provideDocumentSemanticTokens(
    document: vscode.TextDocument,
  ): vscode.SemanticTokens | undefined {
    try {
      const file = this.workspace.getGmlFile(document);
      if (!file) return;

      const builder = new vscode.SemanticTokensBuilder(semanticTokensLegend);
      const lineCache = new Map<number, string>();

      for (const ref of file.refs) {
        if (ref.start?.line === undefined || ref.end?.line === undefined) continue;

        const signifier = ref.item;
        // FIX: Guard against missing signifier (unresolved reference)
        if (signifier?.name && RESERVED_KEYWORDS.has(signifier.name)) continue;

        const location = locationOf(ref);
        if (!location) continue;

        const { range } = location;

        let lineText = lineCache.get(range.start.line);
        if (lineText === undefined) {
          lineText = document.lineAt(range.start.line).text;
          lineCache.set(range.start.line, lineText);
        }

        const scope = resolveGmlScope(lineText, range, signifier);
        const tokenType = this.inferTokenType(ref, scope);
        const modifiers = this.inferModifiers(ref, scope);

        try {
          builder.push(range, tokenType, [...modifiers]);
        } catch (error) {
          warn('Token push failed', error);
          continue; 
        }
      }
      return builder.build();
    } catch (error) {
      warn('Semantic provider crashed', error);
      return;
    }
  }

  private inferTokenType(ref: Reference, scope: GmlScope): SemanticTokenType {
    const { item: signifier } = ref;

    if (!signifier) return 'variable';
    if (signifier.enum) return 'enum';
    if (signifier.enumMember) return 'enumMember';
    if (signifier.getTypeByKind('Function')?.isConstructor) return 'class';
    const isFunction = !!signifier.getTypeByKind('Function');
    if (isFunction) return 'function';
    if (signifier.macro) return 'macro';
    if (scope === 'parameter') return 'parameter';
    if (signifier.asset) return 'variable';

    if (scope === 'property' || scope === 'static') {
      return 'property';
    }

    return 'variable';
  }

  private inferModifiers(ref: Reference, scope: GmlScope): Set<SemanticTokenModifier> {
    const modifiers = new Set<SemanticTokenModifier>();
    const { item: signifier } = ref;

    if (scope === 'global') modifiers.add('global');
    if (scope === 'local' || scope === 'parameter') modifiers.add('local');
    if (scope === 'static') modifiers.add('static');
    
    if (signifier) {
      // Native GML symbols (built-ins)
      if (signifier.native || scope === 'native') {
        modifiers.add('defaultLibrary');
      }
      
      // Assets (Objects, Sprites, etc)
      if (signifier.type.type.some(t => t.kind.startsWith('Asset.'))) {
        modifiers.add('asset');
        modifiers.add('readonly');
      }

      if (!signifier.writable || signifier.macro || signifier.enumMember) {
        modifiers.add('readonly');
      }
    }

    return modifiers;
  }

  register() {
    return vscode.languages.registerDocumentSemanticTokensProvider(
      { language: 'gml', scheme: 'file' },
      this,
      semanticTokensLegend,
    );
  }
}

export function resolveGmlScope(
  lineText: string,
  range: vscode.Range,
  signifier: Signifier
): GmlScope {
  const prefix = lineText.substring(0, range.start.character);
  const isFunction = !!signifier.getTypeByKind('Function');

  // 1. Syntax-based (Highest priority, handles shadowing)
  if (GLOBAL_PREFIX_RE.test(prefix)) return 'global';
  if (STATIC_PREFIX_RE.test(prefix)) return 'static';
  if (VAR_PREFIX_RE.test(prefix)) return 'local';

  // 2. Metadata-based
  if (signifier.asset) return 'global';
  if (signifier.parameter) return 'parameter';
  if (signifier.native) return 'native';
  if (signifier.global && isFunction) return 'global';
  
  // 3. Shadowing Protection
  if (signifier.global && !isFunction) return 'global';
  if (signifier.local) return 'local';
  if (signifier.static) return 'static';

  return 'property';
}
