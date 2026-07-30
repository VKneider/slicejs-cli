import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import BundleGenerator from '../commands/utils/bundling/BundleGenerator.js';
import { withTestProject } from './helpers/setup.js';

// Shared temp project whose src/public/ holds the assets the "kept absolute
// import" tests reference (absolute imports are preserved only when the file
// exists under src/public/).
let BG_TMP;
let BG_SRC;
before(async () => {
  BG_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-bg-'));
  BG_SRC = path.join(BG_TMP, 'src');
  for (const rel of ['public/logo.js', 'assets/hero.js', 'public/effects.js', 'public/hero.js']) {
    const p = path.join(BG_SRC, 'public', rel);
    await fs.ensureDir(path.dirname(p));
    await fs.writeFile(p, '');
  }
});
after(async () => { if (BG_TMP) await fs.remove(BG_TMP); });

const createComponent = (name, deps = []) => ({
  name,
  category: 'Visual',
  categoryType: 'Visual',
  dependencies: new Set(deps),
  size: 10,
  path: `/tmp/${name}`
});

test('computeBundleIntegrity returns sha256 hash', () => {
  // Arrange
  const generator = new BundleGenerator(import.meta.url, { components: [], routes: [], metrics: {} });
  const components = [createComponent('Button', ['Input']), createComponent('Input')];

  // Act
  const integrity = generator.computeBundleIntegrity(components, 'critical', null, 'critical', 'slice-bundle.critical.js');

  // Assert
  assert.match(integrity, /^sha256:[a-f0-9]{64}$/);
});

test('computeBundleIntegrity changes with component dependencies', () => {
  // Arrange
  const generator = new BundleGenerator(import.meta.url, { components: [], routes: [], metrics: {} });
  const baseComponents = [createComponent('Button', ['Input']), createComponent('Input')];
  const changedComponents = [createComponent('Button', ['Input', 'Icon']), createComponent('Input'), createComponent('Icon')];

  // Act
  const baseIntegrity = generator.computeBundleIntegrity(baseComponents, 'critical', null, 'critical', 'slice-bundle.critical.js');
  const changedIntegrity = generator.computeBundleIntegrity(changedComponents, 'critical', null, 'critical', 'slice-bundle.critical.js');

  // Assert
  assert.notEqual(baseIntegrity, changedIntegrity);
});

test('generateBundleConfig outputs V2 manifest fields', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {
      totalComponents: 0,
      totalRoutes: 0,
      sharedPercentage: 0,
      totalSize: 0
    }
  });

  const config = generator.generateBundleConfig(null);

  assert.equal(config.format, 'v2');
  assert.ok(config.generated);
  assert.ok(config.bundles);
  assert.ok(['enabled', 'disabled'].includes(config.loadingPolicy));
});

test('loading policy is enabled when sliceConfig loading.enabled is true', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {
      totalComponents: 0,
      totalRoutes: 0,
      sharedPercentage: 0,
      totalSize: 0
    },
    sliceConfig: { loading: { enabled: true } }
  });

  const config = generator.generateBundleConfig(null);
  assert.equal(config.loadingPolicy, 'enabled');
});

test('loading policy falls back to project sliceConfig when analysisData lacks sliceConfig', async () => {
  await withTestProject(async () => {
    const generator = new BundleGenerator(import.meta.url, {
      components: [],
      routes: [],
      metrics: {
        totalComponents: 0,
        totalRoutes: 0,
        sharedPercentage: 0,
        totalSize: 0
      }
    });

    const config = generator.generateBundleConfig(null);
    assert.equal(config.loadingPolicy, 'enabled');
  });
});

test('loading enabled always includes Loading component in critical bundle', () => {
  const loading = {
    ...createComponent('Loading'),
    routes: new Set(),
    size: 100000
  };
  const home = {
    ...createComponent('HomePage'),
    routes: new Set(['/'])
  };

  const generator = new BundleGenerator(import.meta.url, {
    components: [loading, home],
    routes: [{ path: '/', component: 'HomePage' }],
    metrics: {
      totalComponents: 2,
      totalRoutes: 1,
      sharedPercentage: 0,
      totalSize: 100010
    },
    sliceConfig: { loading: { enabled: true } }
  });

  generator.identifyCriticalComponents();

  assert.ok(generator.bundles.critical.components.some((component) => component.name === 'Loading'));
  assert.equal(generator.generateBundleConfig().loadingPolicy, 'enabled');
});

