import { test } from 'node:test';
import assert from 'node:assert/strict';
import BundleGenerator from '../commands/utils/bundling/BundleGenerator.js';

test('generated V2 bundle includes meta and registerAll exports', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {
      totalComponents: 0,
      totalRoutes: 0,
      sharedPercentage: 0,
      totalSize: 0
    }
  }, { output: 'src' });

  const source = generator.generateBundleFileContent(
    'slice-bundle.test.js',
    'route',
    [{ name: 'Button', category: 'Visual', categoryType: 'Visual', dependencies: new Set(), size: 100, js: '', html: '', css: '' }],
    '/test'
  );

  assert.match(source, /export const SLICE_BUNDLE_META/);
  assert.match(source, /export async function registerAll\(/);
});

test('generateBundleFileContent deduplicates components by name', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {
      totalComponents: 0,
      totalRoutes: 0,
      sharedPercentage: 0,
      totalSize: 0
    }
  }, { output: 'src' });

  const source = generator.generateBundleFileContent(
    'slice-bundle.test.js',
    'route',
    [
      { name: 'Button', category: 'Visual', categoryType: 'Visual', dependencies: new Set(), size: 100, js: '', html: '', css: '' },
      { name: 'Button', category: 'Visual', categoryType: 'Visual', dependencies: new Set(), size: 100, js: '', html: '', css: '' }
    ],
    '/test'
  );

  assert.equal((source.match(/const SLICE_CLASS_FACTORY_SliceComponent_Button/g) || []).length, 1);
  assert.equal((source.match(/if \(!controller\.classes\.has\("Button"\)\) \{\s*controller\.classes\.set\("Button", SLICE_CLASS_FACTORY_SliceComponent_Button\(\)\);\s*\}/g) || []).length, 1);
});

test('registerAll guards class, template, style, and category writes', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {
      totalComponents: 0,
      totalRoutes: 0,
      sharedPercentage: 0,
      totalSize: 0
    }
  }, { output: 'src' });

  const source = generator.generateBundleFileContent(
    'slice-bundle.test.js',
    'route',
    [{ name: 'Button', category: 'Visual', categoryType: 'Visual', dependencies: new Set(), size: 100, js: '', html: '<button>ok</button>', css: '.btn{}' }],
    '/test'
  );

  assert.match(source, /if \(!controller\.classes\.has\("Button"\)\) \{\s*controller\.classes\.set\("Button", SLICE_CLASS_FACTORY_SliceComponent_Button\(\)\);\s*\}/);
  assert.match(source, /if \(!controller\.templates\.has\("Button"\)\) \{\s*controller\.templates\.set\("Button", __templateElement_SliceComponent_Button\);\s*\}/);
  assert.match(source, /if \(!stylesManager\.__sliceRegisteredComponentStyles\) \{\s*stylesManager\.__sliceRegisteredComponentStyles = new Set\(\);\s*\}/);
  assert.match(source, /if \(!stylesManager\.__sliceRegisteredComponentStyles\.has\("Button"\)\) \{\s*stylesManager\.registerComponentStyles\("Button", ".*"\);\s*stylesManager\.__sliceRegisteredComponentStyles\.add\("Button"\);\s*\}/);
  assert.match(source, /if \(!controller\.componentCategories\.has\("Button"\)\) \{\s*controller\.componentCategories\.set\("Button", "Visual"\);\s*\}/);
});

test('registerAll stores templates as template elements', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {
      totalComponents: 0,
      totalRoutes: 0,
      sharedPercentage: 0,
      totalSize: 0
    }
  }, { output: 'src' });

  const source = generator.generateBundleFileContent(
    'slice-bundle.test.js',
    'route',
    [{ name: 'DocumentationPage', category: 'AppComponents', categoryType: 'Visual', dependencies: new Set(), size: 100, js: '', html: '<div>docs</div>', css: '' }],
    '/docs'
  );

  assert.match(source, /const __templateElement_SliceComponent_DocumentationPage = document\.createElement\('template'\);/);
  assert.match(source, /__templateElement_SliceComponent_DocumentationPage\.innerHTML = "<div>docs<\/div>";/);
  assert.match(source, /controller\.templates\.set\("DocumentationPage", __templateElement_SliceComponent_DocumentationPage\);/);
});

