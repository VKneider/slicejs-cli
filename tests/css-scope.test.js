import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findUnscopedSelectors, componentTagFromSource } from '../commands/utils/cssScope.js';

// Component CSS is global. These rules keep the check narrow enough to be
// useful: :host and the component's own tag are fine, keyframes are ignored,
// and a file can opt out explicitly.

test('reads the registered tag from the source', () => {
  assert.equal(componentTagFromSource("customElements.define('slice-card', Card);"), 'slice-card');
  assert.equal(componentTagFromSource("window.customElements.define(\"slice-x\", X);"), 'slice-x');
  assert.equal(componentTagFromSource('export default class X {}'), null);
});

test('scoped selectors and :host are clean', () => {
  const css = `
    :host { display: block; }
    :host(.wide) { width: 100%; }
    slice-card { padding: 8px; }
    slice-card .title { font-weight: 700; }
  `;

  assert.deepEqual(findUnscopedSelectors(css, 'slice-card'), []);
});

test('a bare class is reported', () => {
  assert.deepEqual(findUnscopedSelectors('.card { color: red; }', 'slice-card'), ['.card']);
});

test('selectors inside media queries are checked, keyframes are skipped', () => {
  const css = `
    @media (max-width: 760px) { .card { color: red; } }
    @keyframes spin { from { opacity: 0; } to { opacity: 1; } }
    @font-face { font-family: X; }
  `;

  assert.deepEqual(findUnscopedSelectors(css, 'slice-card'), ['.card']);
});

test('comments do not produce selectors', () => {
  const css = `
    /* .card { color: red } */
    slice-card { color: blue; }
  `;

  assert.deepEqual(findUnscopedSelectors(css, 'slice-card'), []);
});

test('the opt-out marker disables the check for the file', () => {
  const css = `
    /* slice:unscoped — this widget portals its nodes to <body> */
    .toast-container { position: fixed; }
  `;

  assert.deepEqual(findUnscopedSelectors(css, 'slice-toast'), []);
});

test('a comma list is judged by its first selector', () => {
  assert.deepEqual(findUnscopedSelectors('h1, slice-card h2 { margin: 0; }', 'slice-card'), ['h1, slice-card h2']);
  assert.deepEqual(findUnscopedSelectors('slice-card h1, slice-card h2 { margin: 0; }', 'slice-card'), []);
});

test('no tag means no check', () => {
  assert.deepEqual(findUnscopedSelectors('.x { color: red; }', null), []);
});