test('shared-core is wired as dependency for affected route bundles', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {
      totalComponents: 0,
      totalRoutes: 0,
      sharedPercentage: 0,
      totalSize: 0
    }
  });

  generator.config.minSharedUsage = 2;

  generator.bundles.routes = {
    alpha: {
      path: '/alpha',
      components: [createComponent('SharedWidget'), createComponent('AlphaOnly')],
      size: 20,
      file: 'slice-bundle.alpha.js'
    },
    beta: {
      path: '/beta',
      components: [createComponent('SharedWidget'), createComponent('BetaOnly')],
      size: 20,
      file: 'slice-bundle.beta.js'
    }
  };

  generator.extractSharedComponents(new Set());
  const config = generator.generateBundleConfig();

  assert.ok(config.bundles.routes['shared-core']);
  assert.deepEqual(config.bundles.routes.alpha.dependencies, ['critical', 'shared-core']);
  assert.deepEqual(config.bundles.routes.beta.dependencies, ['critical', 'shared-core']);
  assert.deepEqual(config.routeBundles['/alpha'], ['critical', 'shared-core', 'alpha']);
  assert.deepEqual(config.routeBundles['/beta'], ['critical', 'shared-core', 'beta']);
});

test('rebalance merge preserves and merges route path metadata deterministically', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {
      totalComponents: 0,
      totalRoutes: 0,
      sharedPercentage: 0,
      totalSize: 0
    }
  });

  const bundles = {
    alpha: { path: '/alpha', components: [createComponent('Alpha')], size: 10, file: 'slice-bundle.alpha.js' },
    beta: { paths: ['/beta', '/beta-alt'], components: [createComponent('Beta')], size: 10, file: 'slice-bundle.beta.js' },
    gamma: { path: '/gamma', components: [createComponent('Gamma')], size: 10, file: 'slice-bundle.gamma.js' }
  };

  generator.rebalanceBundlesByBudget(bundles, { maxBundleSize: 99999, maxRequests: 2 });

  assert.equal(Object.keys(bundles).length, 2);
  assert.deepEqual(bundles.beta.paths, ['/beta', '/beta-alt', '/gamma']);
});

test('stripImports preserves absolute imports that exist under public/', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {}
  });
  generator.srcPath = BG_SRC;

  const source = "import logo from '/public/logo.js';\nimport hero from '/assets/hero.js';\nclass Demo {}\n";
  const cleaned = generator.stripImports(source);

  assert.match(cleaned, /import\s+logo\s+from\s+'\/public\/logo\.js';/);
  assert.match(cleaned, /import\s+hero\s+from\s+'\/assets\/hero\.js';/);
});

test('stripImports removes relative imports', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {}
  });

  const source = "import localDep from './local.js';\nimport parentDep from '../parent.js';\nclass Demo {}\n";
  const cleaned = generator.stripImports(source);

  assert.doesNotMatch(cleaned, /\.\/local\.js/);
  assert.doesNotMatch(cleaned, /\.\.\/parent\.js/);
  assert.match(cleaned, /class Demo \{\}/);
});

test('stripImports strips bare imports silently (resolved as external)', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {}
  });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    const source = "import { html } from 'lit';\nclass Demo {}\n";
    const cleaned = generator.stripImports(source);

    // Bare import is removed from the body (bound from the registry instead)…
    assert.doesNotMatch(cleaned, /from\s+'lit'/);
    // …and no "removing bare import" warning is emitted anymore.
    assert.ok(!warnings.some((msg) => msg.includes('bare import')));
  } finally {
    console.warn = originalWarn;
  }
});

test('stripImports warns on absolute imports not under public/', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {}
  });
  generator.srcPath = BG_SRC;

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    const source = "import secret from '/private/secret.js';\nclass Demo {}\n";
    const cleaned = generator.stripImports(source);

    assert.doesNotMatch(cleaned, /\/private\/secret\.js/);
    assert.ok(warnings.some((msg) => msg.includes('absolute import') && msg.includes('/private/secret.js')));
  } finally {
    console.warn = originalWarn;
  }
});