test('bundle output inlines dependency modules and binds imported symbols in class factories', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {
      totalComponents: 0,
      totalRoutes: 0,
      sharedPercentage: 0,
      totalSize: 0
    }
  }, { output: 'src' });

  const source = generator.generateBundleFileContent(
    'slice-bundle.test.js',
    'route',
    [{
      name: 'DocumentationPage',
      category: 'AppComponents',
      categoryType: 'Visual',
      dependencies: new Set(),
      size: 100,
      js: 'class DocumentationPage extends HTMLElement { connectedCallback(){ return documentationRoutes.length; } }\nwindow.DocumentationPage = DocumentationPage;\nreturn DocumentationPage;',
      html: '',
      css: '',
      externalDependencies: {
        'App/documentationRoutes.js': {
          content: 'export const documentationRoutes = ["/docs"];',
          bindings: [{ type: 'named', importedName: 'documentationRoutes', localName: 'documentationRoutes' }]
        },
        'App/purify.js': {
          content: 'export const purify = (value) => value;',
          bindings: [{ type: 'default', importedName: 'default', localName: 'purify' }]
        }
      }
    }],
    '/docs'
  );

  assert.match(source, /const SLICE_BUNDLE_DEPENDENCIES = \{\};/);
  assert.match(source, /const __sliceSharedDeps = typeof window !== 'undefined' \? \(window\.__SLICE_SHARED_DEPS__ \|\| \{\}\) : \{\};/);
  assert.match(source, /function __sliceResolveDefaultExport\(dep, depName, preferredKey\) \{/);
  assert.match(source, /SLICE_BUNDLE_DEPENDENCIES\["App\/documentationRoutes\.js"\] = __sliceDepExports0;/);
  assert.match(source, /const documentationRoutes = __sliceResolveBundleDependency\("App\/documentationRoutes\.js"\)\.documentationRoutes;/);
  assert.match(source, /const purify = __sliceResolveDefaultExport\(__sliceResolveBundleDependency\("App\/purify\.js"\), "App\/purify\.js", "purifyData"\);/);
  assert.doesNotMatch(source, /\.default !== undefined \?/);
  assert.doesNotMatch(source, /SLICE_BUNDLE_DEPENDENCIES\["App\/purify\.js"\]\.purifyData/);
});

test('route bundle omits extracted vendor-shared modules from inline dependency block and keeps bindings', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {
      totalComponents: 0,
      totalRoutes: 0,
      sharedPercentage: 0,
      totalSize: 0
    }
  }, { output: 'src' });

  generator.vendorShared.sharedDependencySet = new Set(['App/documentationRoutes.js']);

  const source = generator.generateBundleFileContent(
    'slice-bundle.test.js',
    'route',
    [{
      name: 'DocumentationPage',
      category: 'AppComponents',
      categoryType: 'Visual',
      dependencies: new Set(),
      size: 100,
      js: 'class DocumentationPage extends HTMLElement { connectedCallback(){ return [documentationRoutes.length, docsNs.documentationRoutes.length, purify(1)].length; } }\nwindow.DocumentationPage = DocumentationPage;\nreturn DocumentationPage;',
      html: '',
      css: '',
      externalDependencies: {
        'App/documentationRoutes.js': {
          content: 'export const documentationRoutes = ["/docs"];',
          bindings: [
            { type: 'named', importedName: 'documentationRoutes', localName: 'documentationRoutes' },
            { type: 'namespace', localName: 'docsNs' }
          ]
        },
        'App/purify.js': {
          content: 'export default (value) => value;',
          bindings: [{ type: 'default', importedName: 'default', localName: 'purify' }]
        }
      }
    }],
    '/docs'
  );

  assert.match(source, /const __sliceSharedDeps = typeof window !== 'undefined' \? \(window\.__SLICE_SHARED_DEPS__ \|\| \{\}\) : \{\};/);
  assert.match(source, /const __sliceResolveBundleDependency = \(depName\) => Object\.prototype\.hasOwnProperty\.call\(__sliceSharedDeps, depName\) \? __sliceSharedDeps\[depName\] : SLICE_BUNDLE_DEPENDENCIES\[depName\];/);
  assert.doesNotMatch(source, /SLICE_BUNDLE_DEPENDENCIES\["App\/documentationRoutes\.js"\] = __sliceDepExports\d+;/);
  assert.match(source, /SLICE_BUNDLE_DEPENDENCIES\["App\/purify\.js"\] = __sliceDepExports\d+;/);
  assert.match(source, /const documentationRoutes = __sliceResolveBundleDependency\("App\/documentationRoutes\.js"\)\.documentationRoutes;/);
  assert.match(source, /const docsNs = __sliceResolveBundleDependency\("App\/documentationRoutes\.js"\);/);
  assert.match(source, /const purify = __sliceResolveDefaultExport\(__sliceResolveBundleDependency\("App\/purify\.js"\), "App\/purify\.js", "purifyData"\);/);
});

