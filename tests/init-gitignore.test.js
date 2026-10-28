import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { ensureGitignore } from '../commands/init/init.js';

// `slice build` writes dist/ and `slice build` is not a commit; a project without
// a .gitignore ships node_modules and the build output to git on the first
// `git add .`. This was missing from the generated starter.

async function project(t, content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-gitignore-'));
  t.after(() => fs.remove(dir));
  if (content !== undefined) {
    await fs.writeFile(path.join(dir, '.gitignore'), content, 'utf8');
  }
  return dir;
}

const read = (dir) => fs.readFile(path.join(dir, '.gitignore'), 'utf8');

test('creates a .gitignore that ignores dependencies and the build output', async (t) => {
  const dir = await project(t);
  const written = await ensureGitignore(dir);

  assert.equal(written, path.join(dir, '.gitignore'));
  const text = await read(dir);
  assert.match(text, /^node_modules\/$/m);
  assert.match(text, /^dist\/$/m);
});

test('leaves an existing .gitignore untouched', async (t) => {
  const original = '# project rules\ncoverage/\n';
  const dir = await project(t, original);

  const written = await ensureGitignore(dir);

  assert.equal(written, null);
  assert.equal(await read(dir), original);
});

test('is idempotent', async (t) => {
  const dir = await project(t);
  await ensureGitignore(dir);
  const first = await read(dir);

  await ensureGitignore(dir);
  assert.equal(await read(dir), first);
});
