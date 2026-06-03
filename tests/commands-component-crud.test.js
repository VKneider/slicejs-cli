import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { withTestProject } from './helpers/setup.js';
import createComponent from '../commands/createComponent/createComponent.js';
import deleteComponent from '../commands/deleteComponent/deleteComponent.js';
import listComponentsReal from '../commands/listComponents/listComponents.js';

const visualDir = (root, name) =>
  path.join(root, 'src', 'Components', 'Visual', name);

describe('component create', () => {
  test('creates a Visual component with .js/.css/.html', async () => {
    await withTestProject(async (root) => {
      const ok = createComponent('Card', 'Visual');
      assert.equal(ok, true);
      const dir = visualDir(root, 'Card');
      assert.ok(await fs.pathExists(path.join(dir, 'Card.js')));
      assert.ok(await fs.pathExists(path.join(dir, 'Card.css')));
      assert.ok(await fs.pathExists(path.join(dir, 'Card.html')));
    });
  });

  test('creates a Service component with only a .js file', async () => {
    await withTestProject(async (root) => {
      const ok = createComponent('Api', 'Service');
      assert.equal(ok, true);
      const dir = path.join(root, 'src', 'Components', 'Service', 'Api');
      assert.ok(await fs.pathExists(path.join(dir, 'Api.js')));
      assert.equal(await fs.pathExists(path.join(dir, 'Api.css')), false);
    });
  });

  test('rejects an invalid component name', async () => {
    await withTestProject(() => {
      assert.equal(createComponent('1Bad', 'Visual'), false);
      assert.equal(createComponent('bad-name', 'Visual'), false);
    });
  });

  test('rejects an unknown category', async () => {
    await withTestProject(() => {
      assert.equal(createComponent('Card', 'Nope'), false);
    });
  });

  test('rejects when the component files already exist', async () => {
    await withTestProject(() => {
      assert.equal(createComponent('Card', 'Visual'), true);
      // Second creation hits the on-disk existence guard.
      assert.equal(createComponent('Card', 'Visual'), false);
    });
  });
});

describe('component delete', () => {
  test('deletes an existing component directory', async () => {
    await withTestProject(async (root) => {
      createComponent('Card', 'Visual');
      assert.ok(await fs.pathExists(visualDir(root, 'Card')));

      const ok = deleteComponent('Card', 'Visual');
      assert.equal(ok, true);
      assert.equal(await fs.pathExists(visualDir(root, 'Card')), false);
    });
  });

  test('returns false when the component does not exist', async () => {
    await withTestProject(() => {
      assert.equal(deleteComponent('DoesNotExist', 'Visual'), false);
    });
  });

  // Components are PascalCase by convention: both create and delete normalize
  // the initial to uppercase, so a lower-case name round-trips correctly.
  test('create/delete round-trips a lower-case initial (PascalCase normalization)', async () => {
    await withTestProject(async (root) => {
      assert.equal(createComponent('card', 'Visual'), true);
      assert.ok(await fs.pathExists(visualDir(root, 'Card')), 'folder is created in PascalCase');
      assert.equal(deleteComponent('card', 'Visual'), true);
      assert.equal(await fs.pathExists(visualDir(root, 'Card')), false);
    });
  });
});

describe('component list (registry regeneration)', () => {
  test('regenerates components.js from the files on disk', async () => {
    await withTestProject(async (root) => {
      createComponent('Card', 'Visual');
      listComponentsReal();

      const registryPath = path.join(root, 'src', 'Components', 'components.js');
      const content = await fs.readFile(registryPath, 'utf8');
      const json = JSON.parse(content.match(/const components = ({[\s\S]*?});/)[1]);

      assert.equal(json.Card, 'Visual');
      // Starter AppComponents must still be present.
      assert.equal(json.AppShell, 'AppComponents');
    });
  });
});
