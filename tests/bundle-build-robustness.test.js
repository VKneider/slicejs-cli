// End-to-end robustness sweep: for a range of project shapes, every bundle the
// generator emits must parse, evaluate, and register its components.
//
// The existing bundling tests check transformDependencyContent's semantics and
// the rebalancer's bookkeeping, but none of them ever *loads* an emitted bundle.
// Both bundler bugs found so far only showed up at load time — invalid syntax
// inside a class factory, and a vendor-shared module bound to a key nothing
// registered — so that is the gap this closes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { parse } from '@babel/parser';
import { fileURLToPath } from 'node:url';
import BundleGenerator from '../commands/utils/bundling/BundleGenerator.js';
import ExternalModuleBundler from '../commands/utils/bundling/ExternalModuleBundler.js';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal browser surface the emitted bundles touch while evaluating. */
function installDomStubs() {
  globalThis.window = globalThis;
  globalThis.HTMLElement = globalThis.HTMLElement || class HTMLElement {};
  globalThis.customElements = globalThis.customElements || { define() {}, get() { return undefined; } };
  const el = () => ({
    setAttribute() {}, appendChild() {}, removeAttribute() {},
    classList: { add() {}, remove() {} }, style: {}, innerHTML: '', children: []
  });
  globalThis.document = globalThis.document || {
    createElement: el, createElementNS: el, createTextNode: el,
    head: el(), body: el(), documentElement: el(),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}
  };
  globalThis.localStorage = globalThis.localStorage || {
    getItem: () => null, setItem() {}, removeItem() {}, length: 0
  };
}

/**
 * Runs `fn` with the generator's progress output muted.
 *
 * BundleGenerator logs a line per bundle, and these tests generate dozens. That
 * volume corrupts the node:test IPC channel between the runner and this file
 * ("Unable to deserialize cloned data"), so the noise has to stay out of stdout.
 */
async function muted(fn) {
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, real);
  }
}

/**
 * Builds a temp project and generates its bundles.
 * @param {object} spec
 * @param {Array<{name: string, source?: string, routes?: string[]}>} spec.components
 * @param {Record<string, string>} [spec.helpers] shared/<name> -> source
 * @param {number} [spec.size] declared component size, drives bundling strategy
 */
