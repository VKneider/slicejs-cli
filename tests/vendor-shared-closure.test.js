// The vendor-shared bundle must contain the whole dependency closure of every
// module it extracts.
//
// computeSharedDependencySet() picked modules by usage count and transformed
// size. A helper over minVendorSharedTransformedSize (2KB) was extracted while a
// module it imports, being smaller, was not — so the helper's IIFE inside
// vendor-shared bound a key that vendor-shared never registered. The bundle then
// threw while *loading* (`Cannot read properties of undefined`), taking the
// whole app down, since vendor-shared loads before anything renders.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import BundleGenerator from '../commands/utils/bundling/BundleGenerator.js';
import ExternalModuleBundler from '../commands/utils/bundling/ExternalModuleBundler.js';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Padding that pushes a helper over minVendorSharedTransformedSize.
const padding = (tag) => Array.from({ length: 60 }, (_, i) =>
  `export function ${tag}${i}() { return "padding-value-so-this-helper-exceeds-two-kilobytes-${i}"; }`
).join('\n');

async function buildProject(files) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-closure-'));
  await fs.symlink(path.join(CLI_ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');

  const sharedDir = path.join(tmp, 'src', 'Components', 'Visual', 'shared');
  await fs.ensureDir(sharedDir);
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(sharedDir, name), content);
  }

  // Two components on separate routes, both importing the entry helper, so it
  // clears minVendorSharedUsage.
  const makeComp = async (name) => {
    const dir = path.join(tmp, 'src', 'Components', 'Visual', name);
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, `${name}.js`), [
      "import { label } from '../shared/big.js';",
      `export default class ${name} { render() { return label('x'); } }`
    ].join('\n'));
    return {
      name, category: 'Visual', categoryType: 'Visual', path: dir,
      dependencies: new Set(), routes: new Set([`/${name.toLowerCase()}`]), size: 3000
    };
  };

  const gen = new BundleGenerator(import.meta.url, {
    components: [await makeComp('Alpha'), await makeComp('Beta')],
    routes: [
      { path: '/alpha', component: 'Alpha', dependencies: new Set(['Alpha']) },
      { path: '/beta', component: 'Beta', dependencies: new Set(['Beta']) }
    ],
    routeGroups: new Map(),
    metrics: { totalComponents: 2, totalRoutes: 2, sharedPercentage: 0, totalSize: 6000 }
  }, { output: 'src' });
  gen.sliceConfig = { externalDependencies: { enabled: true } };
  gen.srcPath = path.join(tmp, 'src');
  gen.bundlesPath = path.join(tmp, 'src', 'bundles');
  gen.distPath = path.join(tmp, 'dist');
  gen.externalBundler = new ExternalModuleBundler({ resolveDir: tmp });

  const result = await gen.generate();
  return { tmp, gen, result, bundlesDir: path.join(tmp, 'src', 'bundles') };
}

const KEY = (name) => `Components/Visual/shared/${name}`;

