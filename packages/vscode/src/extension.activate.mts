import { Asset, Code } from '@bscotch/gml-parser';
import { literal } from '@bscotch/utility';
import vscode from 'vscode';
import { swallowThrown } from './assert.mjs';
import { stitchConfig } from './config.mjs';
import { stitchEvents } from './events.mjs';
import { StitchCompletionProvider } from './extension.completions.mjs';
import {
  createCopyAsJsdocSelfCallback,
  createCopyAsJsdocTypeCallback,
  createCopyAsTypeCallback,
} from './extension.copyType.mjs';
import { StitchDefinitionsProvider } from './extension.definitions.mjs';
import { StitchYyFormatProvider } from './extension.formatting.mjs';
import { StitchHoverProvider } from './extension.hover.mjs';
import { StitchLensProvider } from './extension.lens.mjs';
import { StitchLocationsProvider } from './extension.locations.mjs';
import { StitchReferenceProvider } from './extension.refs.mjs';
import { StitchReleasePickerProvider } from './extension.releases.mjs';
import { StitchRenameProvider } from './extension.rename.mjs';
import { StitchWorkspaceSymbolProvider } from './extension.symbols.mjs';
import { StitchTypeDefinitionProvider } from './extension.typeDefs.mjs';
import type { StitchWorkspace } from './extension.workspace.mjs';
import { GameMakerRunner } from './extension.runner.mjs';
import { StitchIncludedFilesTree } from './includedFilesTree.mjs';
import { GameMakerInspectorProvider } from './inspector.mjs';
import {
  createSorter,
  findProject,
  getAssetFromRef,
  getRelativeWorkspacePath,
  pathyFromUri,
  registerCommand,
} from './lib.mjs';
import { Timer, info, logger, showErrorMessage, warn } from './log.mjs';
import { SpriteSourcesTree } from './spriteSources.mjs';
import { GameMakerFolder } from './tree.folder.mjs';
import { GameMakerTreeProvider } from './tree.mjs';
import { StitchIgorView } from './webview.igor.mjs';
import { StitchSpriteEditorProvider } from './webviews.spriteEditor.mjs';

/**
 * Scan workspace for .yyp files, pre-filter by allowedProjects,
 * then prompt user (or auto-select from stored setting).
 * Returns chosen yypFile URIs (0 or 1 items).
 */
async function selectYypFiles(): Promise<vscode.Uri[]> {
  info('Loading projects...');
  let yypFiles = await vscode.workspace.findFiles(`**/*.yyp`);
  if (!yypFiles.length) {
    warn('No .yyp files found in workspace!');
    return [];
  }

  // Pre-filter based on allowed project config
  const allowed = stitchConfig.allowedProjects.map((p) => p.toLowerCase());
  let prefiltered = [...yypFiles];
  if (allowed.length) {
    prefiltered = prefiltered.filter((projectUri) => {
      const path = pathyFromUri(projectUri);
      const yypName = path.name;
      const folderName = path.up().name;
      return (
        allowed.includes(yypName.toLowerCase()) ||
        allowed.includes(folderName.toLowerCase())
      );
    });
  }
  yypFiles = prefiltered.length ? prefiltered : yypFiles;

  // If stored setting matches a yyp, auto-select
  const stored = stitchConfig.selectedProject;
  if (stored) {
    const storedLower = stored.toLowerCase().replace(/\\/g, '/');
    const match = yypFiles.find((u) => {
      const fsPathLower = u.fsPath.toLowerCase().replace(/\\/g, '/');
      // stored is relative to workspace root; try suffix match
      return fsPathLower.endsWith(storedLower) || fsPathLower === storedLower;
    });
    if (match) {
      info('Using stored project:', stored);
      return [match];
    }
    warn('Stored project not found:', stored);
  }

  if (yypFiles.length <= 1) {
    return yypFiles;
  }

  // Multi-project: show picker
  const chosen = await vscode.window.showQuickPick(
    yypFiles.map((yyp) => ({
      label: pathyFromUri(yyp).basename,
      description: pathyFromUri(yyp).up().absolute,
      uri: yyp,
    })),
    {
      title:
        'Stitch: Multiple GameMaker projects found! Choose a project to load.',
    },
  );
  if (!chosen) return [];
  return [chosen.uri];
}

/**
 * Persist the chosen yyp path to workspace settings.
 */
async function persistProjectSelection(yypUri: vscode.Uri): Promise<void> {
  const relative = getRelativeWorkspacePath(yypUri);
  await stitchConfig.config.update(
    'selectedProject',
    relative,
    vscode.ConfigurationTarget.Workspace,
  );
}

/**
 * Create a runner + full project load for a single yyp file.
 * Registers file watchers in the background.
 */
