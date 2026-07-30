// Helper modules that import each other in a cycle must fail the build.
//
// Dependency modules are emitted as eagerly-evaluated IIFEs whose imports are
// bound by copying values out of already-registered modules. That is sound for a
// DAG in topological order; a cycle has no such order, so whichever module runs
// first copies from an object that is not populated yet.
//
// Silently registering the exports objects up front would stop the crash but
// leave the copied binding `undefined` forever — a silent wrong value instead of
// a loud failure. Cycles also work in `slice dev`, where each file is a real ES
// module, so leaving this undetected is a dev/production divergence.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import BundleGenerator from '../commands/utils/bundling/BundleGenerator.js';
import ExternalModuleBundler from '../commands/utils/bundling/ExternalModuleBundler.js';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeGenerator() {
  const gen = new BundleGenerator(
    import.meta.url,
    { components: [], routes: [], metrics: { totalComponents: 0, totalRoutes: 0, sharedPercentage: 0, totalSize: 0 } },
    { output: 'src' }
  );
  gen.sliceConfig = { externalDependencies: { enabled: true } };
  return gen;
}

const mod = (name, imports = []) => ({
  name,
  content: `/* ${name} */`,
  moduleImports: imports.map((depName) => ({ depName, bindings: [] }))
});

describe('findDependencyCycle', () => {
  test('a DAG has no cycle', () => {
    const gen = makeGenerator();
    assert.equal(gen.findDependencyCycle([
      mod('a.js', ['b.js', 'c.js']),
      mod('b.js', ['c.js']),
      mod('c.js')
    ]), null);
  });

  test('a direct cycle is found and reads as a loop', () => {
    const gen = makeGenerator();
    const cycle = gen.findDependencyCycle([mod('a.js', ['b.js']), mod('b.js', ['a.js'])]);
    assert.ok(cycle, 'a <-> b must be reported');
    assert.equal(cycle[0], cycle[cycle.length - 1], 'the path must start and end at the same module');
    assert.ok(cycle.includes('a.js') && cycle.includes('b.js'));
  });

  test('an indirect cycle across three modules is found', () => {
    const gen = makeGenerator();
    const cycle = gen.findDependencyCycle([
      mod('a.js', ['b.js']), mod('b.js', ['c.js']), mod('c.js', ['a.js'])
    ]);
    assert.ok(cycle);
    for (const name of ['a.js', 'b.js', 'c.js']) {
      assert.ok(cycle.includes(name), `${name} must appear in the reported path`);
    }
  });

  test('a module importing itself is a cycle', () => {
    const gen = makeGenerator();
    assert.ok(gen.findDependencyCycle([mod('a.js', ['a.js'])]));
  });

  test('a diamond is not a cycle', () => {
    // a -> b, a -> c, b -> d, c -> d
    const gen = makeGenerator();
    assert.equal(gen.findDependencyCycle([
      mod('a.js', ['b.js', 'c.js']), mod('b.js', ['d.js']), mod('c.js', ['d.js']), mod('d.js')
    ]), null);
  });

  test('an import of a module that is not being emitted is ignored', () => {
    const gen = makeGenerator();
    assert.equal(gen.findDependencyCycle([mod('a.js', ['not-emitted.js'])]), null);
  });
});

describe('the error explains the problem and the fix', () => {
  test('it names every module in the cycle', () => {
    const gen = makeGenerator();
    const error = (() => {
      try {
        gen.assertNoDependencyCycles([mod('shared/a.js', ['shared/b.js']), mod('shared/b.js', ['shared/a.js'])]);
        return null;
      } catch (e) { return e; }
    })();

    assert.ok(error, 'must throw');
    assert.match(error.message, /shared\/a\.js/);
    assert.match(error.message, /shared\/b\.js/);
  });

  test('it says why a build differs from dev, and what to do', () => {
    const gen = makeGenerator();
    try {
      gen.assertNoDependencyCycles([mod('a.js', ['b.js']), mod('b.js', ['a.js'])]);
      assert.fail('should have thrown');
    } catch (error) {
      assert.match(error.message, /live bindings/, 'must explain the mechanism');
      assert.match(error.message, /slice dev/, 'must say why dev worked');
      assert.match(error.message, /Break the cycle/, 'must tell the developer what to do');
    }
  });

  test('a DAG passes silently', () => {
    const gen = makeGenerator();
    assert.doesNotThrow(() => gen.assertNoDependencyCycles([mod('a.js', ['b.js']), mod('b.js')]));
  });
});

describe('a real project with a cycle fails to build', () => {
  test('generate() rejects instead of emitting a bundle that throws on load', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-cycle-'));
    try {
      await fs.symlink(path.join(CLI_ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
      const sharedDir = path.join(tmp, 'src', 'Components', 'Visual', 'shared');
      await fs.ensureDir(sharedDir);
      await fs.writeFile(path.join(sharedDir, 'a.js'), "import { B } from './b.js';\nexport const A = 'a';\nexport const useB = () => B;\n");
      await fs.writeFile(path.join(sharedDir, 'b.js'), "import { A } from './a.js';\nexport const B = 'b';\nexport const useA = () => A;\n");

      const dir = path.join(tmp, 'src', 'Components', 'Visual', 'Alpha');
      await fs.ensureDir(dir);
      await fs.writeFile(path.join(dir, 'Alpha.js'),
        "import { A } from '../shared/a.js';\nexport default class Alpha { r() { return A; } }");

      const gen = new BundleGenerator(import.meta.url, {
        components: [{
          name: 'Alpha', category: 'Visual', categoryType: 'Visual', path: dir,
          dependencies: new Set(), routes: new Set(['/alpha']), size: 3000
        }],
        routes: [{ path: '/alpha', component: 'Alpha', dependencies: new Set(['Alpha']) }],
        routeGroups: new Map(),
        metrics: { totalComponents: 1, totalRoutes: 1, sharedPercentage: 0, totalSize: 3000 }
      }, { output: 'src' });
      gen.sliceConfig = { externalDependencies: { enabled: true } };
      gen.srcPath = path.join(tmp, 'src');
      gen.bundlesPath = path.join(tmp, 'src', 'bundles');
      gen.distPath = path.join(tmp, 'dist');
      gen.externalBundler = new ExternalModuleBundler({ resolveDir: tmp });

      const real = { log: console.log, warn: console.warn, error: console.error };
      console.log = () => {}; console.warn = () => {}; console.error = () => {};
      let error = null;
      try {
        await gen.generate();
      } catch (e) {
        error = e;
      } finally {
        Object.assign(console, real);
      }

      assert.ok(error, 'the build must fail rather than emit a broken bundle');
      assert.match(error.message, /Circular import/);
      assert.match(error.message, /a\.js/);
      assert.match(error.message, /b\.js/);

      // And nothing was written.
      const emitted = (await fs.pathExists(gen.bundlesPath))
        ? (await fs.readdir(gen.bundlesPath)).filter((f) => f.endsWith('.js'))
        : [];
      assert.deepEqual(emitted, [], 'no bundle should reach disk');
    } finally {
      await fs.remove(tmp);
    }
  });
});
