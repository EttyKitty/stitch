import { GameMakerIde } from '@bscotch/stitch-launcher';
import vscode from 'vscode';
import { stitchConfig } from './config.mjs';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { registerCommand, showProgress } from './lib.mjs';
import { compile } from './releasePicker.template.mjs';

export class StitchReleasePickerProvider {
  public panel: vscode.WebviewPanel | undefined;

  constructor(readonly workspace: StitchWorkspace) {}

  get projects() {
    // Sort alphabetically, but with active runner first.
    const runners = [...this.workspace.runners];
    const active = this.workspace.getActiveRunner();
    runners.sort((a, b) => {
      if (a === active) return -1;
      if (b === active) return 1;
      return a.name.localeCompare(b.name);
    });
    return runners;
  }

  protected async getWebviewContent() {
    const releases = await StitchReleasePickerProvider.listReleases();
    return compile(releases, this.projects as any, stitchConfig.releaseNotesChannels);
  }

  protected createPanel(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      'stitch-release-picker',
      'GameMaker Version Picker',
      vscode.ViewColumn.Active,
      { enableScripts: true, enableFindWidget: true },
    );
    panel.webview.onDidReceiveMessage(
      async (
        message:
          | {
              type: 'setVersion';
              version: string;
            }
          | { type: 'openChannelsSetting' },
      ) => {
        if (message.type === 'openChannelsSetting') {
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'stitch.gameMaker.releases.notes.channels',
          );
          // Dispose of the panel so it will be rebuilt
          this.panel?.dispose();
          return;
        } else if (message.type === 'setVersion') {
          const runner = await this.workspace.chooseRunner();
          if (!runner) return;
          await runner.setIdeVersion(message.version);
          this.revealPanel();
        }
      },
    );
    return panel;
  }

  async revealPanel() {
    this.panel ||= this.createPanel();
    this.panel.onDidDispose(() => (this.panel = undefined));
    // Rebuild the webview
    this.panel.webview.html = await this.getWebviewContent();
    this.panel.reveal();
  }

  static async listReleases() {
    const releases = await showProgress(
      () => GameMakerIde.listReleases(),
      `Fetching GameMaker release notes...`,
    );
    return releases.filter((release) =>
      stitchConfig.releaseNotesChannels.includes(release.channel),
    );
  }

  static register(workspace: StitchWorkspace) {
    const releasesProvider = new StitchReleasePickerProvider(workspace);
    return [
      registerCommand('stitch.setGameMakerVersion', async () => {
        await releasesProvider.revealPanel();
      }),
    ];
  }
}
