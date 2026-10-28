import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { withTestProject } from './helpers/setup.js';
import { refreshGeneratedTypes, usesGeneratedTypes, DEFAULT_TYPES_OUTPUT } from '../commands/lint/types.js';

// `slice lint` refreshes the generated declarations before linting, so the
// editor never reads a stale `.d.ts`. This is the only "types" step in the
// command: ESLint itself does not type-check.

test('a project without types is skipped', async () => {
  await withTestProject(async (root) => {
    assert.equal(await usesGeneratedTypes(root), false);
    assert.deepEqual(await refreshGeneratedTypes(root), { status: 'skipped' });
  });
});

test('a slice:types script opts the project in', async () => {
  await withTestProject(async (root) => {
    const pkgPath = path.join(root, 'package.json');
    const pkg = (await fs.pathExists(pkgPath)) ? await fs.readJson(pkgPath) : { name: 'x' };
    await fs.writeJson(pkgPath, { ...pkg, scripts: { ...(pkg.scripts || {}), 'slice:types': 'slice types generate' } });

    assert.equal(await usesGeneratedTypes(root), true);
  });
});

test('the declarations are regenerated in place and reported', async () => {
  await withTestProject(async (root) => {
    const output = path.join(root, DEFAULT_TYPES_OUTPUT);
    await fs.outputFile(output, '// stale\n');

    const first = await refreshGeneratedTypes(root);
    assert.equal(first.status, 'updated');
    assert.ok(first.components >= 0);

    const content = await fs.readFile(output, 'utf8');
    assert.match(content, /SliceComponentPropsMap/, 'the real declarations were written');

    const second = await refreshGeneratedTypes(root);
    assert.equal(second.status, 'unchanged');
  }, { visualComponents: ['Widget'] });
});

test('a missing declaration file is created', async () => {
  await withTestProject(async (root) => {
    const pkgPath = path.join(root, 'package.json');
    const pkg = (await fs.pathExists(pkgPath)) ? await fs.readJson(pkgPath) : { name: 'x' };
    await fs.writeJson(pkgPath, { ...pkg, scripts: { 'slice:types': 'slice types generate' } });

    const result = await refreshGeneratedTypes(root);
    assert.equal(result.status, 'created');
    assert.ok(await fs.pathExists(path.join(root, DEFAULT_TYPES_OUTPUT)));
  }, { visualComponents: ['Widget'] });
});

test('the lint command exposes the opt-out', async () => {
  const client = await fs.readFile(path.join(process.cwd(), 'client.js'), 'utf8');
  assert.match(client, /\.option\("--no-types"/);
});

test('a script without a component registry is skipped', async () => {
  await withTestProject(async (root) => {
    await fs.writeJson(path.join(root, 'package.json'), { name: 'x', scripts: { 'slice:types': 'slice types generate' } });
    await fs.remove(path.join(root, 'src', 'Components', 'components.js'));

    assert.deepEqual(await refreshGeneratedTypes(root), { status: 'skipped' });
  });
});
