import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import BundleGenerator from '../commands/utils/bundling/BundleGenerator.js';
import ExternalModuleBundler from '../commands/utils/bundling/ExternalModuleBundler.js';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Pins a generator's project paths + esbuild resolveDir explicitly, so tests
// never depend on (and never race on) the shared process.env.INIT_CWD that
// getProjectRoot() reads. `resolveDir` is where esbuild resolves node_modules;
// `outRoot` is where bundle output paths are rooted.
function bindGeneratorToProject(gen, resolveDir, outRoot = resolveDir) {
  gen.srcPath = path.join(outRoot, 'src');
  gen.bundlesPath = path.join(outRoot, 'src', 'bundles');
  gen.distPath = path.join(outRoot, 'dist');
  gen.externalBundler = new ExternalModuleBundler({ resolveDir });
}

// These tests cover bare-package (node_modules) import support in the bundler.
// The feature is opt-in via sliceConfig.externalDependencies.enabled === true.

function makeGenerator(sliceConfig = {}, analysisData = { components: [], routes: [], metrics: { totalComponents: 0, totalRoutes: 0, sharedPercentage: 0, totalSize: 0 } }) {
  const gen = new BundleGenerator(import.meta.url, analysisData, { output: 'src' });
  gen.sliceConfig = sliceConfig;
  return gen;
}

describe('ExternalModuleBundler.isBareSpecifier', () => {
  test('relative and absolute are not bare', () => {
    assert.equal(ExternalModuleBundler.isBareSpecifier('./x.js'), false);
    assert.equal(ExternalModuleBundler.isBareSpecifier('../x.js'), false);
    assert.equal(ExternalModuleBundler.isBareSpecifier('/libs/x.js'), false);
  });
  test('URL schemes and node subpath imports are not bare', () => {
    assert.equal(ExternalModuleBundler.isBareSpecifier('https://cdn/x.js'), false);
    assert.equal(ExternalModuleBundler.isBareSpecifier('data:text/js,1'), false);
    assert.equal(ExternalModuleBundler.isBareSpecifier('#internal'), false);
  });
  test('packages, scoped packages and subpaths are bare', () => {
    assert.equal(ExternalModuleBundler.isBareSpecifier('dayjs'), true);
    assert.equal(ExternalModuleBundler.isBareSpecifier('@scope/pkg'), true);
    assert.equal(ExternalModuleBundler.isBareSpecifier('lodash/fp'), true);
  });
});

describe('classifyImport with external deps', () => {
  test('bare imports are always stripped as external (no warning, no config)', () => {
    const gen = makeGenerator({});
    const r = gen.classifyImport('dayjs');
    assert.equal(r.keep, false);
    assert.equal(r.warning, null);
    assert.equal(r.external, true);
  });

  test('scoped and subpath bare specifiers are treated as external', () => {
    const gen = makeGenerator({});
    assert.equal(gen.classifyImport('@scope/pkg').external, true);
    assert.equal(gen.classifyImport('lodash/fp').external, true);
  });
});

describe('analyzeBareImports', () => {
  const gen = makeGenerator({});

  test('extracts default, named and namespace bindings and needsDefault', () => {
    const code = `
      import dayjs from 'dayjs';
      import { format, parse } from 'date-fns';
      import * as R from 'ramda';
      import './local.js';
      import '/libs/x.js';
    `;
    const result = gen.analyzeBareImports(code);
    const byName = Object.fromEntries(result.map((r) => [r.name, r]));

    assert.ok(byName.dayjs);
    assert.equal(byName.dayjs.needsDefault, true);
    assert.equal(byName.dayjs.bindings[0].type, 'default');

    assert.ok(byName['date-fns']);
    assert.equal(byName['date-fns'].needsDefault, false);
    assert.deepEqual(byName['date-fns'].bindings.map((b) => b.importedName).sort(), ['format', 'parse']);

    assert.ok(byName.ramda);
    assert.equal(byName.ramda.needsDefault, true, 'namespace import may read .default');

    // Relative and public/ (absolute) imports are not bare.
    assert.equal(byName['./local.js'], undefined);
    assert.equal(byName['/libs/x.js'], undefined);
  });

  test('collectComponentBareDependencies collects bare imports', () => {
    const g = makeGenerator({});
    const out = g.collectComponentBareDependencies(`import x from 'dayjs';`);
    assert.ok(out.dayjs);
    assert.equal(out.dayjs.external, true);
  });
});

