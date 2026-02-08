import vscode from 'vscode';
import { Signifier } from '@bscotch/gml-parser';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { resolveGmlScope, GmlScope } from './extension.highlighting.mjs';
import { locationOf } from './lib.mjs';

export class StitchHoverProvider implements vscode.HoverProvider {
  constructor(private readonly workspace: StitchWorkspace) { }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    const gmlFile = this.workspace.getGmlFile(document);
    const signifier = this.workspace.getSignifier(document, position);

    if (!signifier || !gmlFile) return;

    const ref = gmlFile.refs.find(r => locationOf(r)?.range.contains(position));
    const location = ref ? locationOf(ref) : undefined;
    
    let scope: GmlScope = 'property';
    if (location) {
      const lineText = document.lineAt(location.range.start.line).text;
      scope = resolveGmlScope(lineText, location.range, signifier);
    }

    const identityLabel = getScopeLabel(signifier, scope);
    const hoverContents = new vscode.MarkdownString();
    hoverContents.isTrusted = true;
    hoverContents.supportHtml = true;

    // --- 1. HEADER CONSTRUCTION ---
    let headerCode = '';
    if (signifier.macro) {
      let macroValue = '';
      const def = signifier.def;
      // Ensure we have a valid range and it's in the current document
      if (def && 'file' in def) {
        const loc = locationOf(def as any);
        if (loc && loc.uri.toString() === document.uri.toString()) {
          // Extract value from "#macro NAME VALUE"
          const lineText = document.lineAt(loc.range.start.line).text;
          macroValue = lineText.replace(/^#macro\s+\w+\s+/, '').trim();
        }
      }
      headerCode = `(macro) ${signifier.name}${macroValue ? ' ' + macroValue : ''}`;
    } else if (signifier.enum) {
      headerCode = `(enum) ${signifier.name}`;
    } else if (signifier.enumMember) {
      headerCode = `(enum member) ${signifier.name}`;
    } else {
      const typeStrings = signifier.type.type.map(t => {
        let code = t.code || 'any';
        if (t.kind === 'Function') {
          code = code.replace(/^function\s+/, '');
          const escapedName = signifier.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          code = code.replace(new RegExp(`^${escapedName}`, 'i'), '');
        }
        return code;
      });

      const typeDisplay = typeStrings.join(' | ');
      const separator = typeDisplay.startsWith('(') ? '' : ': ';
      headerCode = `(${identityLabel}) ${signifier.name}${separator}${typeDisplay}`;
    }

    hoverContents.appendCodeblock(headerCode, 'gml');

    // --- 2. DESCRIPTIONS ---
    if (signifier.description) {
      hoverContents.appendMarkdown(`${signifier.description}\n\n`);
    }

    // --- 3. TYPE DETAILS & ASSETS ---
    for (const type of signifier.type.type) {
      if (type.description) hoverContents.appendMarkdown(`${type.description}\n\n`);
      if (type.details) hoverContents.appendMarkdown(`${type.details}\n\n`);

      // Sprite Preview
      if (type.kind === 'Asset.GMSprite' && signifier.name) {
        const sprite = this.workspace.getAsset(document, signifier.name);
        const yy = sprite?.yy as any;
        if (sprite && yy?.frames) {
          hoverContents.baseUri = vscode.Uri.file(sprite.dir.absolute);
          const images = yy.frames
            .slice(0, 8) // Limit frames to prevent massive hovers
            .map((frame: any) => {
              const framePath = vscode.Uri.file(sprite.dir.join(`${frame.name}.png`).absolute);
              return `![${frame.name}](${framePath})`;
            })
            .join(' ');
          hoverContents.appendMarkdown(`${images}${yy.frames.length > 8 ? ' ...' : ''}\n\n`);
        }
      }
    }

    return new vscode.Hover(hoverContents);
  }

  static register(workspace: StitchWorkspace) {
    return vscode.languages.registerHoverProvider(
      { language: 'gml', scheme: 'file' },
      new StitchHoverProvider(workspace),
    );
  }
}

/** Converts the internal GmlScope to a human-readable label for Hovers */
export function getScopeLabel(signifier: Signifier, scope: GmlScope): string {
  const isFunction = !!signifier.getTypeByKind('Function');
  const isConstructor = signifier.getTypeByKind('Function')?.isConstructor;

  // 1. High Priority: Macros, Enums, Classes
  if (signifier.macro) return 'macro';
  if (signifier.enum) return 'enum';
  if (signifier.enumMember) return 'enum member';
  if (isConstructor) return 'class';

  // 2. Asset Detection (Prioritize over "instance variable")
  const assetType = signifier.type.type.find(t => t.kind.startsWith('Asset.'));
  if (assetType) {
    // Map 'Asset.GMObject' -> 'object', 'Asset.GMSprite' -> 'sprite', etc.
    return assetType.kind.split('.').pop()?.replace('GM', '').toLowerCase() || 'asset';
  }

  // 3. Native/Built-in Detection
  if (signifier.native || scope === 'native') {
    return isFunction ? 'native function' : 'native variable';
  }

  // 4. Function/Method Logic
  if (isFunction) {
    if (scope === 'global') return 'global function';
    if (scope === 'local') return 'local function';
    if (scope === 'static') return 'static method';
    return 'method';
  }

  // 5. Fallback to Scope Labels
  const labels: Record<GmlScope, string> = {
    global: 'global variable',
    static: 'static variable',
    local: 'local variable',
    parameter: 'parameter',
    property: 'property',
    native: 'native variable',
  };
  return labels[scope] ?? 'variable';
}