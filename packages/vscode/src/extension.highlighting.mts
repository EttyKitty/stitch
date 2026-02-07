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
  | 'instance'
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

      for (const ref of file.refs) {
        // Guard: Valid range
        if (!ref.start?.line || !ref.end?.line) continue;

        const signifier = ref.item;
        // Guard: Reserved keywords handled by TextMate grammar
        if (this.isReservedKeyword(signifier.name)) continue;

        const location = locationOf(ref);
        if (!location) continue;

        const { range } = location;
        const scope = resolveGmlScope(document, range, signifier);

        const tokenType = this.inferTokenType(ref, scope);
        const modifiers = this.inferModifiers(ref, scope);

        try {
          builder.push(range, tokenType, [...modifiers]);
        } catch (err) {
          // Likely overlapping tokens or invalid range
          warn('Token push failed', err);
        }
      }
      return builder.build();
    } catch (error) {
      warn('Semantic provider crashed', error);
      return;
    }
  }

  private isReservedKeyword(name?: string): boolean {
    return !!name && ['self', 'other', 'noone', 'all', 'global'].includes(name);
  }

  private inferTokenType(ref: Reference, scope: GmlScope): SemanticTokenType {
    const { item: signifier } = ref;
    const functionType = signifier.getTypeByKind('Function');

    if (signifier.enum) return 'enum';
    if (signifier.enumMember) return 'enumMember';
    if (functionType?.isConstructor) return 'class';
    if (functionType || scope === 'native') return 'function';
    if (signifier.macro) return 'macro';
    if (scope === 'parameter') return 'parameter';

    // Treat instance variables and statics as properties for theme consistency
    if (scope === 'instance' || scope === 'static') return 'property';

    return 'variable';
  }

  private inferModifiers(ref: Reference, scope: GmlScope): Set<SemanticTokenModifier> {
    const modifiers = new Set<SemanticTokenModifier>();
    const { item: signifier } = ref;

    if (scope === 'global') modifiers.add('global');
    if (scope === 'local' || scope === 'parameter') modifiers.add('local');
    if (scope === 'static') modifiers.add('static');

    if (signifier.native) modifiers.add('defaultLibrary');
    if (!signifier.writable) modifiers.add('readonly');

    if (signifier.type.type.some(t => t.kind.startsWith('Asset.'))) {
      modifiers.add('asset');
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
  document: vscode.TextDocument,
  range: vscode.Range,
  signifier: Signifier
): GmlScope {
  const lineText = document.lineAt(range.start.line).text;
  const prefix = lineText.substring(0, range.start.character);
  const isFunction = !!signifier.getTypeByKind('Function');

  if (prefix.match(/global\.\s*$/)) return 'global';
  if (prefix.match(/\bstatic\s+$/)) return 'static';
  if (prefix.match(/\bvar\s+$/)) return 'local';

  if (signifier.parameter) return 'parameter';
  if (signifier.native) return 'native';
  if (signifier.global && isFunction) return 'global';
  if (signifier.global && !isFunction) return 'instance';
  if (signifier.local) return 'local';
  if (signifier.static) return 'static';

  return 'instance';
}

