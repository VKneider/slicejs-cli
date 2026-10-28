import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withTestProject } from './helpers/setup.js';
import { resolveProjectConfig, resolveTypeScript } from '../commands/typecheck/typecheck.js';
import { payloadToTs, runGenerateTypes } from '../commands/types/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(__dirname, '..', 'client.js');

async function project(t, { typescript = null } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-typecheck-'));
  t.after(() => fs.remove(dir));
  await fs.writeJson(path.join(dir, 'package.json'), { name: 'demo', private: true });

  if (typescript !== null) {
    const root = path.join(dir, 'node_modules', 'typescript');
    await fs.outputJson(path.join(root, 'package.json'), { name: 'typescript', version: '5.0.0' });
    await fs.outputFile(path.join(root, 'bin', 'tsc'), `console.log('fake tsc');\nprocess.exit(${typescript});\n`);
    await fs.writeJson(path.join(dir, 'jsconfig.json'), { compilerOptions: { checkJs: true }, include: ['src/**/*.js'] });
  }

  return dir;
}

const runTypecheck = (cwd) => spawnSync(process.execPath, [CLIENT, 'typecheck'], {
  cwd,
  encoding: 'utf-8',
  env: { ...process.env, INIT_CWD: cwd, SLICE_NO_LOCAL_DELEGATION: '1', NO_COLOR: '1' }
});

test('resolveTypeScript reads the project install', async (t) => {
  const dir = await project(t, { typescript: 0 });
  assert.match(resolveTypeScript(dir).replace(/\\/g, '/'), /typescript\/bin\/tsc$/);

  const empty = await project(t);
  assert.equal(resolveTypeScript(empty), null);
});

test('resolveProjectConfig prefers jsconfig, then tsconfig', async (t) => {
  const dir = await project(t);
  assert.equal(resolveProjectConfig(dir), null);

  await fs.writeJson(path.join(dir, 'tsconfig.json'), {});
  assert.equal(path.basename(resolveProjectConfig(dir)), 'tsconfig.json');

  await fs.writeJson(path.join(dir, 'jsconfig.json'), {});
  assert.equal(path.basename(resolveProjectConfig(dir)), 'jsconfig.json');
});

test('a clean project exits 0', async (t) => {
  const dir = await project(t, { typescript: 0 });
  const result = runTypecheck(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('type errors propagate the compiler exit code', async (t) => {
  const dir = await project(t, { typescript: 3 });
  const result = runTypecheck(dir);
  assert.equal(result.status, 3);
});

test('missing TypeScript fails with an install hint', async (t) => {
  const dir = await project(t);
  const result = runTypecheck(dir);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /TypeScript is not installed/);
});

test('missing config points at slice types generate', async (t) => {
  const dir = await project(t, { typescript: 0 });
  await fs.remove(path.join(dir, 'jsconfig.json'));
  const result = runTypecheck(dir);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /slice types generate/);
});

test('event payload fields are optional', () => {
  assert.equal(payloadToTs({ title: 'string', danger: 'boolean' }), '{ title?: string; danger?: boolean }');
});

test('the generated jsconfig type-checks modern JS and skips specs', async (t) => {
  const dir = await project(t);
  await fs.outputFile(path.join(dir, 'src', 'AppConfig.js'), 'export const x = 1;\n');
  await fs.outputFile(path.join(dir, 'src', 'Components', 'components.js'), 'const components = {};\n\nexport default components;\n');

  await runGenerateTypes({
    projectRoot: dir,
    outputPath: path.join(dir, 'src', 'slice-build.generated.d.ts')
  });

  const jsconfig = await fs.readJson(path.join(dir, 'jsconfig.json'));
  assert.equal(jsconfig.compilerOptions.target, 'ES2022');
  assert.deepEqual(jsconfig.compilerOptions.lib, ['ES2022', 'DOM', 'DOM.Iterable']);
  assert.equal(jsconfig.compilerOptions.noEmit, true);
  assert.ok(jsconfig.exclude.includes('**/*.spec.js'));
});

test('typecheck refreshes stale declarations first', async () => {
  await withTestProject(async (root) => {
    await fs.outputJson(path.join(root, 'node_modules', 'typescript', 'package.json'), { name: 'typescript', version: '5.0.0' });
    await fs.outputFile(path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), 'process.exit(0);\n');
    await fs.writeJson(path.join(root, 'jsconfig.json'), { compilerOptions: { checkJs: true } });
    await fs.outputFile(path.join(root, 'src', 'slice-build.generated.d.ts'), '// stale\n');

    const result = spawnSync(process.execPath, [CLIENT, 'typecheck'], {
      cwd: root,
      encoding: 'utf-8',
      env: { ...process.env, INIT_CWD: root, SLICE_NO_LOCAL_DELEGATION: '1', NO_COLOR: '1' }
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(`${result.stdout}${result.stderr}`, /Updated generated types/);
    const declaration = await fs.readFile(path.join(root, 'src', 'slice-build.generated.d.ts'), 'utf8');
    assert.match(declaration, /WidgetProps/);
  }, { visualComponents: ['Widget'] });
});
