// The generated .d.ts must be valid TypeScript for any component or prop name.
//
// Component names, prop names and event payload keys were interpolated straight
// into identifier and property-key positions. A component registered as `my-btn`
// produced `export interface my-btnProps {` and `my-btn: my-btnProps;`, and a
// prop named `data-id` produced `data-id?: string;` — none of which parse.
// jsconfig.json includes the generated file, so a broken one takes out editor
// tooling for the whole project, with an error that points nowhere useful.
//
// Reachable in practice now that a component named `my-btn` builds at all.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@babel/parser';
import { generateDeclarationContent } from '../commands/types/types.js';

/** Parses the declaration as TypeScript, failing with the offending line. */
function assertValidTypeScript(declaration, label) {
  try {
    parse(declaration, { sourceType: 'module', plugins: [['typescript', { dts: true }]] });
  } catch (error) {
    const line = declaration.split('\n')[(error.loc?.line ?? 1) - 1];
    assert.fail(`${label}: generated .d.ts does not parse — ${error.message}\n  offending line: ${line}`);
  }
}

const propsOf = (...names) => Object.fromEntries(
  names.map((name) => [name, { type: 'string', required: false }])
);

describe('component names that are not valid identifiers', () => {
  const awkward = ['my-btn', 'my.btn', 'my btn', '2fast', 'Ícono', 'with"quote'];

  for (const name of awkward) {
    test(`a component named "${name}" yields parseable output`, () => {
      const declaration = generateDeclarationContent({ [name]: propsOf('label') });
      assertValidTypeScript(declaration, name);
    });
  }

  test('the map key is quoted, not bare', () => {
    const declaration = generateDeclarationContent({ 'my-btn': propsOf('label') });
    assert.match(declaration, /"my-btn": /, 'the props-map key must be quoted');
    assert.doesNotMatch(declaration, /^\s+my-btn: /m, 'and never emitted bare');
  });

  test('the interface name is a valid identifier', () => {
    const declaration = generateDeclarationContent({ 'my-btn': propsOf('label') });
    assert.doesNotMatch(declaration, /interface my-btnProps/);
    const match = declaration.match(/export interface (\S+) \{/);
    assert.ok(match, 'an interface must be emitted');
    assert.match(match[1], /^[A-Za-z_$][A-Za-z0-9_$]*$/, `"${match[1]}" must be a valid identifier`);
  });

  test('two names that differ only by a special character get distinct interfaces', () => {
    // The encoding escapes rather than replaces, so `my-btn` and `my_btn`
    // cannot collapse into one interface (which would be a redeclaration).
    const declaration = generateDeclarationContent({
      'my-btn': propsOf('a'),
      'my_btn': propsOf('b')
    });
    assertValidTypeScript(declaration, 'my-btn + my_btn');
    const names = [...declaration.matchAll(/export interface (\S+Props) \{/g)].map((m) => m[1]);
    assert.equal(new Set(names).size, names.length, `interfaces must be unique, got ${names.join(', ')}`);
  });

  test('an ordinary name is left alone', () => {
    const declaration = generateDeclarationContent({ Widget: propsOf('value') });
    assert.match(declaration, /export interface WidgetProps \{/, 'no gratuitous encoding');
    assert.match(declaration, /^\s+Widget: WidgetProps;/m, 'and the key stays bare');
  });
});

describe('prop names that are not valid identifiers', () => {
  for (const propName of ['data-id', 'aria-label', 'my prop', '2nd']) {
    test(`a prop named "${propName}" yields parseable output`, () => {
      const declaration = generateDeclarationContent({ Widget: propsOf(propName) });
      assertValidTypeScript(declaration, propName);
      assert.ok(
        declaration.includes(`${JSON.stringify(propName)}?:`),
        `${propName} must be quoted`
      );
    });
  }

  test('an ordinary prop name stays bare', () => {
    const declaration = generateDeclarationContent({ Widget: propsOf('value') });
    assert.match(declaration, /^\s+value\?: string;/m);
  });
});

describe('event names and payload keys', () => {
  test('a payload key that needs quoting is quoted', () => {
    const declaration = generateDeclarationContent(
      { Widget: propsOf('value') },
      { 'toast:show': { payload: { 'my-key': 'string', ok: 'boolean' } } }
    );
    assertValidTypeScript(declaration, 'payload keys');
    assert.match(declaration, /"my-key": string/);
    assert.match(declaration, /ok: boolean/, 'an ordinary key stays bare');
  });

  test('an event name containing a quote does not break the string', () => {
    const declaration = generateDeclarationContent(
      { Widget: propsOf('value') },
      { 'weird"name': { payload: null } }
    );
    assertValidTypeScript(declaration, 'quoted event name');
  });
});

describe('the whole declaration still parses for a realistic project', () => {
  test('many components, props and events together', () => {
    const declaration = generateDeclarationContent(
      {
        Button: { value: { type: 'string', required: true }, onClick: { type: 'function', required: false } },
        'my-btn': { 'data-id': { type: 'string', required: false } },
        Table: { items: { type: 'array', required: false }, sliceId: { type: 'string', required: false } }
      },
      {
        'toast:show': { payload: { message: 'string', type: 'string' } },
        'confirm:request': { payload: { title: 'string', 'on-confirm': 'function' } }
      }
    );
    assertValidTypeScript(declaration, 'realistic project');
    // The public surface must survive the escaping.
    assert.match(declaration, /export type SliceComponentName = keyof SliceComponentPropsMap;/);
    assert.match(declaration, /export interface SliceComponentPropsMap \{/);
  });
});
