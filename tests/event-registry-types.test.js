import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { createTestProject, cleanupTestProject } from './helpers/setup.js';

import {
  collectEventRegistry,
  collectEventGraph,
  buildEventManifest,
  generateDeclarationContent,
  payloadToTs
} from '../commands/types/types.js';

test('payloadToTs translates the mini-schema', () => {
  assert.equal(payloadToTs(null), 'void');
  assert.equal(payloadToTs('string'), 'string');
  assert.equal(payloadToTs({ id: 'number', name: 'string' }), '{ id: number; name: string }');
  assert.equal(payloadToTs({ flag: { type: 'boolean' } }), '{ flag: boolean }');
});

test('collectEventRegistry resolves inline and imported catalogs', async () => {
  const dir = await createTestProject();
  try {
    await fs.ensureDir(path.join(dir, 'src', 'events'));
    await fs.writeFile(
      path.join(dir, 'src', 'events', 'user.events.js'),
      `export const userEvents = {
         'user:login': { description: 'User logged in', payload: { id: 'number', name: 'string' } },
         'user:logout': { payload: null },
      };\n`
    );
    await fs.ensureDir(path.join(dir, 'src', 'Services', 'Providers'));
    await fs.writeFile(
      path.join(dir, 'src', 'Services', 'Providers', 'Providers.js'),
      `import { userEvents } from '../../events/user.events.js';
       export default class Providers {
         init() {
           slice.events.register(userEvents);
           slice.events.register({ 'cart:cleared': { payload: null }, 'cart:add': { payload: { sku: 'string' } } });
         }
       }\n`
    );

    const registry = await collectEventRegistry({ projectRoot: dir });
    assert.deepEqual(Object.keys(registry).sort(), ['cart:add', 'cart:cleared', 'user:login', 'user:logout']);
    assert.deepEqual(registry['user:login'].payload, { id: 'number', name: 'string' });
    assert.equal(registry['user:logout'].payload, null);
  } finally {
    await cleanupTestProject(dir);
  }
});

test('collectEventRegistry handles register(namespace, catalog)', async () => {
  const dir = await createTestProject();
  try {
    await fs.ensureDir(path.join(dir, 'src', 'Services', 'P'));
    await fs.writeFile(
      path.join(dir, 'src', 'Services', 'P', 'P.js'),
      `export default class P {
         init() {
           slice.events.register('user', { login: { payload: { id: 'number' } }, logout: { payload: null } });
         }
       }\n`
    );
    const registry = await collectEventRegistry({ projectRoot: dir });
    assert.deepEqual(Object.keys(registry).sort(), ['user:login', 'user:logout']);
    assert.deepEqual(registry['user:login'].payload, { id: 'number' });
  } finally {
    await cleanupTestProject(dir);
  }
});

test('generateDeclarationContent emits SliceEventRegistry + conditional signatures', () => {
  const decl = generateDeclarationContent(
    {},
    { 'user:login': { payload: { id: 'number' } }, 'cart:cleared': { payload: null } }
  );
  assert.ok(decl.includes('export interface SliceEventRegistry {'));
  assert.ok(decl.includes("'user:login': { id: number };"));
  assert.ok(decl.includes("'cart:cleared': void;"));
  // conditional-type signature (not a permissive string-fallback overload)
  assert.ok(decl.includes('SliceEventArgs<K>'));
  assert.ok(decl.includes('events: SliceTypedEventManager;'));
});

test('collectEventGraph documents emit/subscribe call sites (static)', async () => {
  const dir = await createTestProject();
  try {
    await fs.ensureDir(path.join(dir, 'src', 'C', 'Cart'));
    await fs.ensureDir(path.join(dir, 'src', 'C', 'Header'));
    await fs.writeFile(
      path.join(dir, 'src', 'C', 'Cart', 'Cart.js'),
      `export default class Cart {
         init() { this.events = slice.events.bind(this); }
         add(s) { this.events.emit('cart:add', { sku: s }); }
         clear() { slice.events.emit('cart:cleared'); }
         dyn(x) { slice.events.emit(\`cart:\${x}\`); }
       }\n`
    );
    await fs.writeFile(
      path.join(dir, 'src', 'C', 'Header', 'Header.js'),
      `export default class Header {
         init() { slice.events.subscribe('cart:add', () => {}); }
       }\n`
    );

    const graph = await collectEventGraph({ projectRoot: dir });
    assert.equal(graph.events['cart:add'].emitters[0].component, 'Cart');
    assert.equal(graph.events['cart:add'].listeners[0].component, 'Header');
    assert.equal(graph.events['cart:cleared'].emitters[0].component, 'Cart');
    assert.equal(graph.dynamic.emitters.length, 1, 'dynamic emit captured separately');

    const manifest = buildEventManifest({ 'cart:add': { payload: { sku: 'string' } } }, graph);
    assert.deepEqual(manifest.events['cart:add'].payload, { sku: 'string' });
    assert.ok(manifest.events['cart:add'].emitters.length === 1);
    assert.ok(manifest.events['cart:cleared'], 'event with sites but no registry entry still documented');
  } finally {
    await cleanupTestProject(dir);
  }
});

test('no register() calls => no event types emitted (loose mode)', async () => {
  const dir = await createTestProject();
  try {
    const registry = await collectEventRegistry({ projectRoot: dir });
    assert.deepEqual(registry, {});
    const decl = generateDeclarationContent({}, registry);
    assert.ok(!decl.includes('SliceEventRegistry'), 'no event interface when nothing registered');
    assert.ok(decl.includes('& Record<string, any>'), 'global slice keeps its dynamic shape');
  } finally {
    await cleanupTestProject(dir);
  }
});
