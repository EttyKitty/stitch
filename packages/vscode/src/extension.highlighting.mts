import { Reference, ReferenceableType } from '@bscotch/gml-parser';
import { literal } from '@bscotch/utility';
import vscode from 'vscode';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { locationOf } from './lib.mjs';
import { warn } from './log.mjs';
import {
  Signifier,
} from '@bscotch/gml-parser';

export type SemanticTokenType = (typeof semanticTokenTypes)[number];
export type SemanticTokenModifier = (typeof semanticTokenModifiers)[number];

const semanticTokenTypes = literal([
  'function',
  'variable',
  'enum',
  'macro',
  'class',
  'enumMember',
  'parameter',
  'property', // Self/instance variables
]);
const semanticTokenModifiers = literal([
  'readonly',
  'defaultLibrary',
  'declaration',
  'static',
  'deprecated',
  // Custom
  'local',
  'asset',
  'global',
]);

export const semanticTokensLegend = new vscode.SemanticTokensLegend(
  semanticTokenTypes,
  semanticTokenModifiers,
);

export class GameMakerSemanticTokenProvider
  implements vscode.DocumentSemanticTokensProvider
{
  constructor(readonly provider: StitchWorkspace) {}

  private _onDidChangeSemanticTokens: vscode.EventEmitter<void> =
    new vscode.EventEmitter();
  readonly onDidChangeSemanticTokens = this._onDidChangeSemanticTokens.event;

  refresh() {
    this._onDidChangeSemanticTokens.fire();
  }

  provideDocumentSemanticTokens(
    document: vscode.TextDocument,
  ): vscode.SemanticTokens | undefined {
    try {
      const file = this.provider.getGmlFile(document);
      if (!file) return;

      const tokensBuilder = new vscode.SemanticTokensBuilder(semanticTokensLegend);
      
      for (const ref of file.refs) {
        if (!ref.start || isNaN(ref.start.line) || !ref.end || isNaN(ref.end.line)) continue;

        const signifier = ref.item;
        if (signifier.name && ['self', 'other', 'noone', 'all', 'global'].includes(signifier.name)) continue;

        const range = locationOf(ref)!.range;
        const scopeLabel = getGmlScope(document, range, signifier);
        
        // Determine Base Token Type
        let tokenType = inferSemanticToken(ref); 
        const tokenModifiers = new Set<SemanticTokenModifier>();

        // Apply Modifiers and Type Overrides based on our verified Scope
        if (scopeLabel.includes('global')) {
          tokenModifiers.add('global');
        } else if (scopeLabel.includes('static')) {
          tokenModifiers.add('static');
          // Match your theme: statics are treated as properties
          if (tokenType === 'variable') tokenType = 'property';
        } else if (scopeLabel.includes('local') || scopeLabel === 'parameter') {
          tokenModifiers.add('local');
          if (scopeLabel === 'parameter') tokenType = 'parameter';
        } else if (scopeLabel === 'instance variable' || scopeLabel === 'method') {
          // Force instance variables to 'property' to fix shadowing
          if (tokenType === 'variable') tokenType = 'property';
          tokenModifiers.delete('global');
          tokenModifiers.delete('local');
        }

        // Asset & Native checks
        if (signifier.type.type.some(t => t.kind.startsWith('Asset.'))) {
          tokenModifiers.add('asset');
        }
        if (signifier.native) {
          tokenModifiers.add('defaultLibrary');
        }

        try {
          tokensBuilder.push(range, tokenType, [...tokenModifiers]);
        } catch (err) {
          warn('PUSH ERROR', err);
        }
      }
      return tokensBuilder.build();
    } catch (error) {
      warn('OUTER ERROR', error);
    }
    return;
  }

  register() {
    return vscode.languages.registerDocumentSemanticTokensProvider(
      { language: 'gml', scheme: 'file' }, // By excluding "git" scheme, we avoid wonky highlighting in the diff view
      this,
      semanticTokensLegend,
    );
  }
}

function inferSemanticToken(ref: Reference): SemanticTokenType {
  const signifier = ref.item;
  const functionType = signifier.getTypeByKind('Function');

  if (signifier.enum) {
    return 'enum';
  }
  if (signifier.enumMember) {
    return 'enumMember';
  }
  if (functionType?.isConstructor) {
    return 'class';
  }
  if (functionType) {
    return 'function';
  }
  if (signifier.macro) {
    return 'macro';
  }
  if (signifier.parameter) {
    return 'parameter';
  }
  if (signifier.instance && !!signifier.def) {
    return 'property';
  }
  return 'variable';
}

/** Clobbers conflicting, allowing e.g. overriding type modifiers with symbol modifiers. */
function inferSemanticModifiers(
  ref: Reference,
  modifiers = new Set<SemanticTokenModifier>(),
): Set<SemanticTokenModifier> {
  const signifier = ref.item;
  // const isDeclaration = signifier.def?.file && ref.isDef;

  // // If only the only reference is also the declaration,
  // // then this is an unused variable.
  // const unused = isDeclaration && signifier.refs.size === 1;
  // if (unused) {
  //   modifiers.add('deprecated');
  // }

  if (signifier.native) {
    modifiers.add('defaultLibrary');
  } else {
    // modifiers.delete('defaultLibrary');
  }

  if (signifier.global) {
    modifiers.add('global');
    modifiers.delete('local');
  }
  if (signifier.local) {
    modifiers.add('local');
    modifiers.delete('global');
  }

  if (!signifier.writable) {
    modifiers.add('readonly');
  } else {
    modifiers.delete('readonly');
  }

  if (signifier.static) {
    modifiers.add('static');
  } else {
    modifiers.delete('static');
  }
  return modifiers;
}

/**
 * Determines the GML-specific scope of a variable based on its prefix and metadata.
 */
export function getGmlScope(document: vscode.TextDocument, range: vscode.Range, signifier: Signifier): string {
  const lineText = document.lineAt(range.start.line).text;
  const prefix = lineText.substring(0, range.start.character);
  const isFunction = !!signifier.getTypeByKind('Function');

  // 1. Explicit Global Prefix (Always Global)
  if (prefix.match(/global\.\s*$/)) {
    return isFunction ? 'global function' : 'global variable';
  }

  // 2. Explicit Local/Static Declarations
  if (prefix.match(/\bstatic\s+$/)) return isFunction ? 'static method' : 'static variable';
  if (prefix.match(/\bvar\s+$/)) return isFunction ? 'local function' : 'local variable';

  // 3. Script Functions (Global without prefix)
  // We trust the indexer for functions because script functions don't need 'global.'
  if (signifier.global && isFunction) {
    return 'global function';
  }

  // 4. SHADOWING PROTECTION
  // If the indexer says it's global, but there's no 'global.' prefix and it's NOT a function,
  // then the indexer has incorrectly merged a local/instance var with a global one.
  if (signifier.global && !isFunction) {
    return 'instance variable';
  }

  // 5. Other Metadata Fallbacks
  if (signifier.parameter) return 'parameter';
  if (signifier.local) return isFunction ? 'local function' : 'local variable';
  if (signifier.static) return isFunction ? 'static method' : 'static variable';
  if (signifier.native) return isFunction ? 'native function' : 'native variable';

  // 6. Default
  return isFunction ? 'method' : 'instance variable';
}
