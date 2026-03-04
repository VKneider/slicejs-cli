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
