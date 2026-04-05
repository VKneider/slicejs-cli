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
  assert.equal((source.match(/controller\.classes\.set\("Button", SLICE_CLASS_FACTORY_SliceComponent_Button\(\)\);/g) || []).length, 1);
});
