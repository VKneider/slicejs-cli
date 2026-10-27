import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { withTestProject } from './helpers/setup.js';
import { auditComponentLifecycle } from '../commands/utils/componentAudit.js';
import { validateComponentProps } from '../commands/types/types.js';

const component = (body, { extendsHTMLElement = true } = {}) => `${extendsHTMLElement ? 'class X extends HTMLElement' : 'class X'} {
${body}
}
`;

test('a synchronous beforeDestroy with no global listeners is clean', () => {
  const source = component(`
  beforeDestroy() { this._timer && clearInterval(this._timer); }
`);

  assert.deepEqual(auditComponentLifecycle(source), {
    asyncBeforeDestroy: false,
    deadTeardown: null,
    globalListener: null
  });
});

test('an async beforeDestroy is reported', () => {
  const source = component('  async beforeDestroy() { await this._done; }');
  assert.equal(auditComponentLifecycle(source).asyncBeforeDestroy, true);
});

test('a destroy() with no beforeDestroy is dead code', () => {
  const source = component('  destroy() { this.innerHTML = ""; }');
  assert.equal(auditComponentLifecycle(source).deadTeardown, 'destroy');
});

test('destroy() with parameters is a different method and is not reported', () => {
  const source = component('  destroy(chart) { chart.dispose(); }');
  assert.equal(auditComponentLifecycle(source).deadTeardown, null);
});

test('destroy() next to a real beforeDestroy is not dead code', () => {
  const source = component(`
  beforeDestroy() { this._cleanup(); }
  destroy() { this._cleanup(); }
`);
  assert.equal(auditComponentLifecycle(source).deadTeardown, null);
});

test('a global listener without removeEventListener is reported', () => {
  const source = component(`
  init() { document.addEventListener('themeChanged', () => this.update()); }
`);

  assert.equal(auditComponentLifecycle(source).globalListener, 1);
});

test('a listener with removeEventListener, { once } or { signal } is clean', () => {
  const removed = component(`
  init() { document.addEventListener('x', this._onX); }
  beforeDestroy() { document.removeEventListener('x', this._onX); }
`);
  const once = component("init() { window.addEventListener('resize', this._onResize, { once: true }); }");

  assert.equal(auditComponentLifecycle(removed).globalListener, null);
  assert.equal(auditComponentLifecycle(once).globalListener, null);
});

test('services are not subject to the component lifecycle rules', () => {
  const source = component('  destroy() { this._cache.clear(); }', { extendsHTMLElement: false });
  assert.equal(auditComponentLifecycle(source).deadTeardown, null);
});

test('build and doctor report the three findings as advisories', async () => {
  await withTestProject(async (root) => {
    await fs.writeFile(
      path.join(root, 'src', 'Components', 'Visual', 'Widget', 'Widget.js'),
      [
        'export default class Widget extends HTMLElement {',
        "  init() { document.addEventListener('x', () => this.update()); }",
        '  async beforeDestroy() { await Promise.resolve(); }',
        '}'
      ].join('\n')
    );

    const { warnings } = await validateComponentProps({ projectRoot: root });
    const messages = warnings.filter((warning) => warning.component === 'Widget').map((warning) => warning.message);

    assert.ok(messages.some((message) => /beforeDestroy is async/.test(message)), messages.join('\n'));
    assert.ok(messages.some((message) => /global listener\(s\)/.test(message)), messages.join('\n'));
  }, { visualComponents: ['Widget'] });
});
