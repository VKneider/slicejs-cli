import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';
import { withTestProject } from './helpers/setup.js';

// Integration tests for transitive dependency resolution in `slice get`.
//
// Instead of hitting the real GitHub registry, we mock globalThis.fetch to
// serve a small synthetic component repo. This exercises the *real* recursive
// installComponent path (download → parse → resolve → recurse) against a real
// temp-project filesystem, fully offline and deterministic.
//
// Synthetic repo dependency shape:
//   Widget (Visual)      -> slice.build('EngineSvc'), slice.build('SubWidget'), slice.build('MultiRoute')
//   SubWidget (Visual)   -> import './helpers/math.js'            (helper module)
//   helpers/math.js      -> import './trig.js'                    (helper importing helper)
//   EngineSvc (Service)  -> (none)
//   MultiRoute (Visual)  -> JS-only registry component (no html/css)
//   Ping (Visual)        -> slice.build('Pong')   \  cycle
//   Pong (Visual)        -> slice.build('Ping')   /
//   AlphaCard, BetaCard  -> both slice.build('EngineSvc')         (shared dep)
//   Lonely (Visual)      -> slice.build('Controller')             (structural, not in registry)

const REGISTRY = {
  Widget: 'Visual', SubWidget: 'Visual', EngineSvc: 'Service', MultiRoute: 'Visual',
  Ping: 'Visual', Pong: 'Visual', AlphaCard: 'Visual', BetaCard: 'Visual', Lonely: 'Visual'
};

const FILES = {
  'Visual/Widget/Widget.js':
    `export default class Widget extends HTMLElement { async init(){ await slice.build('EngineSvc',{}); await slice.build('SubWidget',{}); await slice.build('MultiRoute',{routes:[]}); } }`,
  'Visual/Widget/Widget.html': '<div class="widget"></div>',
  'Visual/Widget/Widget.css': '.widget{}',

  'Visual/SubWidget/SubWidget.js':
    `import { add } from './helpers/math.js'; export default class SubWidget extends HTMLElement { init(){ return add(1,2); } }`,
  'Visual/SubWidget/SubWidget.html': '<div></div>',
  'Visual/SubWidget/SubWidget.css': '',
  'Visual/SubWidget/helpers/math.js':
    `import { sin } from './trig.js'; export const add = (a,b)=>a+b+sin(0);`,
  'Visual/SubWidget/helpers/trig.js': `export const sin = (x)=>Math.sin(x);`,

  'Service/EngineSvc/EngineSvc.js': `export default class EngineSvc {}`,

  'Visual/MultiRoute/MultiRoute.js': `export default class MultiRoute extends HTMLElement {}`,

  'Visual/Ping/Ping.js': `export default class Ping extends HTMLElement { async init(){ await slice.build('Pong',{}); } }`,
  'Visual/Ping/Ping.html': '', 'Visual/Ping/Ping.css': '',
  'Visual/Pong/Pong.js': `export default class Pong extends HTMLElement { async init(){ await slice.build('Ping',{}); } }`,
  'Visual/Pong/Pong.html': '', 'Visual/Pong/Pong.css': '',

  'Visual/AlphaCard/AlphaCard.js': `export default class AlphaCard extends HTMLElement { async init(){ await slice.build('EngineSvc',{}); } }`,
  'Visual/AlphaCard/AlphaCard.html': '', 'Visual/AlphaCard/AlphaCard.css': '',
  'Visual/BetaCard/BetaCard.js': `export default class BetaCard extends HTMLElement { async init(){ await slice.build('EngineSvc',{}); } }`,
  'Visual/BetaCard/BetaCard.html': '', 'Visual/BetaCard/BetaCard.css': '',

  'Visual/Lonely/Lonely.js': `export default class Lonely extends HTMLElement { async init(){ await slice.build('Controller',{}); } }`,
  'Visual/Lonely/Lonely.html': '', 'Visual/Lonely/Lonely.css': ''
};

const MARKER = '/src/Components/';

function installFetchMock() {
  const calls = {};
  const registryText = `const components = ${JSON.stringify(REGISTRY)};\nexport default components;\n`;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith(`${MARKER}components.js`)) {
      return { ok: true, text: async () => registryText, arrayBuffer: async () => Buffer.from(registryText) };
    }
    const rel = u.slice(u.indexOf(MARKER) + MARKER.length);
    calls[rel] = (calls[rel] || 0) + 1;
    if (FILES[rel] !== undefined) {
      return { ok: true, text: async () => FILES[rel], arrayBuffer: async () => Buffer.from(FILES[rel]) };
    }
    return { ok: false, status: 404, statusText: 'Not Found' };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