async function generateProject({ components, helpers = {}, size = 3000 }) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-robust-'));
  await fs.symlink(path.join(CLI_ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');

  if (Object.keys(helpers).length > 0) {
    const sharedDir = path.join(tmp, 'src', 'Components', 'Visual', 'shared');
    await fs.ensureDir(sharedDir);
    for (const [file, content] of Object.entries(helpers)) {
      await fs.writeFile(path.join(sharedDir, file), content);
    }
  }

  const analysisComponents = [];
  const routes = [];
  for (const comp of components) {
    const dir = path.join(tmp, 'src', 'Components', 'Visual', comp.name);
    await fs.ensureDir(dir);
    await fs.writeFile(
      path.join(dir, `${comp.name}.js`),
      // The class name must match the component name: cleanJavaScript emits
      // `window.<componentName> = <componentName>` and `return <componentName>`.
      comp.source ?? `export default class ${comp.name} { r() { return 1; } }`
    );
    const compRoutes = comp.routes ?? [`/${comp.name.toLowerCase()}`];
    analysisComponents.push({
      name: comp.name, category: 'Visual', categoryType: 'Visual', path: dir,
      dependencies: new Set(), routes: new Set(compRoutes), size
    });
    for (const r of compRoutes) {
      if (!routes.some((existing) => existing.path === r)) {
        routes.push({ path: r, component: comp.name, dependencies: new Set([comp.name]) });
      }
    }
  }

  const gen = new BundleGenerator(import.meta.url, {
    components: analysisComponents,
    routes,
    routeGroups: new Map(),
    metrics: {
      totalComponents: analysisComponents.length,
      totalRoutes: routes.length,
      sharedPercentage: 0,
      totalSize: analysisComponents.length * size
    }
  }, { output: 'src' });
  gen.sliceConfig = { externalDependencies: { enabled: true } };
  gen.srcPath = path.join(tmp, 'src');
  gen.bundlesPath = path.join(tmp, 'src', 'bundles');
  gen.distPath = path.join(tmp, 'dist');
  gen.externalBundler = new ExternalModuleBundler({ resolveDir: tmp });

  const result = await muted(() => gen.generate());
  return { tmp, gen, result, bundlesDir: gen.bundlesPath };
}

/**
 * Parses and evaluates every emitted bundle, in the order the runtime would:
 * vendor-shared first (publishing its exports the way
 * Controller.registerVendorSharedDependencies does), then the rest.
 * @returns {Promise<{files: string[], registered: string[]}>}
 */
async function loadAllBundles(bundlesDir) {
  installDomStubs();
  const files = (await fs.readdir(bundlesDir))
    .filter((f) => f.endsWith('.js') && !f.includes('bundle.config'))
    .sort();

  for (const file of files) {
    const text = await fs.readFile(path.join(bundlesDir, file), 'utf8');
    assert.doesNotThrow(
      () => parse(text, { sourceType: 'module' }),
      `${file} must parse as an ES module`
    );
  }

  const controller = { classes: new Map(), templates: new Map(), componentCategories: new Map() };
  const stylesManager = { registerComponentStyles() {}, __sliceRegisteredComponentStyles: new Set() };

  window.__SLICE_SHARED_DEPS__ = {};
  const ordered = [
    ...files.filter((f) => f.includes('vendor-shared')),
    ...files.filter((f) => !f.includes('vendor-shared'))
  ];

  for (const file of ordered) {
    const url = `file://${path.join(bundlesDir, file)}?t=${process.hrtime.bigint()}`;
    const mod = await import(url);
    assert.equal(typeof mod.registerAll, 'function', `${file} must export registerAll`);
    const registered = await mod.registerAll(controller, stylesManager);
    if (file.includes('vendor-shared') && registered) {
      Object.assign(window.__SLICE_SHARED_DEPS__, registered);
    }
  }

  return { files, registered: [...controller.classes.keys()] };
}

const padTo = (bytes, tag) => {
  // Rough filler; the exact length only has to straddle the threshold.
  let out = '';
  let i = 0;
  while (out.length < bytes) {
    out += `export const ${tag}${i} = "${'x'.repeat(20)}";\n`;
    i += 1;
  }
  return out;
};

describe('the generator survives awkward project shapes', () => {
  const shapes = [
    {
      label: 'a single component',
      spec: { components: [{ name: 'Solo' }] }
    },
    {
      label: 'component names with digits and underscores',
      spec: {
        components: [{ name: 'my_btn' }, { name: 'Btn2' }, { name: 'X' }]
      }
    },
    {
      label: 'many components, forcing splits over maxRouteBundleSize',
      spec: {
        components: Array.from({ length: 24 }, (_, i) => ({ name: `Comp${i}` })),
        size: 20000
      }
    },
    {
      label: 'more components than maxCriticalComponents, all on one route',
      spec: {
        components: Array.from({ length: 20 }, (_, i) => ({ name: `Crit${i}`, routes: ['/'] })),
        size: 500
      }
    },
    {
      label: 'a deep chain of relative helpers',
      spec: {
        helpers: {
          'l0.js': 'export const L0 = "0";\n',
          'l1.js': "import { L0 } from './l0.js';\nexport const L1 = L0 + '1';\n",
          'l2.js': "import { L1 } from './l1.js';\nexport const L2 = L1 + '2';\n",
          'l3.js': "import { L2 } from './l2.js';\nexport const L3 = L2 + '3';\n",
          'l4.js': "import { L3 } from './l3.js';\nexport function deep() { return L3 + '4'; }\n" + padTo(2500, 'deep')
        },
        components: [
          { name: 'Alpha', source: "import { deep } from '../shared/l4.js';\nexport default class Alpha { r() { return deep(); } }" },
          { name: 'Beta', source: "import { deep } from '../shared/l4.js';\nexport default class Beta { r() { return deep(); } }" }
        ]
      }
    },
    {
      label: 'a component with module-level top-level await',
      spec: {
        components: [
          { name: 'Awaiter', source: 'const cfg = await Promise.resolve(1);\nexport default class Awaiter { r() { return cfg; } }' },
          { name: 'Plain' }
        ]
      }
    },
    {
      label: 'a component with named module-level exports',
      spec: {
        components: [
          { name: 'Exporter', source: 'export const TAG = 1;\nexport function help() { return TAG; }\nexport default class Exporter { r() { return help(); } }' },
          { name: 'Plain' }
        ]
      }
    }
  ];

  for (const { label, spec } of shapes) {
    test(`${label}: every emitted bundle parses, loads and registers`, async () => {
      const { tmp, bundlesDir } = await generateProject(spec);
      try {
        const { files, registered } = await loadAllBundles(bundlesDir);
        assert.ok(files.length > 0, 'the project must emit at least one bundle');
        assert.ok(registered.length > 0, `no component registered (bundles: ${files.join(', ')})`);
      } finally {
        await fs.remove(tmp);
      }
    });
  }
});

describe('the vendor-shared size threshold has no broken boundary', () => {
  // minVendorSharedTransformedSize is 2 * 1024. A helper on either side of it
  // must produce a loadable bundle — the transitive-closure bug only appeared
  // when a consumer cleared the threshold and its dependency did not.
  const around = [
    ['well under the threshold', 400],
    ['just under the threshold', 2000],
    ['around the threshold', 2048],
    ['just over the threshold', 2100],
    ['well over the threshold', 8000]
  ];

  for (const [label, bytes] of around) {
    test(`a dependency ${label} (${bytes}B) still yields a loadable bundle`, async () => {
      const { tmp, bundlesDir } = await generateProject({
        helpers: {
          'small.js': 'export const TAG = "tag";\n',
          'big.js': "import { TAG } from './small.js';\n"
            + "export function label(n) { return TAG + ':' + n; }\n"
            + padTo(bytes, 'pad')
        },
        components: [
          { name: 'Alpha', source: "import { label } from '../shared/big.js';\nexport default class Alpha { r() { return label('x'); } }" },
          { name: 'Beta', source: "import { label } from '../shared/big.js';\nexport default class Beta { r() { return label('y'); } }" }
        ]
      });
      try {
        await loadAllBundles(bundlesDir);

        // Whenever big.js was extracted, small.js must have come with it.
        const vendorPath = path.join(bundlesDir, 'slice-bundle.vendor-shared.js');
        if (await fs.pathExists(vendorPath)) {
          const text = await fs.readFile(vendorPath, 'utf8');
          const hasBig = text.includes('"Components/Visual/shared/big.js"] =');
          const hasSmall = text.includes('"Components/Visual/shared/small.js"] =');
          if (hasBig) {
            assert.ok(hasSmall, 'big.js was extracted without its dependency small.js');
          }
        }
      } finally {
        await fs.remove(tmp);
      }
    });
  }
});

describe('degenerate inputs do not crash the generator', () => {
  test('a project with no components at all', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-robust-empty-'));
    try {
      const gen = new BundleGenerator(import.meta.url, {
        components: [], routes: [], routeGroups: new Map(),
        metrics: { totalComponents: 0, totalRoutes: 0, sharedPercentage: 0, totalSize: 0 }
      }, { output: 'src' });
      gen.sliceConfig = { externalDependencies: { enabled: true } };
      gen.srcPath = path.join(tmp, 'src');
      gen.bundlesPath = path.join(tmp, 'src', 'bundles');
      gen.distPath = path.join(tmp, 'dist');
      gen.externalBundler = new ExternalModuleBundler({ resolveDir: tmp });

      const result = await muted(() => gen.generate());
      assert.ok(result.config, 'an empty project must still produce a config');
    } finally {
      await fs.remove(tmp);
    }
  });

  test('a component whose file has no html or css sidecars', async () => {
    const { tmp, bundlesDir } = await generateProject({
      components: [{ name: 'BareOnly' }]
    });
    try {
      const { registered } = await loadAllBundles(bundlesDir);
      assert.ok(registered.includes('BareOnly'));
    } finally {
      await fs.remove(tmp);
    }
  });

});