async function loadSingleProject(
  yypFile: vscode.Uri,
  ctx: vscode.ExtensionContext,
  workspace: StitchWorkspace,
): Promise<void> {
  // Phase 1: Create lightweight runner immediately (Fast)
  let runner: GameMakerRunner;
  try {
    info('Creating runner for', yypFile);
    runner = await GameMakerRunner.from(yypFile.fsPath);
    workspace.runners.push(runner);
    info('Runner ready for', runner.name);
  } catch (error) {
    logger.error('Error creating runner for', yypFile);
    logger.error(error);
    return;
  }

  // Update context so runner commands are available
  void vscode.commands.executeCommand(
    'setContext',
    'stitch.projectCount',
    workspace.runners.length,
  );

  // Phase 2: Load full parser project IN BACKGROUND (Non-Blocking)
  void (async () => {
    info('Loading full parser project', yypFile);
    const pt = Timer.start();
    try {
      await workspace.loadProject(
        yypFile,
        runner,
        workspace.emitDiagnostics.bind(workspace),
      );
      pt.seconds('Loaded project in');

      // Register file watchers for this project
      const projectFolder = pathyFromUri(yypFile).up();
      const base = vscode.Uri.file(projectFolder.absolute);
      const patterns = [
        new vscode.RelativePattern(base, '*.yyp'),
        new vscode.RelativePattern(base, '*/*/*.yy'),
        new vscode.RelativePattern(base, '*/*/*.gml'),
        new vscode.RelativePattern(base, '*/*/*.atlas'),
        new vscode.RelativePattern(base, '*/*/*.png'),
        new vscode.RelativePattern(base, 'datafiles/**/*'),
      ];
      const watchers = patterns.map((pattern) =>
        vscode.workspace.createFileSystemWatcher(pattern),
      );
      ctx.subscriptions.push(
        ...watchers,
        ...watchers.map((watcher) =>
          watcher.onDidCreate((uri) => {
            workspace.externalChangeTracker.addChange({ uri, type: 'create' });
          }),
        ),
        ...watchers.map((watcher) =>
          watcher.onDidDelete((uri) => {
            workspace.externalChangeTracker.addChange({ uri, type: 'delete' });
          }),
        ),
        ...watchers.map((watcher) =>
          watcher.onDidChange((uri) => {
            workspace.externalChangeTracker.addChange({ uri, type: 'change' });
          }),
        ),
      );
    } catch (error) {
      logger.error(error);
      logger.error('Error loading project', yypFile);
      showErrorMessage(
        `Could not load project ${pathyFromUri(yypFile).basename}...`,
      );
    }
  })();
}