test('stripImports supports side-effect and multiline imports in fallback mode', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {}
  });
  generator.srcPath = BG_SRC;

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  const originalParse = generator.parseImportsFromCode;
  generator.parseImportsFromCode = () => {
    throw new Error('forced parser failure');
  };

  try {
    const source = [
      "import '/public/effects.js';",
      "import '/private/effects.js';",
      "import {",
      '  html,',
      '  css',
      "} from 'lit';",
      'class Demo {}'
    ].join('\n');
    const cleaned = generator.stripImports(source, { sourceContext: 'DemoComponent' });

    assert.match(cleaned, /import '\/public\/effects\.js';/);
    assert.doesNotMatch(cleaned, /\/private\/effects\.js/);
    assert.doesNotMatch(cleaned, /from 'lit'/);
    assert.ok(warnings.some((msg) => msg.includes('absolute import') && msg.includes('/private/effects.js') && msg.includes('[DemoComponent]')));
    // Bare imports are stripped silently now (resolved as external), no warning.
    assert.ok(!warnings.some((msg) => msg.includes('bare import')));
  } finally {
    generator.parseImportsFromCode = originalParse;
    console.warn = originalWarn;
  }
});

test('cleanJavaScript hoists allowed absolute imports and removes them from component code', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {}
  });
  generator.srcPath = BG_SRC;

  const source = [
    "import hero from '/public/hero.js';",
    'export default class Demo extends HTMLElement {}',
    'customElements.define("x-demo", Demo);'
  ].join('\n');

  const result = generator.cleanJavaScript(source, 'Demo', 'DemoPath.js');

  assert.doesNotMatch(result.code, /import hero from '\/public\/hero\.js';/);
  assert.ok(result.hoistedImports.includes("import hero from '/public/hero.js';"));
});

test('formatBundleFile emits hoisted imports for framework-compatible output', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {}
  });

  const source = generator.formatBundleFile({
    'Framework/Structural/Bootstrap': {
      name: 'Bootstrap',
      category: 'Framework',
      categoryType: 'Structural',
      componentDependencies: [],
      externalDependencies: {},
      hoistedImports: ["import boot from '/public/bootstrap.js';"],
      js: 'class Bootstrap extends HTMLElement {}\nreturn Bootstrap;',
      html: '',
      css: '',
      size: 10,
      isFramework: true
    }
  }, {
    type: 'framework',
    generated: new Date().toISOString(),
    strategy: 'hybrid',
    componentCount: 1,
    totalSize: 10
  });

  assert.match(source, /import boot from '\/public\/bootstrap\.js';/);
  assert.match(source, /const SLICE_BUNDLE_DEPENDENCIES = \{\};/);
});

test('default dependency binding resolves transformed default key over named exports', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {}
  });

  const externalDependencies = {
    'App/purify.js': {
      content: 'export default () => "DEFAULT"; export const purify = () => "NAMED";',
      bindings: [{ type: 'default', importedName: 'default', localName: 'purify' }]
    }
  };

  const resolverSource = generator.getDefaultExportResolverLines().join('\n');
  const bindingsSource = generator.buildDependencyBindings(externalDependencies);
  const resolveBoundValue = new Function(
    `${resolverSource}\n` +
    'const SLICE_BUNDLE_DEPENDENCIES = {"App/purify.js": { purifyData: "DEFAULT", purify: "NAMED" }};\n' +
    `${bindingsSource}\n` +
    'return purify;'
  );

  assert.equal(resolveBoundValue(), 'DEFAULT');
});

const evaluateDefaultResolver = ({ dep, depName = 'App/dep.js', preferredKey = null, calls = 1 }) => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {}
  });

  const resolverSource = generator.getDefaultExportResolverLines().join('\n');
  const resolve = new Function(
    '__dep',
    '__depName',
    '__preferredKey',
    '__calls',
    `${resolverSource}\n` +
      'const __capturedWarnings = [];' +
      'const __originalWarn = console.warn;' +
      'console.warn = (...args) => __capturedWarnings.push(args.join(" "));' +
      'let __result;' +
      'try {' +
      '  for (let __i = 0; __i < __calls; __i += 1) {' +
      '    __result = __sliceResolveDefaultExport(__dep, __depName, __preferredKey);' +
      '  }' +
      '} finally {' +
      '  console.warn = __originalWarn;' +
      '}' +
      'return { result: __result, warnings: __capturedWarnings };'
  );

  return resolve(dep, depName, preferredKey, calls);
};

test('default resolver returns default when present', () => {
  const { result, warnings } = evaluateDefaultResolver({
    dep: { default: 'DEFAULT', alpha: 'ALPHA' }
  });

  assert.equal(result, 'DEFAULT');
  assert.equal(warnings.length, 0);
});

test('default resolver preserves falsy default values', () => {
  const falsyValues = [0, '', false, null];

  for (const value of falsyValues) {
    const { result, warnings } = evaluateDefaultResolver({ dep: { default: value, alt: 'fallback' } });
    assert.equal(result, value);
    assert.equal(warnings.length, 0);
  }
});

