import { test } from 'node:test';
import assert from 'node:assert/strict';
import DependencyAnalyzer from '../commands/utils/bundling/DependencyAnalyzer.js';

test('parseComponentsConfig returns components map', () => {
  // Arrange
  const analyzer = new DependencyAnalyzer(import.meta.url);
  const content = `const components = {"Button": "Visual", "FetchManager": "Service"};\nexport default components;`;

  // Act
  const result = analyzer.parseComponentsConfig(content);

  // Assert
  assert.deepEqual(result, { Button: 'Visual', FetchManager: 'Service' });
});

test('parseComponentsConfig throws for invalid config', () => {
  // Arrange
  const analyzer = new DependencyAnalyzer(import.meta.url);
  const content = `const notComponents = {"Button": "Visual"};`;

  // Act / Assert
  assert.throws(() => analyzer.parseComponentsConfig(content), /components object not found/);
});
