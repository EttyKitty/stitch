import {
  OnDiagnostics,
  Project,
  ProjectOptions,
  setLogger,
} from '@bscotch/gml-parser';
import { pathy } from '@bscotch/pathy';
import path from 'path';
import vscode from 'vscode';
import type { GameMakerRunner } from './extension.runner.mjs';
import { stitchConfig } from './config.mjs';
import { logger, warn } from './log.mjs';

setLogger(logger.withPrefix('PARSER'));

export class GameMakerProject extends Project {
  readonly kind = 'project';
  /** Lightweight runner, decoupled from parser. */
  readonly runner: GameMakerRunner;

  protected constructor(
    yypPath: vscode.Uri,
    runner: GameMakerRunner,
    options: ProjectOptions,
  ) {
    super(pathy(yypPath.fsPath), options);
    this.runner = runner;
  }

  get name() {
    return this.yyp.name;
  }

  openInIde() {
    return this.runner.openInIde();
  }

  async kill() {
    return this.runner.kill();
  }

  async run(options?: {
    config?: string | null;
    compiler?: 'yyc' | 'vm';
    clean?: boolean;
  }) {
    return this.runner.run(options as any);
  }

  includesFile(document: vscode.Uri | vscode.TextDocument): boolean {
    const file = document instanceof vscode.Uri ? document : document.uri;
    const relative = path.relative(this.dir.absolute, file.fsPath);
    return !relative || !relative.startsWith('..');
  }

  /**
   * Determine which resource this file belongs to,
   * and pass an update request to that resource.
   */
  async updateFile(doc: vscode.Uri | vscode.TextDocument): Promise<void> {
    const uri = pathy((doc instanceof vscode.Uri ? doc : doc.uri).fsPath);
    const resource = this.getAsset(uri);
    if (!resource) {
      warn(`Could not find resource for file ${uri}`);
    } else {
      await resource.reloadFile(uri);
    }
  }

  static async from(
    yypPath: vscode.Uri,
    runner: GameMakerRunner,
    onDiagnostics: OnDiagnostics,
    onProgress: (increment: number, message?: string) => void,
  ) {
    const options: ProjectOptions = {
      onDiagnostics,
      onLoadProgress: onProgress,
      settings: {
        autoDeclareGlobalsPrefixes: stitchConfig.autoDeclaredGlobalsPrefixes,
      },
      logger,
    };
    const project = new GameMakerProject(yypPath, runner, options);
    await project.initialize(options);
    return project;
  }
}