test('route bundle emits guarded shared deps resolver for non-browser contexts', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {
      totalComponents: 0,
      totalRoutes: 0,
      sharedPercentage: 0,
      totalSize: 0
    }
  }, { output: 'src' });

  const source = generator.generateBundleFileContent(
    'slice-bundle.test.js',
    'route',
    [{
      name: 'DocsPage',
      category: 'AppComponents',
      categoryType: 'Visual',
      dependencies: new Set(),
      size: 100,
      js: 'class DocsPage extends HTMLElement {}\nwindow.DocsPage = DocsPage;\nreturn DocsPage;',
      html: '',
      css: '',
      externalDependencies: {
        'App/deps.js': {
          content: 'export const value = 1;',
          bindings: [{ type: 'named', importedName: 'value', localName: 'value' }]
        }
      }
    }],
    '/docs'
  );

  assert.match(source, /const __sliceSharedDeps = typeof window !== 'undefined' \? \(window\.__SLICE_SHARED_DEPS__ \|\| \{\}\) : \{\};/);
  assert.match(source, /const __sliceResolveBundleDependency = \(depName\) => Object\.prototype\.hasOwnProperty\.call\(__sliceSharedDeps, depName\) \? __sliceSharedDeps\[depName\] : SLICE_BUNDLE_DEPENDENCIES\[depName\];/);
});

test('non-route bundle does not emit shared resolver block', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {
      totalComponents: 0,
      totalRoutes: 0,
      sharedPercentage: 0,
      totalSize: 0
    }
  }, { output: 'src' });

  const source = generator.generateBundleFileContent(
    'slice-bundle.framework.js',
    'framework',
    [{
      name: 'FrameworkComp',
      category: 'Framework',
      categoryType: 'Visual',
      dependencies: new Set(),
      size: 100,
      js: 'class FrameworkComp extends HTMLElement {}\nwindow.FrameworkComp = FrameworkComp;\nreturn FrameworkComp;',
      html: '',
      css: '',
      externalDependencies: {
        'App/frameworkDep.js': {
          content: 'export const dep = 1;',
          bindings: [{ type: 'named', importedName: 'dep', localName: 'dep' }]
        }
      }
    }],
    null
  );

  assert.doesNotMatch(source, /const __sliceSharedDeps = /);
  assert.doesNotMatch(source, /const __sliceResolveBundleDependency = /);
  assert.match(source, /const dep = SLICE_BUNDLE_DEPENDENCIES\["App\/frameworkDep\.js"\]\.dep;/);
});

test('route bundle keeps local fallback binding when shared map is unavailable', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {
      totalComponents: 0,
      totalRoutes: 0,
      sharedPercentage: 0,
      totalSize: 0
    }
  }, { output: 'src' });

  const source = generator.generateBundleFileContent(
    'slice-bundle.test.js',
    'route',
    [{
      name: 'FallbackComp',
      category: 'Visual',
      categoryType: 'Visual',
      dependencies: new Set(),
      size: 100,
      js: 'class FallbackComp extends HTMLElement {}\nwindow.FallbackComp = FallbackComp;\nreturn FallbackComp;',
      html: '',
      css: '',
      externalDependencies: {
        'App/local.js': {
          content: 'export const local = 1;',
          bindings: [{ type: 'named', importedName: 'local', localName: 'local' }]
        }
      }
    }],
    '/fallback'
  );

  assert.match(source, /const __sliceResolveBundleDependency = \(depName\) => Object\.prototype\.hasOwnProperty\.call\(__sliceSharedDeps, depName\) \? __sliceSharedDeps\[depName\] : SLICE_BUNDLE_DEPENDENCIES\[depName\];/);
  assert.match(source, /const local = __sliceResolveBundleDependency\("App\/local\.js"\)\.local;/);
});

