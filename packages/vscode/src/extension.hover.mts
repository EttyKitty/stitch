import { YySprite } from '@bscotch/yy';
import vscode from 'vscode';
import { assertUserClaim } from './assert.mjs';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { getGmlScope } from './extension.highlighting.mjs';
import { locationOf } from './lib.mjs';

export class StitchHoverProvider implements vscode.HoverProvider {
  protected constructor(readonly provider: StitchWorkspace) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.ProviderResult<vscode.Hover> {
    const gmlFile = this.provider.getGmlFile(document);
    const item = this.provider.getSignifier(document, position);
    if (!item || !gmlFile) return;
  
    // Find the specific reference at this position to determine scope
    const offset = document.offsetAt(position);
    const ref = gmlFile.refs.find(r => {
        const range = locationOf(r)?.range;
        if (!range) return false;
        const start = document.offsetAt(range.start);
        const end = document.offsetAt(range.end);
        return offset >= start && offset <= end;
    });

    // Determine scope label
    const scopeLabel = ref 
        ? getGmlScope(document, locationOf(ref)!.range, item)
        : 'variable';

    const hoverContents = new vscode.MarkdownString();
    const codeBlocks = new Set<string>();
    const textBlocks = new Set<string>();

    if (item.description) {
      textBlocks.add(item.description);
    }

    // Process Types
    if (item.type.type.length === 0) {
      codeBlocks.add(`(${scopeLabel}) ${item.name}: any`);
    } else {
      for (const type of item.type.type) {
        // We format the code block to include the scope and variable name
        const typeCode = type.code || 'any';
        codeBlocks.add(`(${scopeLabel}) ${item.name}: ${typeCode}`);
        
        if (type.description) textBlocks.add(type.description);
        if (type.details) textBlocks.add(type.details);

        // Sprite Preview Logic (Keep your existing implementation)
        const sprite = type.kind === 'Asset.GMSprite' && item.name && this.provider.getAsset(document, item.name);
        if (sprite) {
          hoverContents.isTrusted = true;
          hoverContents.baseUri = vscode.Uri.file(sprite.dir.absolute);
          hoverContents.supportHtml = true;
          const yy = sprite.yy as any;
          let images = '';
          for (const frame of yy.frames) {
            const framePath = vscode.Uri.file(sprite.dir.join(`${frame.name}.png`).absolute);
            images += `![Sprite subimage](${framePath})`;
          }
          textBlocks.add(images);
        }
      }
    }

    if (!codeBlocks.size && !textBlocks.size) return;

    for (const code of codeBlocks) {
      hoverContents.appendCodeblock(code, 'gml');
    }
    for (const text of textBlocks) {
      hoverContents.appendMarkdown(text + '\n\n');
    }

    return new vscode.Hover(hoverContents);
  }

  static register(provider: StitchWorkspace) {
    return vscode.languages.registerHoverProvider(
      { language: 'gml', scheme: 'file' },
      new StitchHoverProvider(provider),
    );
  }
}
