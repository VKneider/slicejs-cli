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
        }
      }
    }],
    '/docs'
  );

  assert.match(source, /const SLICE_BUNDLE_DEPENDENCIES = \{\};/);
  assert.match(source, /SLICE_BUNDLE_DEPENDENCIES\["App\/documentationRoutes\.js"\] = __sliceDepExports0;/);
  assert.match(source, /const documentationRoutes = SLICE_BUNDLE_DEPENDENCIES\["App\/documentationRoutes\.js"\]\.documentationRoutes;/);
});
