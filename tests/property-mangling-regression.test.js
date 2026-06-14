import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { minify } from 'terser';

const BUGGY_REGEX = /^(slice|_|\$|on[A-Z]|get|set|has|is)/;

const terserConfig = (regex) => ({
  compress: { drop_console: false, drop_debugger: true, unused: false, side_effects: false, reduce_vars: false, collapse_vars: false },
  mangle: {
    reserved: ['slice', 'window', 'document', 'HTMLElement', 'addEventListener', 'removeEventListener', 'customElements', 'define', 'fetch', 'setTimeout', 'clearTimeout', 'console'],
    properties: regex ? { regex } : false
  },
  format: { comments: false, beautify: false },
  keep_fnames: true,
  keep_classnames: true
});

async function mangleProps(code, regex) {
  const result = await minify(code, terserConfig(regex));
  if (result.error) throw result.error;
  return result.code;
}

describe('property mangling — cross-file bug', () => {

  describe('RED: buggy regex proves cross-file renaming differs', () => {

    test('onClick is mangled to different short names in each file', async () => {
      const fileA = `
        class Pagination {
          static props = { _p1: 0, sliceX: 0, onClick: { type: 'function' }, onChange: { type: 'function' } }
          fire() { this.onClick() }
        }
      `;
      const fileB = `
        class Table {
          trigger(comp) { comp.onClick() }
        }
      `;

      const [minA, minB] = await Promise.all([
        mangleProps(fileA, BUGGY_REGEX),
        mangleProps(fileB, BUGGY_REGEX),
      ]);

      assert.doesNotMatch(minA, /onClick/, 'A: onClick must be mangled');
      assert.doesNotMatch(minB, /onClick/, 'B: onClick must be mangled');

      const thisCalls = [...minA.matchAll(/this\.([a-zA-Z])\s*\(/g)].map(m => m[1]);
      const paramCalls = [...minB.matchAll(/\w+\.([a-zA-Z])\s*\(/g)].filter(m => m[1] !== 'props').map(m => m[1]);

      assert.equal(thisCalls.length, 1, 'A: fire() calls this.onMangledClick()');
      assert.equal(paramCalls.length, 1, 'B: trigger() calls comp.onMangledClick()');

      assert.notEqual(
        thisCalls[0], paramCalls[0],
        `Mangled names differ: A=this.${thisCalls[0]}(), B=comp.${paramCalls[0]}()\n` +
        `  A: ${minA}\n  B: ${minB}`
      );
    });

    test('sliceId is mangled (should be preserved for cross-file access)', async () => {
      const code = `class Foo { get() { return this.sliceId } }`;
      const min = await mangleProps(code, BUGGY_REGEX);
      assert.doesNotMatch(min, /sliceId/, 'sliceId should be mangled by buggy regex');
    });

    test('setPage is mangled to different short names in each file', async () => {
      const fileA = `
        class DataGridEngine {
          doIt() { this._state(); this.setSort(); this.setPage(); this.setPageSize() }
        }
      `;
      const fileB = `
        class Table {
          handle(p) { p.setPage() }
        }
      `;

      const [minA, minB] = await Promise.all([
        mangleProps(fileA, BUGGY_REGEX),
        mangleProps(fileB, BUGGY_REGEX),
      ]);

      assert.doesNotMatch(minA, /setPage/, 'A: setPage must be mangled');
      assert.doesNotMatch(minB, /setPage/, 'B: setPage must be mangled');

      const thisCallsA = [...minA.matchAll(/this\.([a-zA-Z])\s*\(/g)].map(m => m[1]);
      const paramCallsB = [...minB.matchAll(/\w+\.([a-zA-Z])\s*\(/g)].map(m => m[1]);

      assert.equal(thisCallsA.length, 4, 'A should have 4 this.X() calls');
      assert.equal(paramCallsB.length, 1, 'B should have 1 p.X() call');
      assert.notEqual(
        thisCallsA[2], paramCallsB[0],
        `setPage is "${thisCallsA[2]}" in A but "${paramCallsB[0]}" in B\n` +
        `  A: ${minA}\n  B: ${minB}`
      );
    });

  });

  describe('GREEN: fix variations prevent the bug', () => {

    const FIXES = {
      'properties: false (no mangling)': null,
      'regex: /^_/ (private only)':      /^_/,
    };

    for (const [label, regex] of Object.entries(FIXES)) {

      test(`${label}: onClick preserved (cross-file safe)`, async () => {
        const fileA = `
          class Pagination {
            static props = { _p1: 0, sliceX: 0, onClick: { type: 'function' }, onChange: { type: 'function' } }
            fire() { this.onClick() }
          }
        `;
        const fileB = `class Table { trigger(comp) { comp.onClick() } }`;

        const [minA, minB] = await Promise.all([
          mangleProps(fileA, regex),
          mangleProps(fileB, regex),
        ]);

        assert.ok(minA.includes('onClick'), `A must preserve onClick: ${minA}`);
        assert.ok(minB.includes('onClick'), `B must preserve onClick: ${minB}`);
      });

      test(`${label}: sliceId preserved (cross-file safe)`, async () => {
        const fileA = `class Foo { get() { return this.sliceId } }`;
        const fileB = `class Bar { read(target) { return target.sliceId } }`;

        const [minA, minB] = await Promise.all([
          mangleProps(fileA, regex),
          mangleProps(fileB, regex),
        ]);

        assert.ok(minA.includes('sliceId'), `A must preserve sliceId`);
        assert.ok(minB.includes('sliceId'), `B must preserve sliceId`);
      });

      test(`${label}: setPage preserved (cross-file safe)`, async () => {
        const fileA = `class Engine { handle(t) { t.setPage(1) } }`;
        const fileB = `class Table { trigger(comp) { comp.setPage() } }`;

        const [minA, minB] = await Promise.all([
          mangleProps(fileA, regex),
          mangleProps(fileB, regex),
        ]);

        assert.ok(minA.includes('setPage'), `A must preserve setPage: ${minA}`);
        assert.ok(minB.includes('setPage'), `B must preserve setPage: ${minB}`);
      });

    }

  });

  describe('underscore-prefixed private props still get mangled', () => {

    test('regex /^_/: _internal is mangled', async () => {
      const code = `class Foo { constructor() { this._internal = 42; this.publicProp = 'x' } }`;
      const min = await mangleProps(code, /^_/);
      assert.doesNotMatch(min, /_internal/, '_internal should be mangled');
      assert.ok(min.includes('publicProp'), 'publicProp preserved');
    });

    test('regex /^_/: $secret is NOT mangled', async () => {
      const code = `class Foo { save() { this.$secret = 42 } }`;
      const min = await mangleProps(code, /^_/);
      assert.ok(min.includes('$secret'), '$secret preserved with /^_/');
    });

    test('properties: false: _internal is preserved (no mangling at all)', async () => {
      const code = `class Foo { constructor() { this._internal = 42 } }`;
      const min = await mangleProps(code, null);
      assert.ok(min.includes('_internal'), '_internal survives with properties:false');
    });

  });

});
