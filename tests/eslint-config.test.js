import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';
import appConfig, { nodeConfig } from '../eslint-config.js';

// The config is the product here: these tests lint snippets with the same ESLint
// that projects use, and assert the environment and the rules it promises.

const lint = (code, { filePath = 'src/example.js', config = appConfig, cwd = process.cwd() } = {}) =>
  new ESLint({ cwd, overrideConfigFile: true, overrideConfig: config }).lintText(code, { filePath, warnIgnored: false });

const rulesOf = (results) => results.flatMap((result) => result.messages.map((message) => message.ruleId));

test('the framework and browser globals are defined', async () => {
  const results = await lint(`
    const el = document.createElement('div');
    document.body.appendChild(el);
    window.location.hash;
    customElements.define('slice-x', class extends HTMLElement {});
    slice.build('Button');
    Slice.getClass('x');
  `);

  assert.deepEqual(results[0].messages, [], JSON.stringify(results[0].messages, null, 2));
});

test('the node preset knows node globals and not the framework ones', async () => {
  const node = await lint('process.env.NODE_ENV;', { config: nodeConfig });
  assert.deepEqual(rulesOf(node), []);

  const browserOnly = await lint("slice.build('Button');", { config: nodeConfig });
  assert.deepEqual(rulesOf(browserOnly), ['no-undef'], 'the app globals do not leak into Node tooling');
});

test('specs get node globals and the Playwright fixtures', async () => {
  const results = await lint('process.env.CI; page.locator(".x"); browser.close();', {
    filePath: 'tests/app.spec.js'
  });

  assert.deepEqual(results[0].messages, []);
});

test('unused variables warn, and the underscore convention is respected', async () => {
  const results = await lint('const unused = 1;\nconst _ignored = 2;\n');
  const messages = results[0].messages;

  assert.equal(messages.length, 1, JSON.stringify(messages));
  assert.equal(messages[0].ruleId, 'no-unused-vars');
  assert.equal(messages[0].severity, 1, 'a warning, so it does not fail a build');
});

test('generated files are ignored', async () => {
  const eslint = new ESLint({ cwd: process.cwd(), overrideConfigFile: true, overrideConfig: appConfig });

  assert.equal(await eslint.isPathIgnored('src/Components/components.js'), true);
  assert.equal(await eslint.isPathIgnored('dist/App/index.js'), true);
  assert.equal(await eslint.isPathIgnored('src/App/index.js'), false);
});

test('an app can append its own globals after the preset', async () => {
  const results = await lint('ToastProvider.show("x");', {
    config: [...appConfig, { languageOptions: { globals: { ToastProvider: 'writable' } } }]
  });

  assert.deepEqual(results[0].messages, []);
});