// ── Known limitations ────────────────────────────────────────────────────
// These pin behaviour the sweep above uncovered. They assert what the bundler
// does *today*, not what it should do — if either is fixed, the test fails and
// should be rewritten to assert the fix.

describe('component names that are not valid identifiers now build', () => {
  test('a dashed component name produces a loadable bundle', async () => {
    // Was a known limitation: cleanJavaScript interpolated the raw name into
    // identifier positions. It now keys the global by string and returns the
    // module's real default export.
    const { tmp, bundlesDir } = await generateProject({
      components: [
        { name: 'my-btn', source: 'export default class MyBtn { r() { return 1; } }' },
        { name: 'my_btn', source: 'export default class MyBtn2 { r() { return 2; } }' }
      ]
    });
    try {
      const { registered } = await loadAllBundles(bundlesDir);
      assert.ok(registered.includes('my-btn'), 'my-btn must register');
      assert.ok(registered.includes('my_btn'), 'my_btn must register');
    } finally {
      await fs.remove(tmp);
    }
  });
});

describe('helper cycles fail the build instead of shipping', () => {
  test('a cycle between shared helpers is reported, not emitted', async () => {
    // Was a known limitation: the bundle emitted fine and threw on load. The
    // generator now refuses, because eager IIFEs cannot reproduce ESM live
    // bindings — see tests/dependency-cycle-detection.test.js.
    const error = await generateProject({
      helpers: {
        'a.js': "import { B } from './b.js';\nexport const A = 'a' + B;\n" + padTo(2500, 'a'),
        'b.js': "import { A } from './a.js';\nexport const B = 'b';\nexport const useA = () => A;\n" + padTo(2500, 'b')
      },
      components: [
        { name: 'Alpha', source: "import { A } from '../shared/a.js';\nexport default class Alpha { r() { return A; } }" },
        { name: 'Beta', source: "import { A } from '../shared/a.js';\nexport default class Beta { r() { return A; } }" }
      ]
    }).then(() => null, (e) => e);

    assert.ok(error, 'the build must fail on a cycle');
    assert.match(error.message, /Circular import/);
  });
});
