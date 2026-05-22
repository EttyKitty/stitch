import {
  GameMakerIde,
  GameMakerLauncher,
  GameMakerRuntime,
  computeGameMakerBuildCommand,
  computeGameMakerCleanCommand,
  stringifyGameMakerBuildCommand,
  stringifyGameMakerCleanCommand,
} from '@bscotch/stitch-launcher';
import {
  stitchConfigFilename,
  stitchConfigSchema,
  type StitchConfig,
} from '@bscotch/stitch-config';
import { Pathy, pathy } from '@bscotch/pathy';
import { Yy, type Yyp, type YypConfig } from '@bscotch/yy';
import vscode from 'vscode';
import { loudlyLogThrownAsync } from './assert.mjs';
import { stitchConfig } from './config.mjs';
import { stitchEvents } from './events.mjs';
import { killProjectRunner } from './lib.mjs';
import { logger, showErrorMessage } from './log.mjs';

export interface GameMakerRunnerOptions {
  onProgress?: (increment: number, message?: string) => void;
}

/**
 * Lightweight runner for GameMaker projects.
 * Reads only .yyp metadata — no GML parsing needed.
 */
export class GameMakerRunner {
  readonly dir: Pathy;
  readonly yypPath: Pathy;
  yyp!: Yyp;
  public runnerTerminal?: vscode.Terminal;

  protected constructor(
    yypPath: string,
    options?: GameMakerRunnerOptions,
  ) {
    this.yypPath = pathy(yypPath);
    this.dir = this.yypPath.up();
  }

  get name() {
    return this.yyp.name;
  }

  private _config?: StitchConfig;

  get config(): StitchConfig | undefined {
    return this._config;
  }

  get ideVersion(): string {
    return this.yyp.MetaData.IDEVersion;
  }

  /** List the names of the GameMaker configs defined by this project. */
  get configs(): string[] {
    const configs: string[] = [];
    const configTree: YypConfig[] = [...(this.yyp.configs?.children || [])];
    while (configTree.length) {
      const nextTree: YypConfig[] = [];
      for (const config of configTree) {
        configs.push(config.name);
        nextTree.push(...(config.children || []));
      }
      configTree.length = 0;
      configTree.push(...nextTree);
    }
    return configs;
  }

  async loadConfig() {
    const configFile = this.dir.join(stitchConfigFilename).withValidator(stitchConfigSchema);
    const exists = await configFile.exists();
    if (!exists) return;
    try {
      return await configFile.read();
    } catch {}
  }

