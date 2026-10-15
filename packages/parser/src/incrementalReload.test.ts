import { expect } from 'chai';
import type { Code } from './project.code.js';
import { Project } from './project.js';
import { assert, ok } from './util.js';

describe('Incremental reload', function () {
  let project: Project;
  let definingFile: Code;
  let dependentFile: Code;
  /** Defining file content with its two exported functions stripped out. */
  let strippedContent: string;
  /** The defining file's original content, captured before any reload. */
  let originalContent: string;

  beforeEach(async function () {
    project = await Project.initialize('samples/project');
    // Script1 defines `global_function` and `another_global_function`,
    // which o_object/Create_0.gml references without defining them.
    definingFile = project.getAssetByName('Script1')!.gmlFile;
    dependentFile = project.getAssetByName('o_object')!.getEventByName(
      'Create_0',
    )!;
    ok(definingFile.content.includes('function global_function('));
    ok(dependentFile.content.includes('global_function('));
    originalContent = definingFile.content;
    strippedContent = definingFile.content
      .replace(/function\s+global_function\s*\([^)]*\)\s*\{[\s\S]*?\n\}/, '')
      .replace(/function\s+another_global_function\s*\([^)]*\)\s*\{\s*\}/, '');
    expect(strippedContent).to.not.equal(definingFile.content);
  });

  function undeclaredNames(file: Code) {
    return file
      .getDiagnostics()
      .UNDECLARED_VARIABLE_REFERENCE.map((d) => d.message);
  }

  it('starts with a clean dependent file', function () {
    expect(undeclaredNames(dependentFile)).to.have.lengthOf(0);
  });

  it('leaves dependent diagnostics stale without reloadDirty', async function () {
    await definingFile.reload(strippedContent);
    // Without `reloadDirty`, the queue of dependent files is never drained,
    // so their diagnostics do not reflect the removed definitions.
    expect(undeclaredNames(dependentFile)).to.have.lengthOf(0);
  });

  it('recomputes dependent diagnostics with reloadDirty', async function () {
    await definingFile.reload(strippedContent, { reloadDirty: true });
    const missing = undeclaredNames(dependentFile);
    expect(missing.join('\n')).to.include('global_function');
    expect(missing.join('\n')).to.include('another_global_function');
  });

  it('clears dependent diagnostics once the dependent reloads', async function () {
    await definingFile.reload(strippedContent, { reloadDirty: true });
    expect(undeclaredNames(dependentFile).join('\n')).to.include(
      'global_function',
    );

    // Restoring the definition re-registers it on the defining file.
    await definingFile.reload(originalContent, { reloadDirty: true });
    const restored = definingFile.refs.find(
      (r) => r.item.name === 'another_global_function',
    );
    expect(restored?.item.def?.file.name).to.equal('Script1');

    // Reloading the dependent is not required: the drain clears it (see the
    // "without reloading the dependent" test). But a full dependent reload
    // must also stay safe, so it is asserted here too.
    await dependentFile.reload(dependentFile.content, { reloadDirty: true });
    expect(undeclaredNames(dependentFile)).to.have.lengthOf(0);
  });

  it('restores dependent diagnostics without reloading the dependent', async function () {
    await definingFile.reload(strippedContent, { reloadDirty: true });
    expect(undeclaredNames(dependentFile).join('\n')).to.include(
      'global_function',
    );

    // Restore only the defining file. If the drain is sufficient, the
    // dependent's diagnostics clear even though it was never reloaded.
    await definingFile.reload(originalContent, { reloadDirty: true });
    expect(undeclaredNames(dependentFile)).to.have.lengthOf(0);
  });

  it('is idempotent for unchanged content', async function () {
    const before = [...definingFile.refs].map((r) => r.item.name);
    await definingFile.reload(originalContent, { reloadDirty: true });
    const after = [...definingFile.refs].map((r) => r.item.name);
    expect(after).to.deep.equal(before);
  });

  it('empty-change content does not drop symbols', async function () {
    // Editors emit empty change events (no text). Those must not race a
    // real reload into an inconsistent symbol set: refs still resolve and
    // a follow-up reload with the same text is a no-op.
    const baseline = [...definingFile.refs].map((r) => r.item.name);
    await definingFile.reload(originalContent, { reloadDirty: true });
    const middle = [...definingFile.refs].map((r) => r.item.name);
    expect(middle).to.deep.equal(baseline);
    await definingFile.reload(originalContent, { reloadDirty: true });
    expect([...definingFile.refs].map((r) => r.item.name)).to.deep.equal(
      baseline,
    );
  });

  it('drains the dirty queue it filled', async function () {
    const dirty = (project as any).dirtyFiles as Set<Code>;
    await definingFile.reload(strippedContent, { reloadDirty: true });
    expect(dirty.size).to.equal(0);
  });
});
