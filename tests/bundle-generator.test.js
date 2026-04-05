import { test } from 'node:test';
import assert from 'node:assert/strict';
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