  async openInIde() {
    stitchEvents.emit('open-project-start', this as any);
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Opening in GameMaker`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ increment: 0, message: 'Searching IDE installs...' });
        const ide = await GameMakerIde.findInstalled(this.ideVersion);
        if (!ide) {
          progress.report({ increment: 10, message: 'Version not found. Installing...' });
          await GameMakerIde.install(this.ideVersion);
        }
        progress.report({ increment: 90, message: 'Opening project...' });
        const runner = await GameMakerLauncher.openProject(
          this.yypPath.absolute,
          {
            ideVersion: this.yyp.MetaData.IDEVersion,
            disableUpdatePrompt: stitchConfig.disableGameMakerUpdatePrompt,
          },
        );
        progress.report({ increment: 100, message: 'Project opened!' });
        return runner;
      },
    );
  }

  async kill() {
    const windowTitle = await this.getWindowsName();
    if (windowTitle) {
      logger.info(`Attempting to kill running "${windowTitle}" instances...`);
      await killProjectRunner(windowTitle);
      logger.info('Finished killing running instances!');
    }
    this.runnerTerminal?.sendText('\x03');
    stitchEvents.emit('request-kill-project-in-webview');
  }

  async run(options?: {
    config?: string | null;
    compiler?: 'yyc' | 'vm';
    clean?: boolean;
  }) {
    if (stitchConfig.killOthersOnRun && !options?.clean) {
      await this.kill();
    }

    stitchEvents.emit(
      options?.clean ? 'clean-project-start' : 'run-project-start',
      this as any,
    );
    const config = options?.config ?? stitchConfig.runConfigDefault;
    let compiler = options?.compiler ?? stitchConfig.runCompilerDefault;
    if (['yyc', 'vm'].indexOf(compiler) === -1) {
      compiler = stitchConfig.runCompilerDefault;
    }

    logger.info(`Looking for GameMaker v${this.ideVersion}...`);
    const release = await GameMakerRuntime.findRelease({
      ideVersion: this.ideVersion,
    });
    if (!release) {
      showErrorMessage(
        `Could not find a release of GameMaker v${this.ideVersion} to run this project.`,
      );
      return;
    }
    logger.info(`Looking for runtime ${release.runtime.version}...`);
    const runtime = await GameMakerLauncher.findInstalledRuntime({
      version: release.runtime.version,
    });

    logger.info(`Found runtime? ${!!runtime}`);
    if (!runtime) {
      const installOptions = ['Yes', 'No'] as const;
      const chosenOption = await showErrorMessage(
        `The runtime for GameMaker v${this.ideVersion} is either not installed or not discoverable by Stitch. Do you want Stitch to install and launch GameMaker v${this.ideVersion} for you?`,
        ...installOptions,
      );
      if (chosenOption === 'Yes') {
        await this.openInIde();
        vscode.window.showInformationMessage(
          `GameMaker v${this.ideVersion} has been installed and opened. Once it's done installing its runtime you should be able to run your game from Stitch!`,
        );
      }
      return;
    }

    if (stitchConfig.runInTerminal) {
      logger.info(`Running Igor`, {
        igorPath: runtime.executablePath,
      });

      const cmd = await loudlyLogThrownAsync(
        async () =>
          await (
            options?.clean
              ? stringifyGameMakerCleanCommand
              : stringifyGameMakerBuildCommand
          )(runtime, {
            project: this.yypPath.absolute,
            config: config || undefined,
            yyc: compiler === 'yyc',
            noCache: false,
            quiet: true,
          }),
      );

      logger.info(`Igor command:`, JSON.stringify(cmd));

      if (
        !this.runnerTerminal ||
        this.runnerTerminal.exitStatus ||
        !stitchConfig.killOthersOnRun
      ) {
        this.runnerTerminal?.dispose();
        this.runnerTerminal = vscode.window.createTerminal({
          name: `GameMaker Runner`,
        });
      }
      this.runnerTerminal.sendText(cmd);
      this.runnerTerminal.show();
    } else {
      logger.info('Computing Igor command...');
      let { cmd, args } = await loudlyLogThrownAsync(
        async () =>
          await (
            options?.clean
              ? computeGameMakerCleanCommand
              : computeGameMakerBuildCommand
          )(runtime, {
            project: this.yypPath.absolute,
            config: config || undefined,
            yyc: compiler === 'yyc',
            noCache: false,
            quiet: true,
          }),
      );
      cmd = cmd.replace(/[/\\]/g, '/').replace(/ /g, '\\ ');
      logger.info('Running command:');
      logger.info(cmd);
      stitchEvents.emit('request-run-project-in-webview', {
        cmd,
        args,
        runtime,
        project: this as any,
        clean: options?.clean,
      });
    }
  }

  async getWindowsName() {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    try {
      const { stdout } = await execAsync(
        `tasklist /FI "IMAGENAME eq Runner.exe" /V /FO CSV`,
      );
      const lines = stdout.split('\n').slice(1);
      for (const line of lines) {
        const parts = line.split('","');
        if (parts.length > 8) {
          const windowTitle = parts[8].replace(/"/g, '').trim();
          if (windowTitle.includes(this.yyp.name)) {
            return windowTitle;
          }
        }
      }
    } catch {}
    return undefined;
  }

  async reloadConfig() {
    this._config = await this.loadConfig();
  }

  static async from(
    yypPath: string,
    options?: GameMakerRunnerOptions,
  ): Promise<GameMakerRunner> {
    const runner = new GameMakerRunner(yypPath, options);
    runner.yyp = await GameMakerRunner.readYyp(yypPath);
    await runner.reloadConfig();
    return runner;
  }

  static async readYyp(yypPath: string): Promise<Yyp> {
    return (await Yy.read(yypPath)) as Yyp;
  }

  async setIdeVersion(version: string) {
    this.yyp.MetaData.IDEVersion = version;
    await Yy.write(this.yypPath.absolute, this.yyp, 'project');
  }
}