describe('slice get — transitive dependency resolution (integration)', () => {
  let getComponents;
  let mock;

  before(async () => {
    ({ default: getComponents } = await import('../commands/getComponent/getComponent.js'));
  });

  beforeEach(() => { mock = installFetchMock(); });
  afterEach(() => { mock.restore(); });

  const compPath = (dir, ...seg) => path.join(dir, 'src', 'Components', ...seg);
  const exists = (dir, ...seg) => fs.pathExists(compPath(dir, ...seg));

  test('installs slice.build deps, transitive builds, nested helper modules and a JS-only dep', async () => {
    await withTestProject(async (dir) => {
      await getComponents(['Widget'], { force: true });

      // requested component
      assert.ok(await exists(dir, 'Visual', 'Widget', 'Widget.js'));
      assert.ok(await exists(dir, 'Visual', 'Widget', 'Widget.html'));
      assert.ok(await exists(dir, 'Visual', 'Widget', 'Widget.css'));
      // slice.build deps
      assert.ok(await exists(dir, 'Service', 'EngineSvc', 'EngineSvc.js'));
      assert.ok(await exists(dir, 'Visual', 'SubWidget', 'SubWidget.js'));
      // transitive helper modules (import chain: SubWidget -> math.js -> trig.js)
      assert.ok(await exists(dir, 'Visual', 'SubWidget', 'helpers', 'math.js'));
      assert.ok(await exists(dir, 'Visual', 'SubWidget', 'helpers', 'trig.js'));
      // JS-only registry component (MultiRoute): only .js requested, no html/css
      assert.ok(await exists(dir, 'Visual', 'MultiRoute', 'MultiRoute.js'));
      assert.equal(mock.calls['Visual/MultiRoute/MultiRoute.html'], undefined);

      // registry records components (but NOT helper modules)
      const registry = await fs.readFile(compPath(dir, 'components.js'), 'utf8');
      for (const name of ['Widget', 'EngineSvc', 'SubWidget', 'MultiRoute']) {
        assert.ok(registry.includes(`"${name}"`), `${name} registered`);
      }
      assert.ok(!registry.includes('math'), 'helper modules are not registered as components');
    });
  });

  test('a build cycle terminates and never double-downloads', async () => {
    await withTestProject(async (dir) => {
      await getComponents(['Ping'], { force: true });

      assert.ok(await exists(dir, 'Visual', 'Ping', 'Ping.js'));
      assert.ok(await exists(dir, 'Visual', 'Pong', 'Pong.js'));
      assert.equal(mock.calls['Visual/Ping/Ping.js'], 1);
      assert.equal(mock.calls['Visual/Pong/Pong.js'], 1);
    });
  });

  test('a dependency shared by several requested components downloads once', async () => {
    await withTestProject(async (dir) => {
      await getComponents(['AlphaCard', 'BetaCard'], { force: true });

      assert.ok(await exists(dir, 'Visual', 'AlphaCard', 'AlphaCard.js'));
      assert.ok(await exists(dir, 'Visual', 'BetaCard', 'BetaCard.js'));
      assert.ok(await exists(dir, 'Service', 'EngineSvc', 'EngineSvc.js'));
      assert.equal(mock.calls['Service/EngineSvc/EngineSvc.js'], 1);
    });
  });

  test('--no-deps installs only the requested component', async () => {
    await withTestProject(async (dir) => {
      await getComponents(['Widget'], { force: true, deps: false });

      assert.ok(await exists(dir, 'Visual', 'Widget', 'Widget.js'));
      assert.equal(await exists(dir, 'Service', 'EngineSvc', 'EngineSvc.js'), false);
      assert.equal(await exists(dir, 'Visual', 'SubWidget', 'SubWidget.js'), false);
      assert.equal(await exists(dir, 'Visual', 'MultiRoute', 'MultiRoute.js'), false);
    });
  });

  test('an unknown build target (structural component) is skipped without aborting', async () => {
    await withTestProject(async (dir) => {
      const result = await getComponents(['Lonely'], { force: true });

      assert.equal(result, true);
      assert.ok(await exists(dir, 'Visual', 'Lonely', 'Lonely.js'));
      assert.equal(mock.calls['Visual/Controller/Controller.js'], undefined);
    });
  });
});
