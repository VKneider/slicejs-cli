import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { setupLint, ESLINT_CONFIG_FILE } from '../commands/setup/lint.js';

// The command is idempotent and never touches a config the project already has.
// Installing is injected so these tests stay offline.

async function project(t, { withTools = true, pkg = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-setup-lint-'));
  t.after(() => fs.remove(dir));

  await fs.writeJson(path.join(dir, 'package.json'), {
    name: 'demo',
    version: '1.0.0',
    scripts: {},
    ...pkg
  });

  if (withTools) {
    for (const name of ['eslint', 'slicejs-cli']) {
      await fs.outputJson(path.join(dir, 'node_modules', name, 'package.json'), { name, version: '1.0.0' });
    }
  }

  return dir;
}

test('writes the config and the scripts', async (t) => {
  const dir = await project(t);

  const result = await setupLint({ projectRoot: dir });

  assert.equal(result.ok, true);
  const config = await fs.readFile(path.join(dir, ESLINT_CONFIG_FILE), 'utf8');
  assert.match(config, /import slice from 'slicejs-cli\/eslint-config\.js'/);

  const pkg = await fs.readJson(path.join(dir, 'package.json'));
  assert.equal(pkg.scripts.lint, 'slice lint');
  assert.equal(pkg.scripts['lint:fix'], 'slice lint --fix');
});

test('keeps an existing eslint config untouched', async (t) => {
  const dir = await project(t);
  const configPath = path.join(dir, ESLINT_CONFIG_FILE);
  const mine = "export default [{ rules: { 'no-console': 'error' } }];\n";
  await fs.writeFile(configPath, mine);

  const result = await setupLint({ projectRoot: dir });

  assert.equal(await fs.readFile(configPath, 'utf8'), mine);
  assert.ok(result.actions.some((action) => action.kind === 'keep' && /already exists/.test(action.detail)));
});

test('does not overwrite a script the project already wires', async (t) => {
  const dir = await project(t, { pkg: { scripts: { lint: 'biome check' } } });

  await setupLint({ projectRoot: dir });

  const pkg = await fs.readJson(path.join(dir, 'package.json'));
  assert.equal(pkg.scripts.lint, 'biome check');
  assert.equal(pkg.scripts['lint:fix'], 'slice lint --fix', 'the missing one is still added');
});

test('installs the missing tools as devDependencies', async (t) => {
  const dir = await project(t, { withTools: false });
  const commands = [];

  const result = await setupLint({ projectRoot: dir, runInstall: async (command) => commands.push(command) });

  assert.equal(commands.length, 1);
  assert.match(commands[0], /eslint/);
  assert.match(commands[0], /slicejs-cli/);
  assert.ok(result.actions.some((action) => action.kind === 'install'));
});

test('dry run reports the plan and writes nothing', async (t) => {
  const dir = await project(t);
  const before = await fs.readFile(path.join(dir, 'package.json'), 'utf8');

  const result = await setupLint({ projectRoot: dir, dryRun: true });

  assert.equal(result.ok, true);
  assert.equal(await fs.pathExists(path.join(dir, ESLINT_CONFIG_FILE)), false);
  assert.equal(await fs.readFile(path.join(dir, 'package.json'), 'utf8'), before);
  assert.ok(result.actions.some((action) => action.kind === 'write'));
});

test('is idempotent', async (t) => {
  const dir = await project(t);

  await setupLint({ projectRoot: dir });
  const first = await fs.readFile(path.join(dir, 'package.json'), 'utf8');
  const firstConfig = await fs.readFile(path.join(dir, ESLINT_CONFIG_FILE), 'utf8');

  await setupLint({ projectRoot: dir });

  assert.equal(await fs.readFile(path.join(dir, 'package.json'), 'utf8'), first);
  assert.equal(await fs.readFile(path.join(dir, ESLINT_CONFIG_FILE), 'utf8'), firstConfig);
});

test('fails clearly outside a project', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-setup-empty-'));
  t.after(() => fs.remove(dir));

  const result = await setupLint({ projectRoot: dir });

  assert.equal(result.ok, false);
  assert.match(result.error, /package\.json/);
});

test('--with-types installs TypeScript and adds the typecheck script', async (t) => {
  const dir = await project(t);

  const commands = [];
  const result = await setupLint({ projectRoot: dir, withTypes: true, runInstall: async (command) => commands.push(command) });

  assert.match(commands[0], /typescript/);
  const pkg = await fs.readJson(path.join(dir, 'package.json'));
  assert.equal(pkg.scripts.typecheck, 'slice typecheck');
  assert.ok(result.actions.some((action) => action.kind === 'install'));
});

test('--with-types generates the declarations and the jsconfig', async (t) => {
  const dir = await project(t, { withTools: false });
  await fs.outputFile(
    path.join(dir, 'src', 'Components', 'components.js'),
    'const components = {};\n\nexport default components;\n'
  );

  const result = await setupLint({ projectRoot: dir, withTypes: true, runInstall: async () => {} });

  assert.ok(result.actions.some((action) => action.kind === 'types'), JSON.stringify(result.actions));
  assert.ok(await fs.pathExists(path.join(dir, 'src', 'slice-build.generated.d.ts')));
  const jsconfig = await fs.readJson(path.join(dir, 'jsconfig.json'));
  assert.equal(jsconfig.compilerOptions.target, 'ES2022');
});
