import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTestProject } from './helpers/setup.js';
import updateManager from '../commands/utils/updateManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Overwriting the project's api/index.js is opt-in (`--update-api`): the file may
// carry local changes, so a blanket `-y` must never silently replace it.

const PROJECT_API = 'project version with local changes\n';
const FRAMEWORK_API = 'newer framework version\n';

async function seedApiFiles(tmpDir) {
  const projectApi = path.join(tmpDir, 'api', 'index.js');
  const frameworkApi = path.join(tmpDir, 'node_modules', 'slicejs-web-framework', 'api', 'index.js');
  await fs.outputFile(projectApi, PROJECT_API);
  await fs.outputFile(frameworkApi, FRAMEWORK_API);
  return { projectApi, frameworkApi };
}

describe('updateApiIndexIfNeeded opt-in behavior', () => {
  test('-y/--yes alone does NOT overwrite api/index.js', async () => {
    await withTestProject(async (tmpDir) => {
      const { projectApi } = await seedApiFiles(tmpDir);

      await updateManager.updateApiIndexIfNeeded({ yes: true });

      assert.equal(await fs.readFile(projectApi, 'utf-8'), PROJECT_API, 'api/index.js must stay untouched with -y');
      assert.ok(!(await fs.pathExists(`${projectApi}.bak`)), 'no backup must be created when nothing is overwritten');
    });
  });

  test('--update-api overwrites api/index.js and creates a .bak backup', async () => {
    await withTestProject(async (tmpDir) => {
      const { projectApi } = await seedApiFiles(tmpDir);

      await updateManager.updateApiIndexIfNeeded({ updateApi: true });

      assert.equal(await fs.readFile(projectApi, 'utf-8'), FRAMEWORK_API, 'api/index.js must be updated with --update-api');
      assert.equal(await fs.readFile(`${projectApi}.bak`, 'utf-8'), PROJECT_API, '.bak must preserve the previous content');
    });
  });

  test('identical files are left alone even with --update-api', async () => {
    await withTestProject(async (tmpDir) => {
      const { projectApi, frameworkApi } = await seedApiFiles(tmpDir);
      await fs.outputFile(frameworkApi, PROJECT_API); // same content

      await updateManager.updateApiIndexIfNeeded({ updateApi: true });

      assert.ok(!(await fs.pathExists(`${projectApi}.bak`)), 'no backup when contents already match');
    });
  });

  test('client.js exposes --update-api on the update command', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf-8');
    assert.ok(source.includes('--update-api'), 'update command must expose --update-api');
  });
});

describe('updatePackage install strategy', () => {
  test('updateManager never uninstalls before installing', () => {
    // Uninstall-then-install left the project without the package whenever the
    // install step failed (offline, pnpm release-age policy). Install in place.
    const source = fs.readFileSync(path.join(__dirname, '..', 'commands', 'utils', 'updateManager.js'), 'utf-8');
    assert.ok(!source.includes('uninstallCommand'), 'updateManager must not build uninstall commands');
    assert.ok(!source.includes('npm uninstall'), 'updateManager must not run npm uninstall');
    assert.ok(!source.includes('pnpm remove'), 'updateManager must not run pnpm remove');
  });
});
