import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Runtime proof for the delegation rule, not just the predicate: a CLI invoked
// from inside another project must still hand over for normal commands, but it
// must run `init` itself. That is the difference between "your project's pinned
// version" and "scaffolding a new project with someone else's version".

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(__dirname, '..', 'client.js');

function hostProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-delegation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const localCli = path.join(root, 'node_modules', 'slicejs-cli');
  fs.mkdirSync(localCli, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'host', private: true }));
  fs.writeFileSync(path.join(localCli, 'client.js'), "console.log('PROJECT_CLI');\n");

  return { root, nested: fs.mkdirSync(path.join(root, 'nested')) || path.join(root, 'nested') };
}

function run(cwd, args) {
  return spawnSync(process.execPath, [CLIENT, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, SLICE_NO_LOCAL_DELEGATION: '' }
  });
}

test('a normal command still delegates to the project CLI', (t) => {
  const { nested } = hostProject(t);

  const result = run(nested, ['--version']);

  assert.match(result.stdout, /PROJECT_CLI/, result.stdout + result.stderr);
});

test('init does not delegate to a CLI found above the current folder', (t) => {
  const { nested } = hostProject(t);

  const result = run(nested, ['init', '--help']);

  assert.doesNotMatch(result.stdout, /PROJECT_CLI/);
  assert.match(result.stdout, /Initialize a new Slice\.js project/);
});