export async function activateStitchExtension(
  workspace: StitchWorkspace,
  ctx: vscode.ExtensionContext,
) {
  info('Activating extension...');
  stitchConfig.context = ctx;

  const t = Timer.start();

  // Dispose any existing subscriptions
  ctx.subscriptions.forEach((s) => s.dispose());

  workspace.clearProjects();

  // Dev-only watcher
  if (ctx.extensionMode === vscode.ExtensionMode.Development) {
    const patterns = [
      new vscode.RelativePattern(ctx.extensionPath, 'dist/**'),
      new vscode.RelativePattern(ctx.extensionPath, 'assets/**'),
    ];

    let timer: NodeJS.Timeout | undefined;
    const DEBOUNCE_MS = 100;

    const scheduleReload = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        console.log('Extension source updated. Reloading!');
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }, DEBOUNCE_MS);
    };

    const extWatchers = patterns.map((p) =>
      vscode.workspace.createFileSystemWatcher(p, false, false, false),
    );

    extWatchers.forEach((w) => {
      w.onDidCreate(scheduleReload);
      w.onDidChange(scheduleReload);
      w.onDidDelete(scheduleReload);
      ctx.subscriptions.push(w);
    });
  }

  // Select yyp files (uses stored setting if available)
  const yypFiles = await selectYypFiles();

  // Load the selected project(s)
  for (const yypFile of yypFiles) {
    await loadSingleProject(yypFile, ctx, workspace);
  }

  // Persist selection if exactly one chosen
  if (yypFiles.length === 1) {
    await persistProjectSelection(yypFiles[0]);
  }

  const treeProvider = new GameMakerTreeProvider(workspace);
  const inspectorProvider = new GameMakerInspectorProvider(workspace);
  const definitionsProvider = new StitchDefinitionsProvider(workspace);

  // Synchronously register providers so UI lights up immediately
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) =>
      workspace.onChangeDoc(event),
    ),
    ...treeProvider.register(),
    ...inspectorProvider.register(),
    ...definitionsProvider.register(),
    ...StitchIncludedFilesTree.register(workspace),
    ...StitchTypeDefinitionProvider.register(workspace),
    ...StitchReleasePickerProvider.register(workspace),
    ...StitchRenameProvider.register(workspace),
    ...(SpriteSourcesTree?.register(workspace) || []),
    StitchHoverProvider.register(workspace),
    StitchLensProvider.register(workspace),
    StitchWorkspaceSymbolProvider.register(workspace),
    StitchCompletionProvider.register(workspace),
    ...StitchIgorView.register(workspace),
    ...StitchSpriteEditorProvider.register(workspace),
    ...StitchReferenceProvider.register(workspace),
    ...StitchLocationsProvider.register(workspace),
    vscode.languages.registerSignatureHelpProvider('gml', workspace, '(', ','),
    vscode.languages.registerDocumentFormattingEditProvider(
      'yy',
      new StitchYyFormatProvider(),
    ),
    registerCommand('stitch.assets.delete', (what) => {
      let asset: Asset | undefined;
      if (what && typeof what === 'object') {
        if (what instanceof Asset) {
          asset = what;
        } else if ('asset' in what && what.asset instanceof Asset) {
          asset = what.asset;
        }
      }
      if (!asset) {
        logger.warn('stitch.assets.delete called on unknown type', what);
        return;
      }
      workspace.deleteAsset(asset);
    }),
    registerCommand('stitch.assets.deleteCode', async (what) => {
      let code: Code | undefined;
      if (what && typeof what === 'object') {
        if (what instanceof Code) {
          code = what;
        } else if ('code' in what && what.code instanceof Code) {
          code = what.code;
        }
      }
      if (!code) {
        logger.warn('stitch.assets.deleteCode called on unknown type', what);
        return;
      }
      await code.remove();
      stitchEvents.emit('code-file-deleted', code);
    }),
    registerCommand('stitch.types.copy', createCopyAsTypeCallback(workspace)),
    registerCommand(
      'stitch.types.copyAsJsdocSelf',
      createCopyAsJsdocSelfCallback(workspace),
    ),
    registerCommand(
      'stitch.types.copyAsJsdocType',
      createCopyAsJsdocTypeCallback(workspace),
    ),
    registerCommand('stitch.chooseProject', async () => {
      // Find all yyp files fresh
      let yypFiles = await vscode.workspace.findFiles(`**/*.yyp`);
      if (!yypFiles.length) {
        void showErrorMessage('No .yyp files found in workspace!');
        return;
      }

      // Pre-filter
      const allowed = stitchConfig.allowedProjects.map((p) => p.toLowerCase());
      let prefiltered = [...yypFiles];
      if (allowed.length) {
        prefiltered = prefiltered.filter((projectUri) => {
          const path = pathyFromUri(projectUri);
          const yypName = path.name;
          const folderName = path.up().name;
          return (
            allowed.includes(yypName.toLowerCase()) ||
            allowed.includes(folderName.toLowerCase())
          );
        });
      }
      yypFiles = prefiltered.length ? prefiltered : yypFiles;

      if (!yypFiles.length) {
        void showErrorMessage(
          'No .yyp files match the allowed projects filter.',
        );
        return;
      }

      const chosen = await vscode.window.showQuickPick(
        yypFiles.map((yyp) => ({
          label: pathyFromUri(yyp).basename,
          description: pathyFromUri(yyp).up().absolute,
          uri: yyp,
        })),
        {
          title: 'Stitch: Choose a GameMaker project to load',
        },
      );
      if (!chosen) return;

      // Clear current state
      workspace.clearProjects();

      // Load the chosen project
      await loadSingleProject(chosen.uri, ctx, workspace);
      await persistProjectSelection(chosen.uri);
    }),
    registerCommand(
      'stitch.run',
      async (uriOrFolder: string[] | GameMakerFolder) => {
        const runner = findRunner(workspace, uriOrFolder);
        if (!runner) {
          void showErrorMessage('No project found to run!');
          return;
        }
        let lastConfig: any = ctx.workspaceState.get('lastRunConfig');
        const isValidConfig =
          typeof lastConfig === 'object' &&
          'compiler' in lastConfig &&
          'config' in lastConfig;
        if (!isValidConfig) {
          lastConfig = undefined;
        }
        try {
          await runner.run(lastConfig);
        } catch (err) {
          void showErrorMessage(err as Error);
        }
      },
    ),
    registerCommand(
      'stitch.stop',
      (uriOrFolder: string[] | GameMakerFolder) => {
        const runner = findRunner(workspace, uriOrFolder);
        if (!runner) {
          void showErrorMessage('No project found to run!');
          return;
        }
        runner.kill();
      },
    ),
    registerCommand(
      'stitch.run.noDefaults',
      async (uriOrFolder: string[] | GameMakerFolder) => {
        const runner = findRunner(workspace, uriOrFolder);
        if (!runner) {
          void showErrorMessage('No project found to run!');
          return;
        }
        const configs = runner.configs.sort(
          createSorter({
            first: [stitchConfig.runConfigDefault || '', 'Default'],
          }),
        );
        const chosenConfig = await vscode.window.showQuickPick(configs, {
          title: 'Select a config',
        });
        if (!chosenConfig) return;

        const compilers = literal(['vm', 'yyc']).sort(
          createSorter({ first: [stitchConfig.runCompilerDefault] }),
        );
        const chosenCompiler = await vscode.window.showQuickPick(compilers, {
          title: 'Select a compiler',
        });
        if (!chosenCompiler) return;

        ctx.workspaceState.update('lastRunConfig', {
          compiler: chosenCompiler as any,
          config: chosenConfig,
        });

        const when = await vscode.window.showQuickPick(
          [
            { label: 'Run Now', now: true, picked: true },
            {
              label: 'Run Later',
              now: false,
              detail:
                'All future runs will use the new target until you change it again.',
            },
          ],
          {
            title: 'Target Updated! Run now?',
          },
        );
        if (when?.now) {
          await runner.run({
            compiler: chosenCompiler as any,
            config: chosenConfig,
          });
        }
      },
    ),
    registerCommand(
      'stitch.clean',
      (uriOrFolder: string[] | GameMakerFolder) => {
        const runner = findRunner(workspace, uriOrFolder);
        if (!runner) {
          void showErrorMessage('No project found to run!');
          return;
        }
        runner.run({ clean: true });
      },
    ),
    registerCommand(
      'stitch.openIde',
      async (uriOrFolder: string[] | GameMakerFolder) => {
        const runner = findRunner(workspace, uriOrFolder);
        if (!runner) {
          void showErrorMessage('No project found to open!');
          return;
        }
        await runner.openInIde();
      },
    ),
    registerCommand('stitch.newProject', async () => {
      await workspace.createNewProject();
    }),
    workspace.semanticHighlightProvider.register(),
    workspace.signatureHelpStatus,
    vscode.window.onDidChangeTextEditorSelection((e) => {
      const ref = workspace.getRefFromSelection(
        e.textEditor.document,
        e.selections,
      );
      if (!ref) return;
      const asset = getAssetFromRef(ref);

      const isNative =
        !!ref.item?.native && ref.item.name !== 'event_inherited';

      void vscode.commands.executeCommand(
        'setContext',
        'stitch.selectionIsNative',
        isNative,
      );
      void vscode.commands.executeCommand(
        'setContext',
        'stitch.selectionIsSprite',
        asset?.isSprite && asset.name,
      );
      void vscode.commands.executeCommand(
        'setContext',
        'stitch.selectionIsSound',
        asset?.isSound && asset.name,
      );
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor.document.uri.scheme !== 'file') {
        return;
      }
      workspace.signatureHelpStatus.text = '';
      workspace.signatureHelpStatus.hide();
      if (!stitchConfig.enableFunctionSignatureStatus) {
        return;
      }
      if (e.selections.length !== 1) {
        return;
      }
      const signatureHelp = swallowThrown(
        () =>
          workspace.provideSignatureHelp(
            e.textEditor.document,
            e.selections[0].start,
          )!,
      );
      if (!signatureHelp) {
        return;
      }
      const signature = signatureHelp.signatures[signatureHelp.activeSignature];
      const name = signature.label.match(/^function\s+([^(]+)/i)?.[1];
      if (!name) {
        return;
      }
      const asString = `${name}(${signature.parameters
        .map((p, i) => {
          if (
            typeof p.label === 'string' &&
            i === signatureHelp.activeParameter
          ) {
            return p.label.toUpperCase();
          }
          return p.label;
        })
        .join(', ')})`;
      workspace.signatureHelpStatus.text = asString;
      workspace.signatureHelpStatus.show();
    }),
    workspace.diagnosticCollection,
  );

  t.seconds('Extension activated in');
  return workspace;
}

export function findRunner(
  workspace: StitchWorkspace,
  uriOrFolder: string[] | GameMakerFolder,
): GameMakerRunner | undefined {
  if (Array.isArray(uriOrFolder) && uriOrFolder.length) {
    const targetPath = uriOrFolder[0];
    return workspace.runners.find((r) =>
      targetPath.toLowerCase().startsWith(r.dir.absolute.toLowerCase()),
    );
  }
  return workspace.runners[0];
}