describe('external module emission + runtime binding', () => {
  test('registers the external module and binds default + named exports', () => {
    const gen = makeGenerator({ externalDependencies: { enabled: true } });
    gen.externalModulesByName.set('chalk', '({ default: (s) => ("BOLD:" + s), red: (s) => ("RED:" + s) })');

    const comp = {
      name: 'Demo', category: 'Visual', categoryType: 'Visual', size: 10, html: '', css: '',
      js: 'class Demo { hello(){ return chalk("x") + "|" + red("y"); } }\nwindow.Demo = Demo;\nreturn Demo;',
      externalDependencies: {
        chalk: {
          external: true,
          bindings: [
            { type: 'default', importedName: 'default', localName: 'chalk' },
            { type: 'named', importedName: 'red', localName: 'red' }
          ],
          needsDefault: true
        }
      }
    };

    const src = gen.generateBundleFileContent('slice-bundle.test.js', 'route', [comp], '/demo');
    assert.match(src, /SLICE_BUNDLE_DEPENDENCIES\["chalk"\] = \(\{ default/);

    // Evaluate the emitted dependency block + class factory and drive the class.
    const depsMatch = src.match(/const SLICE_BUNDLE_DEPENDENCIES = \{\};[\s\S]*?SLICE_BUNDLE_DEPENDENCIES\["chalk"\] = [^\n]*\n/);
    const factoryMatch = src.match(/const SLICE_CLASS_FACTORY_SliceComponent_Demo = \(\) => \{[\s\S]*?\n\};/);
    assert.ok(depsMatch && factoryMatch, 'expected dependency block and class factory in output');
    const runnable = `${depsMatch[0]}\n${factoryMatch[0]}\nconst Klass = SLICE_CLASS_FACTORY_SliceComponent_Demo();\nreturn new Klass().hello();`;
    const result = new Function('window', 'document', runnable)({}, {});
    assert.equal(result, 'BOLD:x|RED:y');
  });

  test('unresolved external emits an empty namespace so the bundle still evaluates', () => {
    const gen = makeGenerator({ externalDependencies: { enabled: true } });
    // Note: no entry set in externalModulesByName -> resolution "failed".
    const comp = {
      name: 'Demo', category: 'Visual', categoryType: 'Visual', size: 10, html: '', css: '',
      js: 'return class Demo {};',
      externalDependencies: { 'missing-pkg': { external: true, bindings: [], needsDefault: false } }
    };
    const src = gen.generateBundleFileContent('slice-bundle.test.js', 'route', [comp], '/demo');
    assert.match(src, /SLICE_BUNDLE_DEPENDENCIES\["missing-pkg"\] = \{\};/);
  });
});

describe('end-to-end: real esbuild resolution from node_modules', () => {
  test('a component importing chalk gets it inlined and callable', async () => {
    // chalk is a dependency of this CLI package, so it resolves from cwd.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-ext-'));
    try {
      const compDir = path.join(tmp, 'Demo');
      await fs.ensureDir(compDir);
      await fs.writeFile(path.join(compDir, 'Demo.js'), [
        "import chalk from 'chalk';",
        'export default class Demo {',
        '  paint(){ return typeof chalk; }',
        '}'
      ].join('\n'));

      const comp = {
        name: 'Demo', category: 'Visual', categoryType: 'Visual',
        path: compDir, dependencies: new Set(), size: 100
      };

      const gen = new BundleGenerator(import.meta.url, {
        components: [comp], routes: [], metrics: { totalComponents: 1, totalRoutes: 0, sharedPercentage: 0, totalSize: 100 }
      }, { output: 'src' });
      gen.sliceConfig = { externalDependencies: { enabled: true } };
      // chalk is a dependency of this CLI package, so resolve from CLI_ROOT.
      bindGeneratorToProject(gen, CLI_ROOT, tmp);

      await gen.prepareExternalModules();
      assert.ok(gen.externalModulesByName.has('chalk'), 'chalk should have been resolved and bundled');

      const src = await gen.generateBundleContent([comp], 'route', '/demo', 'demo', 'slice-bundle.demo.js');
      assert.match(src, /SLICE_BUNDLE_DEPENDENCIES\["chalk"\]/);

      // The import statement itself must have been stripped from the class body.
      assert.doesNotMatch(src, /import chalk from/);

      // Evaluate the dependency block + class factory to confirm chalk binds.
      const depsMatch = src.match(/const SLICE_BUNDLE_DEPENDENCIES = \{\};[\s\S]*?SLICE_BUNDLE_DEPENDENCIES\["chalk"\] = [\s\S]*?\n\}\)\(\);\n/);
      const factoryMatch = src.match(/const SLICE_CLASS_FACTORY_SliceComponent_Demo = \(\) => \{[\s\S]*?\n\};/);
      assert.ok(depsMatch && factoryMatch, 'expected dependency block and class factory');
      const runnable = `${depsMatch[0]}\n${factoryMatch[0]}\nconst Klass = SLICE_CLASS_FACTORY_SliceComponent_Demo();\nreturn new Klass().paint();`;
      const result = new Function('window', 'document', runnable)({}, {});
      assert.equal(result, 'function', 'chalk default export should be a function');
    } finally {
      await fs.remove(tmp);
    }
  });
});

