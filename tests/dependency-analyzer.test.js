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

/** Runs fn while capturing console.warn output. */
async function withCapturedWarnings(fn) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const result = await fn();
    return { result, warnings };
  } finally {
    console.warn = original;
  }
}

test('extractDependencies links slice.build() with a string literal', async () => {
  const analyzer = new DependencyAnalyzer(import.meta.url);
  const { result } = await withCapturedWarnings(() =>
    analyzer.extractDependencies("slice.build('Button');", 'X.js'));
  assert.ok(result.has('Button'));
});

test('extractDependencies resolves slice.build(constant) via scope', async () => {
  const analyzer = new DependencyAnalyzer(import.meta.url);
  const code = "const NAME = 'Card';\nawait slice.build(NAME);";
  const { result, warnings } = await withCapturedWarnings(() =>
    analyzer.extractDependencies(code, 'X.js'));
  // A resolvable constant is now linked into the graph (no warning).
  assert.ok(result.has('Card'));
  assert.equal(warnings.filter((w) => w.includes('Dynamic slice.build')).length, 0);
});

test('extractDependencies collects a dynamic slice.build() and reports it once', async () => {
  const analyzer = new DependencyAnalyzer(import.meta.url);
  const code = "function make(name) { return slice.build(name); }";
  const { result, warnings } = await withCapturedWarnings(async () => {
    const dependencies = await analyzer.extractDependencies(code, 'Widget.js');
    analyzer.reportDynamicBuildWarnings();
    return dependencies;
  });
  assert.equal(warnings.length, 1, 'expected exactly one grouped warning');
  assert.match(warnings[0], /1 dynamic slice\.build\(\) call/);
  assert.match(warnings[0], /Widget\.js/);
  // Nothing linkable was added for the computed name.
  assert.equal(result.size, 0);
});

test('reportDynamicBuildWarnings groups calls from every file into one line', async () => {
  const analyzer = new DependencyAnalyzer(import.meta.url);
  const code = "function make(name) { return slice.build(name); }";
  const { warnings } = await withCapturedWarnings(async () => {
    await analyzer.extractDependencies(code, 'Widget.js');
    await analyzer.extractDependencies(code, 'Other.js');
    analyzer.reportDynamicBuildWarnings();
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2 dynamic slice\.build\(\) calls/);
  assert.match(warnings[0], /Widget\.js/);
  assert.match(warnings[0], /Other\.js/);
});
