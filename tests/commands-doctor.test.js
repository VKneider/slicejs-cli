import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { withTestProject } from './helpers/setup.js';
import {
  checkNodeVersion,
  checkDirectoryStructure,
  checkConfig,
  checkComponents,
} from '../commands/doctor/doctor.js';

describe('doctor checks', () => {
  test('checkNodeVersion passes on the supported runtime', async () => {
    const r = await checkNodeVersion();
    assert.equal(r.pass, true);
    assert.match(r.message, /Node\.js version/);
  });

  test('checkDirectoryStructure passes on the starter project', async () => {
    await withTestProject(async () => {
      const r = await checkDirectoryStructure();
      assert.equal(r.pass, true);
    });
  });

  test('checkDirectoryStructure fails when src/ is missing', async () => {
    await withTestProject(async (root) => {
      await fs.remove(path.join(root, 'src'));
      const r = await checkDirectoryStructure();
      assert.equal(r.pass, false);
      assert.match(r.message, /Missing directories/);
      assert.match(r.message, /src\//);
    });
  });

  test('checkConfig passes for a valid sliceConfig.json', async () => {
    await withTestProject(async () => {
      const r = await checkConfig();
      assert.equal(r.pass, true);
    });
  });

  test('checkConfig fails on invalid JSON', async () => {
    await withTestProject(async (root) => {
      await fs.writeFile(path.join(root, 'src', 'sliceConfig.json'), '{ not valid json ');
      const r = await checkConfig();
      assert.equal(r.pass, false);
      assert.match(r.message, /invalid JSON/);
    });
  });

  test('checkConfig fails when paths.components is missing', async () => {
    await withTestProject(async (root) => {
      await fs.writeJson(path.join(root, 'src', 'sliceConfig.json'), { server: { port: 3000 } });
      const r = await checkConfig();
      assert.equal(r.pass, false);
      assert.match(r.message, /missing paths\.components/);
    });
  });

  test('checkComponents reports OK when every component folder has its .js', async () => {
    await withTestProject(async () => {
      const r = await checkComponents();
      assert.equal(r.pass, true);
      assert.match(r.message, /components checked/);
    });
  });

  test('checkComponents warns when a component folder lacks its .js file', async () => {
    await withTestProject(async (root) => {
      // AppShell ships with AppShell.js; remove it to simulate a broken component.
      const broken = path.join(root, 'src', 'Components', 'AppComponents', 'Broken');
      await fs.ensureDir(broken); // directory with no Broken.js
      const r = await checkComponents();
      assert.equal(r.warn, true);
      assert.match(r.message, /missing files/);
    });
  });
});