describe('bare imports inside relative helper modules', () => {
  test('a package imported only by a relative helper is resolved and bound in the helper', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-ext-helper-'));
    try {
      await fs.symlink(path.join(CLI_ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');

      const compDir = path.join(tmp, 'src', 'Components', 'Visual', 'Report');
      await fs.ensureDir(compDir);
      // The component imports a relative helper; only the HELPER imports chalk.
      await fs.writeFile(path.join(compDir, 'Report.js'), [
        "import { paint } from './helper.js';",
        'export default class Report { render(){ return paint(); } }'
      ].join('\n'));
      await fs.writeFile(path.join(compDir, 'helper.js'), [
        "import chalk from 'chalk';",
        'export function paint(){ return typeof chalk; }'
      ].join('\n'));

      const comp = {
        name: 'Report', category: 'Visual', categoryType: 'Visual',
        path: compDir, dependencies: new Set(), size: 100
      };

      const gen = new BundleGenerator(import.meta.url, {
        components: [comp], routes: [], metrics: { totalComponents: 1, totalRoutes: 0, sharedPercentage: 0, totalSize: 100 }
      }, { output: 'src' });
      gen.sliceConfig = { externalDependencies: { enabled: true } };
      bindGeneratorToProject(gen, tmp);

      await gen.prepareExternalModules();
      assert.ok(gen.externalModulesByName.has('chalk'), 'chalk (imported only by the helper) should be resolved');

      const src = await gen.generateBundleContent([comp], 'route', '/report', 'report', 'slice-bundle.report.js');
      assert.match(src, /SLICE_BUNDLE_DEPENDENCIES\["chalk"\]/);

      // Evaluate the whole bundle (minus its ES exports) and drive the class,
      // proving the helper's chalk binding resolves through the dependency graph.
      const runnable = src
        .replace('export const SLICE_BUNDLE_META', 'const SLICE_BUNDLE_META')
        .replace('export async function registerAll', 'async function registerAll')
        + '\nreturn SLICE_CLASS_FACTORY_SliceComponent_Report;';
      const documentStub = { createElement: () => ({ set innerHTML(_v) {} }) };
      const factory = new Function('window', 'document', runnable)({ __SLICE_SHARED_DEPS__: {} }, documentStub);
      const instance = new (factory())();
      assert.equal(instance.render(), 'function', 'chalk should be bound (typeof chalk === "function") inside the helper');
    } finally {
      await fs.remove(tmp);
    }
  });
});

describe('dynamic import() of bare packages in build', () => {
  test('a dynamically-imported package is bundled and the import() rewritten to the registry', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-ext-dyn-'));
    try {
      await fs.symlink(path.join(CLI_ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');

      const compDir = path.join(tmp, 'src', 'Components', 'Visual', 'Lazy');
      await fs.ensureDir(compDir);
      await fs.writeFile(path.join(compDir, 'Lazy.js'), [
        'export default class Lazy {',
        '  async load(){ const m = await import("chalk"); return typeof m.default; }',
        '}'
      ].join('\n'));

      const comp = {
        name: 'Lazy', category: 'Visual', categoryType: 'Visual',
        path: compDir, dependencies: new Set(), size: 100
      };

      const gen = new BundleGenerator(import.meta.url, {
        components: [comp], routes: [], metrics: { totalComponents: 1, totalRoutes: 0, sharedPercentage: 0, totalSize: 100 }
      }, { output: 'src' });
      gen.sliceConfig = { externalDependencies: { enabled: true } };
      bindGeneratorToProject(gen, tmp);

      await gen.prepareExternalModules();
      assert.ok(gen.externalModulesByName.has('chalk'), 'dynamically-imported chalk should be resolved');

      const src = await gen.generateBundleContent([comp], 'route', '/lazy', 'lazy', 'slice-bundle.lazy.js');
      // The native bare dynamic import must be gone; it is resolved from the registry.
      assert.doesNotMatch(src, /import\(\s*["']chalk["']\s*\)/);
      assert.match(src, /SLICE_BUNDLE_DEPENDENCIES\["chalk"\]/);
      assert.match(src, /Promise\.resolve\(/);
    } finally {
      await fs.remove(tmp);
    }
  });
});

describe('strict external mode (--strict-external)', () => {
  const MISSING = 'this-package-does-not-exist-xyz-123';

  async function withMissingImportProject(fn) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-ext-strict-'));
    try {
      await fs.symlink(path.join(CLI_ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
      const dir = path.join(tmp, 'src', 'Components', 'Visual', 'Broken');
      await fs.ensureDir(dir);
      await fs.writeFile(path.join(dir, 'Broken.js'), [
        `import x from '${MISSING}';`,
        'export default class Broken { use(){ return x; } }'
      ].join('\n'));
      const comp = { name: 'Broken', category: 'Visual', categoryType: 'Visual', path: dir, dependencies: new Set(), size: 100 };
      await fn(tmp, comp);
    } finally {
      await fs.remove(tmp);
    }
  }

  test('an unresolved package fails the build by default', async () => {
    // Was opt-in via --strict-external. An unresolved package is emitted as an
    // empty namespace, so every binding from it is undefined — a guaranteed
    // runtime failure that the build used to only warn about.
    await withMissingImportProject(async (tmp, comp) => {
      const gen = new BundleGenerator(import.meta.url, {
        components: [comp], routes: [], metrics: { totalComponents: 1, totalRoutes: 0, sharedPercentage: 0, totalSize: 100 }
      }, { output: 'src' });
      bindGeneratorToProject(gen, tmp);
      await assert.rejects(() => gen.prepareExternalModules(), /could not be resolved from node_modules/);
    });
  });

  test('the error says how to proceed', async () => {
    await withMissingImportProject(async (tmp, comp) => {
      const gen = new BundleGenerator(import.meta.url, {
        components: [comp], routes: [], metrics: { totalComponents: 1, totalRoutes: 0, sharedPercentage: 0, totalSize: 100 }
      }, { output: 'src' });
      bindGeneratorToProject(gen, tmp);
      const error = await gen.prepareExternalModules().then(() => null, (e) => e);
      assert.ok(error);
      assert.match(error.message, /--no-strict-external/, 'must name the escape hatch');
      assert.match(error.message, new RegExp(MISSING), 'must name the package');
    });
  });

  test('--no-strict-external warns and continues (records the error)', async () => {
    // The one legitimate case: the package is provided some other way, e.g. a
    // shim under src/public/.
    await withMissingImportProject(async (tmp, comp) => {
      const gen = new BundleGenerator(import.meta.url, {
        components: [comp], routes: [], metrics: { totalComponents: 1, totalRoutes: 0, sharedPercentage: 0, totalSize: 100 }
      }, { output: 'src', strictExternal: false });
      bindGeneratorToProject(gen, tmp);
      await gen.prepareExternalModules(); // must not throw
      assert.ok(gen.externalResolutionErrors.has(MISSING));
    });
  });
});

describe('production bundle runtime contract (registerAll) with an external dep', () => {
  test('the generated bundle registers the component and its external dep resolves', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-ext-prod-'));
    try {
      await fs.symlink(path.join(CLI_ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');

      const dir = path.join(tmp, 'src', 'Components', 'Visual', 'Widget');
      await fs.ensureDir(dir);
      await fs.writeFile(path.join(dir, 'Widget.js'), [
        "import chalk from 'chalk';",
        'export default class Widget { paint(){ return typeof chalk; } }'
      ].join('\n'));

      const comp = {
        name: 'Widget', category: 'Visual', categoryType: 'Visual', path: dir,
        dependencies: new Set(), routes: new Set(['/widget']), size: 3000
      };
      const analysisData = {
        components: [comp],
        routes: [{ path: '/widget', component: 'Widget', dependencies: new Set(['Widget']) }],
        routeGroups: new Map(),
        metrics: { totalComponents: 1, totalRoutes: 1, sharedPercentage: 0, totalSize: 3000 }
      };

      const generator = new BundleGenerator(import.meta.url, analysisData, { output: 'src' });
      generator.sliceConfig = { externalDependencies: { enabled: true } };
      bindGeneratorToProject(generator, tmp);
      await generator.generate();

      // Locate the on-disk bundle that carries Widget and load it the way the
      // Controller does: evaluate the module and call its registerAll() export.
      const bundlesDir = path.join(tmp, 'src', 'bundles');
      const files = await fs.readdir(bundlesDir);
      let registerAll = null;
      for (const file of files.filter((f) => f.endsWith('.js'))) {
        const text = await fs.readFile(path.join(bundlesDir, file), 'utf8');
        if (!/SLICE_CLASS_FACTORY_SliceComponent_Widget/.test(text)) continue;
        const runnable = text
          .replace('export const SLICE_BUNDLE_META', 'const SLICE_BUNDLE_META')
          .replace('export async function registerAll', 'async function registerAll')
          + '\nreturn registerAll;';
        const documentStub = { createElement: () => ({ set innerHTML(_v) {} }) };
        const customElementsStub = { get: () => undefined, define: () => {} };
        registerAll = new Function('window', 'document', 'customElements', runnable)(
          { __SLICE_SHARED_DEPS__: {} }, documentStub, customElementsStub
        );
        break;
      }
      assert.ok(registerAll, 'a bundle exporting registerAll for Widget should exist');

      // Drive the exact v2 registration contract the runtime uses.
      const controller = { classes: new Map(), templates: new Map(), componentCategories: new Map() };
      const stylesManager = { registerComponentStyles() {} };
      await registerAll(controller, stylesManager);

      assert.ok(controller.classes.has('Widget'), 'registerAll must register the Widget class');
      const WidgetClass = controller.classes.get('Widget');
      const instance = new WidgetClass();
      assert.equal(instance.paint(), 'function', 'chalk must be bound inside the registered class');
    } finally {
      await fs.remove(tmp);
    }
  });
});

describe('vendor-shared dedupe of external deps', () => {
  test('a package used across 2+ route bundles is extracted once into vendor-shared', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-ext-shared-'));
    try {
      // Make chalk resolvable from the temp project and route bundle writes there.
      await fs.symlink(path.join(CLI_ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');

      const makeComp = async (name) => {
        const dir = path.join(tmp, 'src', 'Components', 'Visual', name);
        await fs.ensureDir(dir);
        await fs.writeFile(path.join(dir, `${name}.js`), [
          "import chalk from 'chalk';",
          `export default class ${name} { paint(){ return chalk("x"); } }`
        ].join('\n'));
        return {
          name, category: 'Visual', categoryType: 'Visual', path: dir,
          dependencies: new Set(), routes: new Set([`/${name.toLowerCase()}`]), size: 3000
        };
      };

      const compA = await makeComp('Alpha');
      const compB = await makeComp('Beta');

      const analysisData = {
        components: [compA, compB],
        routes: [
          { path: '/alpha', component: 'Alpha', dependencies: new Set(['Alpha']) },
          { path: '/beta', component: 'Beta', dependencies: new Set(['Beta']) }
        ],
        routeGroups: new Map(),
        metrics: { totalComponents: 2, totalRoutes: 2, sharedPercentage: 0, totalSize: 6000 }
      };

      const generator = new BundleGenerator(import.meta.url, analysisData, { output: 'src' });
      generator.sliceConfig = { externalDependencies: { enabled: true } };
      bindGeneratorToProject(generator, tmp);

      const result = await generator.generate();

      const bundlesDir = path.join(tmp, 'src', 'bundles');
      const files = (await fs.readdir(bundlesDir)).filter((f) => f.endsWith('.js'));

      // The vendor-shared bundle must exist and register chalk.
      assert.ok(files.includes('slice-bundle.vendor-shared.js'), 'vendor-shared bundle should be emitted');
      const vendorText = await fs.readFile(path.join(bundlesDir, 'slice-bundle.vendor-shared.js'), 'utf8');
      assert.match(vendorText, /SLICE_BUNDLE_DEPENDENCIES\["chalk"\] = \(\(\) =>/);

      // chalk must be registered exactly once across ALL bundle files (deduped).
      let registrations = 0;
      for (const f of files) {
        const text = await fs.readFile(path.join(bundlesDir, f), 'utf8');
        registrations += (text.match(/SLICE_BUNDLE_DEPENDENCIES\["chalk"\] = \(\(\) =>/g) || []).length;
      }
      assert.equal(registrations, 1, 'chalk should be inlined exactly once (in vendor-shared)');

      // The config advertises chalk as a shared dependency.
      assert.ok(
        (result.config.bundles.vendorShared?.dependencies || []).includes('chalk'),
        'vendorShared config should list chalk'
      );
    } finally {
      await fs.remove(tmp);
    }
  });

  test('a package shared between the critical bundle and a route is deduped into vendor-shared', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-ext-crit-'));
    try {
      await fs.symlink(path.join(CLI_ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');

      const makeComp = async (name, categoryType) => {
        const dir = path.join(tmp, 'src', 'Components', 'Visual', name);
        await fs.ensureDir(dir);
        await fs.writeFile(path.join(dir, `${name}.js`), [
          "import chalk from 'chalk';",
          `export default class ${name} { paint(){ return chalk("x"); } }`
        ].join('\n'));
        return {
          name, category: 'Visual', categoryType, path: dir,
          dependencies: new Set(), routes: new Set(), size: 3000
        };
      };

      // Navbar is structural -> lands in the critical bundle. OrderList is routed.
      const navbar = await makeComp('Navbar', 'Structural');
      const orderList = await makeComp('OrderList', 'Visual');
      orderList.routes = new Set(['/orders']);

      const analysisData = {
        components: [navbar, orderList],
        routes: [{ path: '/orders', component: 'OrderList', dependencies: new Set(['OrderList']) }],
        routeGroups: new Map(),
        metrics: { totalComponents: 2, totalRoutes: 1, sharedPercentage: 0, totalSize: 6000 }
      };

      const generator = new BundleGenerator(import.meta.url, analysisData, { output: 'src' });
      generator.sliceConfig = { externalDependencies: { enabled: true } };
      bindGeneratorToProject(generator, tmp);

      const result = await generator.generate();

      const bundlesDir = path.join(tmp, 'src', 'bundles');
      const files = (await fs.readdir(bundlesDir)).filter((f) => f.endsWith('.js'));

      // chalk lives once, in vendor-shared — not inlined in critical.
      let registrations = 0;
      for (const f of files) {
        const text = await fs.readFile(path.join(bundlesDir, f), 'utf8');
        registrations += (text.match(/SLICE_BUNDLE_DEPENDENCIES\["chalk"\] = \(\(\) =>/g) || []).length;
      }
      assert.equal(registrations, 1, 'chalk should be inlined exactly once across critical + routes');

      const criticalText = await fs.readFile(path.join(bundlesDir, 'slice-bundle.critical.js'), 'utf8');
      assert.doesNotMatch(criticalText, /SLICE_BUNDLE_DEPENDENCIES\["chalk"\] = \(\(\) =>/, 'critical must not inline chalk');
      // critical resolves chalk through the shared resolver.
      assert.match(criticalText, /__sliceResolveBundleDependency\("chalk"\)/);

      // critical declares vendor-shared as a dependency so it loads first.
      assert.deepEqual(result.config.bundles.critical.dependencies, ['vendor-shared']);
    } finally {
      await fs.remove(tmp);
    }
  });
});

// Regression: a helper module's imports are not lost when stripped — the module
// block re-emits them as IIFE-scoped bindings (buildDependencyBindings), so the
// strip is half of a rewrite. Warning on those made every healthy build report a
// scary "Stripping unsupported import: three", sending readers after phantom bugs.
describe('stripped-import warnings only fire for imports nothing rebinds', () => {
  function captureWarnings(run) {
    const original = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      run();
    } finally {
      console.warn = original;
    }
    return warnings;
  }

  test('a rebound bare import is stripped silently', () => {
    const gen = makeGenerator({ externalDependencies: { enabled: true } });
    const warnings = captureWarnings(() => {
      const out = gen.transformDependencyContent(
        "import * as THREE from 'three';\nexport const make = () => new THREE.Group();",
        '__sliceExports',
        'Components/Demo/kit/weapons.js',
        { handledSpecifiers: new Set(['three']) }
      );
      // The statement is gone from the emitted body — the caller rebinds it.
      assert.doesNotMatch(out, /import \* as THREE/);
    });
    assert.deepEqual(warnings, [], 'a handled import must not warn');
  });

  test('an import nothing rebinds still warns', () => {
    const gen = makeGenerator({ externalDependencies: { enabled: true } });
    const warnings = captureWarnings(() => {
      gen.transformDependencyContent(
        "import fs from 'fs';\nexport const x = 1;",
        '__sliceExports',
        'Components/Demo/kit/io.js',
        { handledSpecifiers: new Set(['three']) }
      );
    });
    assert.equal(warnings.length, 1, 'an unhandled import must still warn');
    assert.match(warnings[0], /Stripping unsupported import/);
    assert.match(warnings[0], /fs/);
  });

  test('silent mode (size probe) reports nothing', () => {
    const gen = makeGenerator({ externalDependencies: { enabled: true } });
    const warnings = captureWarnings(() => {
      gen.transformDependencyContent(
        "import fs from 'fs';\nexport const x = 1;",
        '__sliceVendorSharedProbe',
        'Components/Demo/kit/io.js',
        { silent: true }
      );
    });
    assert.deepEqual(warnings, [], 'a size probe emits nothing, so it must not warn');
  });
});
