import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';
import { createTestProject, cleanupTestProject } from './helpers/setup.js';

// `slice build` must hard-fail (exit 1) on a config that would ship a broken
// bundle: ContextManager reactivity is delivered through EventManager, and
// EventManager is only bundled when events.enabled is true — so context on +
// events off would produce a bundle where every context.watch/bind is dead.

test('slice build exits 1 when context.enabled and events disabled', async () => {
  const dir = await createTestProject();
  const prevInitCwd = process.env.INIT_CWD;
  const realExit = process.exit;
  try {
    await fs.writeJson(path.join(dir, 'src', 'sliceConfig.json'), {
      server: { port: 3001 },
      context: { enabled: true },
      events: { enabled: false },
    });
    process.env.INIT_CWD = dir;

    let exitCode = null;
    process.exit = (code) => { exitCode = code; throw new Error('__process_exit__'); };

    const build = (await import('../commands/build/build.js')).default;
    // The guard runs before buildProduction, so the stubbed exit throws first.
    await assert.rejects(() => build({ minify: false, obfuscate: false }), /__process_exit__/);
    assert.equal(exitCode, 1);
  } finally {
    process.exit = realExit;
    if (prevInitCwd === undefined) delete process.env.INIT_CWD; else process.env.INIT_CWD = prevInitCwd;
    await cleanupTestProject(dir);
  }
});
