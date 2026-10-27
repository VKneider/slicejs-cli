import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { ensurePnpmAllowBuilds } from '../commands/init/init.js';

// pnpm treats an undeclared build script as a hard error on the next install
// (`ERR_PNPM_IGNORED_BUILDS`). A generated project needs two: `slicejs-cli` has a
// postinstall, and `esbuild` (a framework dependency) verifies its binary.
// Missing `esbuild` broke every later `pnpm add` in a freshly scaffolded app.

async function project(t, content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-allow-builds-'));
  t.after(() => fs.remove(dir));
  if (content !== undefined) {
    await fs.writeFile(path.join(dir, 'pnpm-workspace.yaml'), content, 'utf8');
  }
  return dir;
}

const read = (dir) => fs.readFile(path.join(dir, 'pnpm-workspace.yaml'), 'utf8');

test('creates the file with both entries', async (t) => {
  const dir = await project(t);
  await ensurePnpmAllowBuilds(dir);

  const text = await read(dir);
  assert.match(text, /^allowBuilds:$/m);
  assert.match(text, /^ {2}esbuild: true$/m);
  assert.match(text, /^ {2}slicejs-cli: true$/m);
});

test('adds the missing entry to an existing block and keeps the rest', async (t) => {
  const dir = await project(t, "packages:\n  - 'src'\n\nallowBuilds:\n  slicejs-cli: true\n  tldjs: false\n");
  await ensurePnpmAllowBuilds(dir);

  const text = await read(dir);
  assert.match(text, /^packages:$/m, 'unrelated keys must survive');
  assert.match(text, /^ {2}tldjs: false$/m, 'other decisions must survive');
  assert.match(text, /^ {2}esbuild: true$/m);
  assert.equal(text.match(/slicejs-cli: true/g).length, 1, 'no duplicate entry');
});

test('is idempotent', async (t) => {
  const dir = await project(t);
  await ensurePnpmAllowBuilds(dir);
  const first = await read(dir);

  await ensurePnpmAllowBuilds(dir);
  assert.equal(await read(dir), first);
});
