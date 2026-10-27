import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { withTestProject } from './helpers/setup.js';
import { findComputedPropFields, validateComponentProps } from '../commands/types/types.js';

// `slice types generate` reads the AST. A prop whose `type` (or `allowedValues`,
// `schema`, `items`) comes from a constant or a call is invisible to it, so the
// generated type silently falls back to `any`. These tests pin the detection.

const component = (propsSource) => `export default class Widget extends HTMLElement {
  static props = ${propsSource};
}
`;

test('literal metadata is clean', () => {
  const source = component(`{
    label: { type: 'string' },
    size: { type: 'string', allowedValues: ['sm', 'lg'] },
    config: { type: 'object', schema: { id: { type: 'number' } } },
    rows: { type: 'array', items: { type: 'string' } }
  }`);

  assert.deepEqual(findComputedPropFields(source), []);
});

test('a type from a constant is reported', () => {
  const source = `const TYPE_STRING = 'string';
${component('{ label: { type: TYPE_STRING } }')}`;

  assert.deepEqual(findComputedPropFields(source), [{ prop: 'label', field: 'type' }]);
});

test('allowedValues from a constant is reported', () => {
  const source = `const SIZES = ['sm', 'lg'];
${component('{ size: { type: \'string\', allowedValues: SIZES } }')}`;

  assert.deepEqual(findComputedPropFields(source), [{ prop: 'size', field: 'allowedValues' }]);
});

test('nested schema and items are inspected', () => {
  const source = `const FIELD = { type: 'string' };
${component("{ config: { type: 'object', schema: { id: FIELD } }, rows: { type: 'array', items: FIELD } }")}`;

  assert.deepEqual(findComputedPropFields(source), [
    { prop: 'config.id', field: 'metadata' },
    { prop: 'rows.items', field: 'metadata' }
  ]);
});

test('a whole definition from a constant is reported', () => {
  const source = `const SHARED = { label: { type: 'string' } };
${component('SHARED')}`;

  assert.deepEqual(findComputedPropFields(source), [{ prop: 'props', field: 'metadata' }]);
});

test('build and doctor explain it instead of saying "type any"', async () => {
  await withTestProject(async (root) => {
    await fs.writeFile(
      path.join(root, 'src', 'Components', 'Visual', 'Widget', 'Widget.js'),
      `const TYPE_STRING = 'string';
${component('{ label: { type: TYPE_STRING } }')}`
    );

    const { warnings } = await validateComponentProps({ projectRoot: root });
    const messages = warnings.filter((warning) => warning.component === 'Widget').map((warning) => warning.message);

    assert.ok(messages.some((message) => /computed, not a literal/.test(message)), messages.join('\n'));
    assert.ok(!messages.some((message) => /uses type "any"/.test(message)), 'the generic warning would hide the cause');
  }, { visualComponents: ['Widget'] });
});
