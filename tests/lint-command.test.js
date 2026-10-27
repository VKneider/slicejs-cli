import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEslint } from '../commands/lint/lint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

test('resolveEslint finds the project binary', () => {
  const bin = resolveEslint(REPO);
  assert.ok(bin, 'eslint is a devDependency of this repo');
  assert.match(bin.replace(/\\/g, '/'), /eslint\/bin\/eslint\.js$/);
});

test('resolveEslint returns null when the project has no ESLint', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-lint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'no-eslint', private: true }));

  assert.equal(resolveEslint(dir), null);
});

test('the command is registered with a fix flag', () => {
  const client = fs.readFileSync(path.join(REPO, 'client.js'), 'utf8');

  assert.match(client, /\.command\("lint \[paths\.\.\.\]"\)/);
  assert.match(client, /\.option\("--fix"/);
});