test('bundle output hoists allowed absolute imports to module top-level', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {
      totalComponents: 0,
      totalRoutes: 0,
      sharedPercentage: 0,
      totalSize: 0
    }
  }, { output: 'src' });

  const source = generator.generateBundleFileContent(
    'slice-bundle.test.js',
    'route',
    [{
      name: 'HeroCard',
      category: 'Visual',
      categoryType: 'Visual',
      dependencies: new Set(),
      size: 100,
      js: 'class HeroCard extends HTMLElement {}\nwindow.HeroCard = HeroCard;\nreturn HeroCard;',
      html: '',
      css: '',
      hoistedImports: ["import hero from '/public/hero.js';"]
    }],
    '/test'
  );

  assert.match(source, /import hero from '\/public\/hero\.js';/);
  assert.doesNotMatch(source, /SLICE_CLASS_FACTORY_SliceComponent_HeroCard = \(\) => \{[\s\S]*import hero from '\/public\/hero\.js';/);
});

test('generateBundleFileContent throws on hoisted import local binding collisions', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {
      totalComponents: 0,
      totalRoutes: 0,
      sharedPercentage: 0,
      totalSize: 0
    }
  }, { output: 'src' });

  assert.throws(() => {
    generator.generateBundleFileContent(
      'slice-bundle.test.js',
      'route',
      [
        {
          name: 'CompA',
          category: 'Visual',
          categoryType: 'Visual',
          dependencies: new Set(),
          size: 100,
          js: 'class CompA extends HTMLElement {}\nwindow.CompA = CompA;\nreturn CompA;',
          html: '',
          css: '',
          hoistedImports: ["import foo from '/public/a.js';"]
        },
        {
          name: 'CompB',
          category: 'Visual',
          categoryType: 'Visual',
          dependencies: new Set(),
          size: 100,
          js: 'class CompB extends HTMLElement {}\nwindow.CompB = CompB;\nreturn CompB;',
          html: '',
          css: '',
          hoistedImports: ["import foo from '/public/b.js';"]
        }
      ],
      '/test'
    );
  }, /Hoisted import binding collision: foo/);
});

test('generateBundleFileContent throws on reserved identifier collision', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {
      totalComponents: 0,
      totalRoutes: 0,
      sharedPercentage: 0,
      totalSize: 0
    }
  }, { output: 'src' });

  assert.throws(() => {
    generator.generateBundleFileContent(
      'slice-bundle.test.js',
      'route',
      [{
        name: 'CompMeta',
        category: 'Visual',
        categoryType: 'Visual',
        dependencies: new Set(),
        size: 100,
        js: 'class CompMeta extends HTMLElement {}\nwindow.CompMeta = CompMeta;\nreturn CompMeta;',
        html: '',
        css: '',
        hoistedImports: ["import SLICE_BUNDLE_META from '/public/meta.js';"]
      }],
      '/test'
    );
  }, /reserved identifier collision: SLICE_BUNDLE_META/);
});

test('generateBundleConfig emits vendor-shared metadata and route dependency graph edges', () => {
  const generator = new BundleGenerator(import.meta.url, {
    components: [],
    routes: [],
    metrics: {
      totalComponents: 0,
      totalRoutes: 1,
      sharedPercentage: 0,
      totalSize: 0
    }
  }, { output: 'src' });

  generator.bundles.routes = {
    docs: {
      path: '/docs',
      components: [{ name: 'DocumentationPage' }],
      size: 100,
      file: 'slice-bundle.docs.js'
    }
  };

  generator.vendorShared.sharedDependencySet = new Set(['App/documentationRoutes.js']);
  generator.vendorShared.bundleKeysUsingSharedDependencies = new Set(['docs']);
  generator.vendorShared.bundle = {
    file: 'slice-bundle.vendor-shared.js',
    size: 2048,
    hash: 'deadbeef',
    integrity: 'sha256:deadbeef'
  };

  const config = generator.generateBundleConfig(null);

  assert.equal(config.bundles.vendorShared.bundleKey, 'vendor-shared');
  assert.equal(config.bundles.vendorShared.type, 'vendor-shared');
  assert.equal(config.bundles.vendorShared.dependencyCount, 1);
  assert.deepEqual(config.bundles.routes.docs.dependencies, ['critical', 'vendor-shared']);
  assert.deepEqual(config.routeBundles['/docs'], ['critical', 'vendor-shared', 'docs']);
  assert.deepEqual(config.routeDependencyGraph['/docs'].edges, [
    { from: 'critical', to: 'docs' },
    { from: 'vendor-shared', to: 'docs' }
  ]);
});