test('default resolver falls back to single non-default key', () => {
  const { result, warnings } = evaluateDefaultResolver({ dep: { onlyKey: 42 } });

  assert.equal(result, 42);
  assert.equal(warnings.length, 0);
});

test('default resolver respects preferred key hint when present', () => {
  const { result, warnings } = evaluateDefaultResolver({
    dep: { purifyData: 'PREFERRED', purify: 'OTHER' },
    depName: 'App/purify.js',
    preferredKey: 'purifyData'
  });

  assert.equal(result, 'PREFERRED');
  assert.equal(warnings.length, 0);
});

test('default resolver prefers known keys module/exports/purify when unambiguous', () => {
  const moduleResult = evaluateDefaultResolver({ dep: { module: 'MODULE', alpha: 'A' } });
  const exportsResult = evaluateDefaultResolver({ dep: { exports: 'EXPORTS', beta: 'B' } });
  const purifyResult = evaluateDefaultResolver({ dep: { purify: 'PURIFY', gamma: 'C' } });

  assert.equal(moduleResult.result, 'MODULE');
  assert.equal(exportsResult.result, 'EXPORTS');
  assert.equal(purifyResult.result, 'PURIFY');
  assert.equal(moduleResult.warnings.length, 0);
  assert.equal(exportsResult.warnings.length, 0);
  assert.equal(purifyResult.warnings.length, 0);
});

test('default resolver uses deterministic alphabetical fallback on ambiguous keys', () => {
  const { result } = evaluateDefaultResolver({ dep: { zebra: 'Z', alpha: 'A', middle: 'M' } });
  assert.equal(result, 'A');
});

test('default resolver source uses locale-independent comparator and named preferred keys constant', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {}
  });

  const resolverSource = generator.getDefaultExportResolverLines().join('\n');

  assert.match(resolverSource, /const __sliceDefaultExportPreferredKeys = \['module', 'exports', 'purify'\];/);
  assert.match(resolverSource, /const __sliceDeterministicKeyCompare = \(a, b\) => \(a < b \? -1 : a > b \? 1 : 0\);/);
  assert.doesNotMatch(resolverSource, /localeCompare/);
});

test('default resolver warning includes dependency path keys and chosen key', () => {
  const { warnings } = evaluateDefaultResolver({
    dep: { zebra: 'Z', alpha: 'A', middle: 'M' },
    depName: 'App/ambiguous.js'
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /App\/ambiguous\.js/);
  assert.match(warnings[0], /Falling back to "alpha"/);
  assert.match(warnings[0], /Keys: alpha, middle, zebra/);
});

test('default resolver deduplicates ambiguous warning per dependency in one evaluation', () => {
  const { warnings } = evaluateDefaultResolver({
    dep: { c: 3, a: 1, b: 2 },
    depName: 'App/repeat-warning.js',
    calls: 3
  });

  assert.equal(warnings.length, 1);
});

test('default resolver evaluation restores console.warn when resolver throws', () => {
  const originalWarn = console.warn;

  assert.throws(() => {
    evaluateDefaultResolver({
      dep: new Proxy({}, {
        ownKeys() {
          throw new Error('kaboom');
        }
      })
    });
  }, /kaboom/);

  assert.equal(console.warn, originalWarn);
});

test('default resolver passes through non-object values and null/undefined', () => {
  const fn = () => 'ok';
  const functionResult = evaluateDefaultResolver({ dep: fn });
  const stringResult = evaluateDefaultResolver({ dep: 'value' });
  const numberResult = evaluateDefaultResolver({ dep: 7 });
  const nullResult = evaluateDefaultResolver({ dep: null });
  const undefinedResult = evaluateDefaultResolver({ dep: undefined });

  assert.equal(functionResult.result, fn);
  assert.equal(stringResult.result, 'value');
  assert.equal(numberResult.result, 7);
  assert.equal(nullResult.result, null);
  assert.equal(undefinedResult.result, undefined);
});

test('analyzeDependencies resolves extensionless imports across js json and mjs', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-deps-ext-'));
  const componentDir = path.join(tempRoot, 'Component');

  await fs.ensureDir(componentDir);
  await fs.writeFile(path.join(componentDir, 'dep-js.js'), 'export const value = 1;', 'utf-8');
  await fs.writeFile(path.join(componentDir, 'dep-json.json'), '{"ok":true}', 'utf-8');
  await fs.writeFile(path.join(componentDir, 'dep-mjs.mjs'), 'export const ok = true;', 'utf-8');

  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {}
  });

  try {
    const jsDeps = generator.analyzeDependencies("import dep from './dep-js';", componentDir);
    const jsonDeps = generator.analyzeDependencies("import cfg from './dep-json';", componentDir);
    const mjsDeps = generator.analyzeDependencies("import mod from './dep-mjs';", componentDir);

    assert.equal(jsDeps.length, 1);
    assert.equal(path.basename(jsDeps[0].path), 'dep-js.js');
    assert.equal(jsonDeps.length, 1);
    assert.equal(path.basename(jsonDeps[0].path), 'dep-json.json');
    assert.equal(mjsDeps.length, 1);
    assert.equal(path.basename(mjsDeps[0].path), 'dep-mjs.mjs');
  } finally {
    await fs.remove(tempRoot);
  }
});

