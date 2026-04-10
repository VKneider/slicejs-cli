import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import BundleGenerator from '../commands/utils/bundling/BundleGenerator.js';

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
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-bundle-test-'));
  const srcDir = path.join(tempRoot, 'src');
  const previousInitCwd = process.env.INIT_CWD;

  await fs.ensureDir(srcDir);
  await fs.writeJson(path.join(srcDir, 'sliceConfig.json'), {
    loading: { enabled: true }
  });

  process.env.INIT_CWD = tempRoot;

  try {
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
  } finally {
    if (previousInitCwd === undefined) {
      delete process.env.INIT_CWD;
    } else {
      process.env.INIT_CWD = previousInitCwd;
    }
    await fs.remove(tempRoot);
  }
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

test('stripImports preserves absolute imports from configured publicFolders', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {},
    sliceConfig: {
      publicFolders: ['/public', '/assets']
    }
  });

  const source = "import logo from '/public/logo.js';\nimport hero from '/assets/hero.js';\nclass Demo {}\n";
  const cleaned = generator.stripImports(source);

  assert.match(cleaned, /import\s+logo\s+from\s+'\/public\/logo\.js';/);
  assert.match(cleaned, /import\s+hero\s+from\s+'\/assets\/hero\.js';/);
});

test('stripImports removes relative imports', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {},
    sliceConfig: {
      publicFolders: ['/public']
    }
  });

  const source = "import localDep from './local.js';\nimport parentDep from '../parent.js';\nclass Demo {}\n";
  const cleaned = generator.stripImports(source);

  assert.doesNotMatch(cleaned, /\.\/local\.js/);
  assert.doesNotMatch(cleaned, /\.\.\/parent\.js/);
  assert.match(cleaned, /class Demo \{\}/);
});

test('stripImports warns on bare imports', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {},
    sliceConfig: {
      publicFolders: ['/public']
    }
  });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    const source = "import { html } from 'lit';\nclass Demo {}\n";
    const cleaned = generator.stripImports(source);

    assert.doesNotMatch(cleaned, /from\s+'lit'/);
    assert.ok(warnings.some((msg) => msg.includes('bare import') && msg.includes('lit')));
  } finally {
    console.warn = originalWarn;
  }
});

test('stripImports warns on absolute imports outside publicFolders', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {},
    sliceConfig: {
      publicFolders: ['/public']
    }
  });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    const source = "import secret from '/private/secret.js';\nclass Demo {}\n";
    const cleaned = generator.stripImports(source);

    assert.doesNotMatch(cleaned, /\/private\/secret\.js/);
    assert.ok(warnings.some((msg) => msg.includes('outside publicFolders') && msg.includes('/private/secret.js')));
  } finally {
    console.warn = originalWarn;
  }
});

test('stripImports supports side-effect and multiline imports in fallback mode', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {},
    sliceConfig: {
      publicFolders: ['/public']
    }
  });

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
    assert.ok(warnings.some((msg) => msg.includes('outside publicFolders') && msg.includes('/private/effects.js') && msg.includes('[DemoComponent]')));
    assert.ok(warnings.some((msg) => msg.includes('bare import') && msg.includes('lit') && msg.includes('[DemoComponent]')));
  } finally {
    generator.parseImportsFromCode = originalParse;
    console.warn = originalWarn;
  }
});

test('cleanJavaScript hoists allowed absolute imports and removes them from component code', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {},
    sliceConfig: {
      publicFolders: ['/public']
    }
  });

  const source = [
    "import hero from '/public/hero.js';",
    'class Demo extends HTMLElement {}',
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
