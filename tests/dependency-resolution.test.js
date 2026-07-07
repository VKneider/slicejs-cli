import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

describe('analyzeSource', () => {
  let analyzeSource;

  before(async () => {
    ({ analyzeSource } = await import('../commands/utils/analyzeSource.js'));
  });

  test('detects slice.build string component names', () => {
    const src = `
      export default class Table extends HTMLElement {
        async init() {
          this.engine = await slice.build('DataGridEngine', { sliceId: 'x' });
          this.pager = await slice.build('Pagination', {});
        }
      }`;
    const { builds } = analyzeSource(src);
    assert.deepEqual([...builds].sort(), ['DataGridEngine', 'Pagination']);
  });

  test('ignores dynamic slice.build(variable) names', () => {
    const src = `const name = 'X'; slice.build(name, {});`;
    const { builds } = analyzeSource(src);
    assert.equal(builds.size, 0);
  });

  test('detects relative import specifiers (import / export-from / dynamic)', () => {
    const src = `
      import DataGridEngine from '../../Service/DataGridEngine/DataGridEngine.js';
      import { clamp } from './dndGeometry.js';
      export { default as Foo } from './Foo/Foo.js';
      const lazy = () => import('./lazy.js');
    `;
    const { imports } = analyzeSource(src);
    assert.deepEqual(
      imports.sort(),
      ['../../Service/DataGridEngine/DataGridEngine.js', './Foo/Foo.js', './dndGeometry.js', './lazy.js']
    );
  });

  test('ignores bare / framework imports', () => {
    const src = `
      import { parse } from '@babel/parser';
      import ora from 'ora';
    `;
    const { imports } = analyzeSource(src);
    assert.deepEqual(imports, []);
  });

  test('returns empty sets for unparseable source', () => {
    const { builds, imports } = analyzeSource('this is <<< not valid js');
    assert.equal(builds.size, 0);
    assert.deepEqual(imports, []);
  });
});

describe('resolveRepoImportPath', () => {
  let ComponentRegistry;

  before(async () => {
    ({ ComponentRegistry } = await import('../commands/getComponent/getComponent.js'));
  });

  const registry = () => new ComponentRegistry();

  test('resolves a cross-component relative import to a repo path', () => {
    const r = registry().resolveRepoImportPath(
      'Visual/Pagination/Pagination.js',
      '../../Service/DataGridEngine/DataGridEngine.js'
    );
    assert.equal(r, 'Service/DataGridEngine/DataGridEngine.js');
  });

  test('resolves a sibling helper module import', () => {
    const r = registry().resolveRepoImportPath(
      'Service/DragDropService/DragDropService.js',
      './dndGeometry.js'
    );
    assert.equal(r, 'Service/DragDropService/dndGeometry.js');
  });

  test('appends .js when the specifier has no extension', () => {
    const r = registry().resolveRepoImportPath('Visual/Foo/Foo.js', './helper');
    assert.equal(r, 'Visual/Foo/helper.js');
  });

  test('returns null when the import escapes the Components root', () => {
    const r = registry().resolveRepoImportPath(
      'Visual/Table/Table.spec.js',
      '../../../../playwright/harness/sliceFixtures.js'
    );
    assert.equal(r, null);
  });

  test('returns null for non-JS module specifiers', () => {
    assert.equal(registry().resolveRepoImportPath('Visual/Foo/Foo.js', './styles.css'), null);
    assert.equal(registry().resolveRepoImportPath('Visual/Foo/Foo.js', './data.json'), null);
  });
});

describe('resolveDependencies classification', () => {
  let ComponentRegistry;

  before(async () => {
    ({ ComponentRegistry } = await import('../commands/getComponent/getComponent.js'));
  });

  const makeRegistry = (entries) => {
    const r = new ComponentRegistry();
    r.componentsRegistry = { ...entries };
    return r;
  };

  test('slice.build deps install as components; unknown build names are skipped', async () => {
    const registry = makeRegistry({ DataGridEngine: 'Service', Pagination: 'Visual' });
    const installed = [];
    const helpers = [];
    registry.installComponent = async (name, category, force, opts) => {
      installed.push({ name, category, isDep: opts?.isDep });
      opts?.seen?.add(`comp:${name}`);
      return true;
    };
    registry.installHelperFile = async (p) => { helpers.push(p); };

    const src = `
      slice.build('DataGridEngine', {});
      slice.build('Pagination', {});
      slice.build('Controller', {}); // structural, not in registry → skipped
    `;
    await registry.resolveDependencies(src, 'Visual/Table/Table.js', new Set(), false);

    assert.deepEqual(installed.map(i => i.name).sort(), ['DataGridEngine', 'Pagination']);
    assert.ok(installed.every(i => i.isDep === true));
    assert.deepEqual(helpers, []);
  });

  test('component-entrypoint import installs as component; helper import downloads as file', async () => {
    const registry = makeRegistry({ DataGridEngine: 'Service' });
    const installed = [];
    const helpers = [];
    registry.installComponent = async (name, category, force, opts) => {
      installed.push(name);
      opts?.seen?.add(`comp:${name}`);
      return true;
    };
    registry.installHelperFile = async (p, seen) => { helpers.push(p); seen.add(`file:${p}`); };

    const src = `
      import DataGridEngine from '../../Service/DataGridEngine/DataGridEngine.js';
      import { clamp } from './dndGeometry.js';
    `;
    await registry.resolveDependencies(src, 'Visual/Pagination/Pagination.js', new Set(), false);

    assert.deepEqual(installed, ['DataGridEngine']);
    assert.deepEqual(helpers, ['Visual/Pagination/dndGeometry.js']);
  });
});
