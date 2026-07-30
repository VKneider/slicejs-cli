// The class factory must return whatever the component module actually
// default-exports, and register it under the component's name as a *string*.
//
// Both used to be emitted as the raw component name, which assumed the
// registered name matched the class name and was a valid JavaScript identifier.
// A component registered as `my-btn` produced
//   window.my-btn = my-btn; return my-btn;
// which is a syntax error — even when the source itself was perfectly valid.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@babel/parser';
import BundleGenerator from '../commands/utils/bundling/BundleGenerator.js';

function makeGenerator() {
  const gen = new BundleGenerator(
    import.meta.url,
    { components: [], routes: [], metrics: { totalComponents: 0, totalRoutes: 0, sharedPercentage: 0, totalSize: 0 } },
    { output: 'src' }
  );
  gen.sliceConfig = { externalDependencies: { enabled: true } };
  return gen;
}

const buildBundle = (gen, source, name) => {
  const cleaned = gen.cleanJavaScript(source, name, `${name}.js`);
  return gen.generateBundleFileContent(
    'slice-bundle.x.js',
    'route',
    [{
      name, category: 'Visual', js: cleaned.code, html: '', css: '',
      externalDependencies: {}, hasTopLevelAwait: cleaned.hasTopLevelAwait
    }],
    '/x'
  );
};

describe('component names that are not valid identifiers', () => {
  test('a dashed name produces valid JavaScript', () => {
    const gen = makeGenerator();
    const { code } = gen.cleanJavaScript(
      'export default class MyBtn { r() { return 1; } }',
      'my-btn',
      'my-btn.js'
    );

    assert.doesNotMatch(code, /window\.my-btn/, 'must not write an illegal member expression');
    assert.match(code, /window\["my-btn"\] = MyBtn;/, 'must key the global by string');
    assert.match(code, /return MyBtn;/, 'must return the class the module exported');
  });

  test('the emitted bundle parses', () => {
    const gen = makeGenerator();
    const bundle = buildBundle(gen, 'export default class MyBtn { r() { return 1; } }', 'my-btn');
    assert.doesNotThrow(() => parse(bundle, { sourceType: 'module' }));
  });

  test('names with dots, spaces and non-ASCII characters work too', () => {
    const gen = makeGenerator();
    for (const name of ['my.btn', 'my btn', 'Ícono', '2fast']) {
      const bundle = buildBundle(gen, `export default class Comp { r() { return 1; } }`, name);
      assert.doesNotThrow(
        () => parse(bundle, { sourceType: 'module' }),
        `component named "${name}" must emit valid JavaScript`
      );
      assert.ok(bundle.includes(`window[${JSON.stringify(name)}]`), `${name} must be keyed by string`);
    }
  });
});

describe('the factory returns the real default export', () => {
  test('a class whose name differs from the component name', () => {
    const gen = makeGenerator();
    const { code } = gen.cleanJavaScript(
      'export default class TotallyDifferent { r() { return 1; } }',
      'Widget',
      'Widget.js'
    );
    assert.match(code, /return TotallyDifferent;/);
    assert.match(code, /window\["Widget"\] = TotallyDifferent;/);
  });

  test('`export default SomeIdentifier` is followed', () => {
    const gen = makeGenerator();
    const { code } = gen.cleanJavaScript(
      'class Inner { r() { return 1; } }\nexport default Inner;',
      'Widget',
      'Widget.js'
    );
    assert.match(code, /return Inner;/);
  });

  test('an anonymous default export is given a binding', () => {
    const gen = makeGenerator();
    const bundle = buildBundle(gen, 'export default class { r() { return 1; } }', 'Widget');
    // `class { }` alone is not a valid statement — it has to be bound.
    assert.doesNotThrow(() => parse(bundle, { sourceType: 'module' }));
    assert.match(bundle, /const __sliceComponent_\S+ = class/);
  });

  test('a named default export still works as before', () => {
    const gen = makeGenerator();
    const { code } = gen.cleanJavaScript(
      'export default class Widget { r() { return 1; } }',
      'Widget',
      'Widget.js'
    );
    assert.match(code, /return Widget;/);
    assert.match(code, /window\["Widget"\] = Widget;/);
  });

  test('customElements.define components keep their global assignment', () => {
    const gen = makeGenerator();
    const { code } = gen.cleanJavaScript(
      [
        'export default class MyBtn extends HTMLElement {}',
        "customElements.define('slice-my-btn', MyBtn);"
      ].join('\n'),
      'my-btn',
      'my-btn.js'
    );
    assert.match(code, /window\["my-btn"\] = MyBtn;/);
    assert.match(code, /if \(!customElements\.get\('slice-my-btn'\)\)/, 'the define guard must survive');
  });
});

describe('a component with no default export fails the build', () => {
  test('it throws, naming the component and the file', () => {
    const gen = makeGenerator();
    const error = (() => {
      try {
        gen.cleanJavaScript('export class Widget {}', 'Widget', 'src/Components/Visual/Widget/Widget.js');
        return null;
      } catch (e) {
        return e;
      }
    })();

    assert.ok(error, 'a component with no default export must not build');
    assert.match(error.message, /Widget/);
    assert.match(error.message, /src\/Components\/Visual\/Widget\/Widget\.js/, 'must name the file to fix');
    assert.match(error.message, /export default/, 'must say what to do');
  });

  test('the message explains why, not just what', () => {
    const gen = makeGenerator();
    try {
      gen.cleanJavaScript('const x = 1;', 'Widget', 'Widget.js');
      assert.fail('should have thrown');
    } catch (error) {
      // The runtime loads components via `const { default: myClass } = await
      // import(...)`, so this is a source error the developer has to fix.
      assert.match(error.message, /default: myClass/);
    }
  });
});