describe('vendor-shared dependency closure', () => {
  test('a sub-dependency below the size threshold is pulled in with its consumer', async () => {
    // small.js is far below 2KB, so on its own it never qualifies.
    const { tmp, bundlesDir } = await buildProject({
      'small.js': 'export const TAG = "tag";\n',
      'big.js': [
        "import { TAG } from './small.js';",
        "export function label(n) { return TAG + ':' + n; }",
        padding('pad')
      ].join('\n')
    });

    try {
      const vendorPath = path.join(bundlesDir, 'slice-bundle.vendor-shared.js');
      assert.ok(await fs.pathExists(vendorPath), 'vendor-shared should be emitted');
      const text = await fs.readFile(vendorPath, 'utf8');

      assert.ok(text.includes(`SLICE_BUNDLE_DEPENDENCIES[${JSON.stringify(KEY('big.js'))}]`),
        'big.js must be registered');
      assert.ok(text.includes(`SLICE_BUNDLE_DEPENDENCIES[${JSON.stringify(KEY('small.js'))}] =`),
        'small.js must be registered alongside it');

      // Topological order: small.js before the module that consumes it.
      const smallIdx = text.indexOf(`SLICE_BUNDLE_DEPENDENCIES[${JSON.stringify(KEY('small.js'))}] =`);
      const bigIdx = text.indexOf(`SLICE_BUNDLE_DEPENDENCIES[${JSON.stringify(KEY('big.js'))}] =`);
      assert.ok(smallIdx !== -1 && bigIdx !== -1);
      assert.ok(smallIdx < bigIdx, 'small.js must be emitted before big.js');

      // Functional: loading the bundle must not throw, and the helper must work.
      const mod = await import(`file://${vendorPath}?t=${process.hrtime.bigint()}`);
      const deps = await mod.registerAll();
      assert.equal(deps[KEY('big.js')].label('x'), 'tag:x');
    } finally {
      await fs.remove(tmp);
    }
  });

  test('the closure is followed through more than one level', async () => {
    const { tmp, bundlesDir } = await buildProject({
      'leaf.js': 'export const LEAF = "leaf";\n',
      'middle.js': "import { LEAF } from './leaf.js';\nexport const MID = LEAF + '-mid';\n",
      'big.js': [
        "import { MID } from './middle.js';",
        "export function label(n) { return MID + ':' + n; }",
        padding('pad')
      ].join('\n')
    });

    try {
      const vendorPath = path.join(bundlesDir, 'slice-bundle.vendor-shared.js');
      const text = await fs.readFile(vendorPath, 'utf8');
      for (const name of ['leaf.js', 'middle.js', 'big.js']) {
        assert.ok(
          text.includes(`SLICE_BUNDLE_DEPENDENCIES[${JSON.stringify(KEY(name))}] =`),
          `${name} must be registered in vendor-shared`
        );
      }

      const mod = await import(`file://${vendorPath}?t=${process.hrtime.bigint()}`);
      const deps = await mod.registerAll();
      assert.equal(deps[KEY('big.js')].label('x'), 'leaf-mid:x');
    } finally {
      await fs.remove(tmp);
    }
  });

  test('a dependency cycle terminates the closure walk and fails the build', async () => {
    // The closure expansion must not hang on a cycle (it tracks visited
    // modules). Emission then refuses the cycle outright, because eager IIFEs
    // cannot reproduce ESM live bindings — see
    // tests/dependency-cycle-detection.test.js.
    const error = await buildProject({
      'a.js': "import { B } from './b.js';\nexport const A = 'a';\nexport const AB = () => B;\n" + padding('a'),
      'b.js': "import { A } from './a.js';\nexport const B = 'b';\nexport const BA = () => A;\n" + padding('b'),
      'big.js': [
        "import { A } from './a.js';",
        "export function label(n) { return A + ':' + n; }",
        padding('pad')
      ].join('\n')
    }).then(() => null, (e) => e);

    assert.ok(error, 'a cycle must fail the build');
    assert.match(error.message, /Circular import/);
  });

  test('a bundle that uses only the pulled-in module still loads vendor-shared', async () => {
    // The dangerous case: Gamma imports small.js directly and never touches
    // big.js. small.js only became shared through the closure expansion, so if
    // its usage entry were not consulted, Gamma's bundle would omit small.js
    // (it is in sharedDependencySet) without declaring vendor-shared — and
    // resolve undefined at runtime.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-closure-third-'));
    try {
      await fs.symlink(path.join(CLI_ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
      const sharedDir = path.join(tmp, 'src', 'Components', 'Visual', 'shared');
      await fs.ensureDir(sharedDir);
      await fs.writeFile(path.join(sharedDir, 'small.js'), 'export const TAG = "tag";\n');
      await fs.writeFile(path.join(sharedDir, 'big.js'), [
        "import { TAG } from './small.js';",
        "export function label(n) { return TAG + ':' + n; }",
        padding('pad')
      ].join('\n'));

      const mk = async (name, importLine, body) => {
        const dir = path.join(tmp, 'src', 'Components', 'Visual', name);
        await fs.ensureDir(dir);
        await fs.writeFile(path.join(dir, `${name}.js`), [
          importLine,
          `export default class ${name} { render() { return ${body}; } }`
        ].join('\n'));
        return {
          name, category: 'Visual', categoryType: 'Visual', path: dir,
          dependencies: new Set(), routes: new Set([`/${name.toLowerCase()}`]), size: 3000
        };
      };

      const components = [
        await mk('Alpha', "import { label } from '../shared/big.js';", "label('x')"),
        await mk('Beta', "import { label } from '../shared/big.js';", "label('y')"),
        await mk('Gamma', "import { TAG } from '../shared/small.js';", 'TAG')
      ];

      const gen = new BundleGenerator(import.meta.url, {
        components,
        routes: [
          { path: '/alpha', component: 'Alpha', dependencies: new Set(['Alpha']) },
          { path: '/beta', component: 'Beta', dependencies: new Set(['Beta']) },
          { path: '/gamma', component: 'Gamma', dependencies: new Set(['Gamma']) }
        ],
        routeGroups: new Map(),
        metrics: { totalComponents: 3, totalRoutes: 3, sharedPercentage: 0, totalSize: 9000 }
      }, { output: 'src' });
      gen.sliceConfig = { externalDependencies: { enabled: true } };
      gen.srcPath = path.join(tmp, 'src');
      gen.bundlesPath = path.join(tmp, 'src', 'bundles');
      gen.distPath = path.join(tmp, 'dist');
      gen.externalBundler = new ExternalModuleBundler({ resolveDir: tmp });

      const result = await gen.generate();

      // Find whichever bundle carries Gamma.
      const routes = result.config.bundles.routes || {};
      const gammaKey = Object.keys(routes).find((key) => (routes[key].components || []).includes('Gamma'));
      assert.ok(gammaKey, `no bundle contains Gamma (bundles: ${Object.keys(routes).join(', ')})`);

      assert.ok(
        (routes[gammaKey].dependencies || []).includes('vendor-shared'),
        `${gammaKey} uses small.js, which vendor-shared now owns, so it must declare that dependency`
      );

      const bundleText = await fs.readFile(path.join(gen.bundlesPath, routes[gammaKey].file), 'utf8');
      assert.ok(
        !bundleText.includes(`SLICE_BUNDLE_DEPENDENCIES[${JSON.stringify(KEY('small.js'))}] =`),
        'and must not inline its own copy'
      );
      // Its binding has to go through the shared resolver, not the local map.
      assert.match(bundleText, /__sliceResolveBundleDependency/);
    } finally {
      await fs.remove(tmp);
    }
  });

  test('route bundles omit what vendor-shared now owns and declare the dependency', async () => {
    const { tmp, bundlesDir, result } = await buildProject({
      'small.js': 'export const TAG = "tag";\n',
      'big.js': [
        "import { TAG } from './small.js';",
        "export function label(n) { return TAG + ':' + n; }",
        padding('pad')
      ].join('\n')
    });

    try {
      const files = (await fs.readdir(bundlesDir)).filter((f) => f.endsWith('.js') && !f.includes('config'));
      for (const file of files) {
        if (file.includes('vendor-shared')) continue;
        const text = await fs.readFile(path.join(bundlesDir, file), 'utf8');
        assert.ok(
          !text.includes(`SLICE_BUNDLE_DEPENDENCIES[${JSON.stringify(KEY('small.js'))}] =`),
          `${file} must not inline small.js once vendor-shared owns it`
        );
      }

      const shared = result.config.bundles.vendorShared?.dependencies || [];
      assert.ok(shared.includes(KEY('small.js')), 'the config must advertise small.js as shared');
      assert.ok(shared.includes(KEY('big.js')));
    } finally {
      await fs.remove(tmp);
    }
  });
});