test('named and namespace dependency bindings remain unchanged', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {}
  });

  const externalDependencies = {
    'App/named.js': {
      content: 'export const alpha = 1;',
      bindings: [
        { type: 'named', importedName: 'alpha', localName: 'localAlpha' },
        { type: 'namespace', localName: 'namedNamespace' }
      ]
    }
  };

  const resolverSource = generator.getDefaultExportResolverLines().join('\n');
  const bindingsSource = generator.buildDependencyBindings(externalDependencies);
  const evaluate = new Function(
    `${resolverSource}\n` +
      'const SLICE_BUNDLE_DEPENDENCIES = {"App/named.js": { alpha: 99, other: 1 }};' +
      `${bindingsSource}\n` +
      'return { localAlpha, namedNamespace };'
  );

  const values = evaluate();
  assert.equal(values.localAlpha, 99);
  assert.deepEqual(values.namedNamespace, { alpha: 99, other: 1 });
});

test('indexExternalDependencyUsage tracks unique route-bundle usage counts', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {}
  });

  const routeDependencyIndex = {
    alpha: {
      'deps/shared.js': { content: 'export const shared = true;' },
      'deps/alpha.js': { content: 'export const alpha = true;' }
    },
    beta: {
      'deps/shared.js': { content: 'export const shared = true;' },
      'deps/beta.js': { content: 'export const beta = true;' }
    }
  };

  const usageIndex = generator.indexExternalDependencyUsage(routeDependencyIndex);

  assert.equal(usageIndex.get('deps/shared.js').bundleCount, 2);
  assert.equal(usageIndex.get('deps/alpha.js').bundleCount, 1);
  assert.deepEqual(Array.from(usageIndex.get('deps/shared.js').bundleKeys).sort(), ['alpha', 'beta']);
});

test('computeSharedDependencySet enforces usage and transformed-size thresholds', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {}
  });

  const largePayload = 'x'.repeat(2100);
  const routeDependencyIndex = {
    alpha: {
      'deps/shared-large.js': { content: `export const payload = '${largePayload}';` },
      'deps/shared-small.js': { content: 'export const tiny = 1;' }
    },
    beta: {
      'deps/shared-large.js': { content: `export const payload = '${largePayload}';` },
      'deps/shared-small.js': { content: 'export const tiny = 1;' }
    },
    gamma: {
      'deps/shared-small.js': { content: 'export const tiny = 1;' }
    }
  };

  const usageIndex = generator.indexExternalDependencyUsage(routeDependencyIndex);
  const sharedSet = generator.computeSharedDependencySet(usageIndex);

  assert.ok(sharedSet.has('deps/shared-large.js'));
  assert.ok(!sharedSet.has('deps/shared-small.js'));
});

test('generateVendorSharedDependencyBundleContent emits shared dependency module once', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {}
  });

  const routeDependencyIndex = {
    alpha: {
      'deps/shared.js': { content: `export const payload = '${'y'.repeat(2200)}';` }
    },
    beta: {
      'deps/shared.js': { content: `export const payload = '${'y'.repeat(2200)}';` }
    }
  };

  const usageIndex = generator.indexExternalDependencyUsage(routeDependencyIndex);
  const sharedSet = generator.computeSharedDependencySet(usageIndex);
  generator.vendorShared.dependencyUsage = usageIndex;
  const content = generator.generateVendorSharedDependencyBundleContent(sharedSet);
  const assignmentMatches = content.match(/SLICE_BUNDLE_DEPENDENCIES\["deps\/shared\.js"\]/g) || [];

  assert.equal(assignmentMatches.length, 1);
});
