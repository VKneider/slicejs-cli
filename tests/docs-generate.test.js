import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';

import { createTestProject, cleanupTestProject } from './helpers/setup.js';
import { scanComponentCatalog, loadProjectConfig } from '../commands/utils/componentCatalog.js';
import { generateDocs, checkDocs } from '../commands/docs/index.js';
import { generateEventDocs, checkEventDocs } from '../commands/docs/events.js';

async function project() {
   const root = await createTestProject();
   await fs.ensureDir(path.join(root, 'src', 'Components', 'Visual', 'CartBadge'));
   await fs.writeFile(
      path.join(root, 'src', 'Components', 'Visual', 'CartBadge', 'CartBadge.js'),
      `export default class CartBadge extends HTMLElement {
   init() {
      slice.events.subscribe('cart:add', () => {});
      slice.events.emit('cart:add', { sku: 'x' });
   }
}
`,
   );
   await fs.writeFile(
      path.join(root, 'src', 'Components', 'Visual', 'CartBadge', 'CartBadge.spec.js'),
      `slice.events.emit('spec:only'); slice.events.subscribe('spec:listen', () => {});\n`,
   );
   await fs.writeFile(
      path.join(root, 'src', 'Components', 'Visual', 'CartBadge', 'CartBadge.test.js'),
      `slice.events.emit('test:only');\n`,
   );
   return root;
}

test('client registers the docs generate/check command surface', async () => {
   const client = await fs.readFile(path.resolve('client.js'), 'utf8');
   assert.match(client, /command\("generate \[target\]"\)/);
   assert.match(client, /command\("check \[target\]"\)/);
   assert.match(client, /generateDocs\(/);
   assert.match(client, /checkDocs\(/);
});

test('componentCatalog reads categories and components from sliceConfig', async () => {
   const root = await project();
   try {
      const config = await loadProjectConfig(root);
      const catalog = await scanComponentCatalog({ projectRoot: root, config });
      const visual = catalog.categories.find((category) => category.name === 'Visual');
      assert.ok(visual);
      assert.ok(visual.components.some((component) => component.name === 'CartBadge'));
      assert.equal(visual.components.find((component) => component.name === 'CartBadge').category, 'Visual');
   } finally {
      await cleanupTestProject(root);
   }
});

test('docs generate agents writes components.js, AGENTS.md, CLAUDE.md and is checkable', async () => {
   const root = await project();
   try {
      await generateDocs({ projectRoot: root, target: 'agents' });
      assert.equal(await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
      const rootAgents = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
      assert.match(rootAgents, /Component categories/);
      assert.ok(await fs.pathExists(path.join(root, 'src', 'Components', 'Visual', 'AGENTS.md')));
      const visualAgents = await fs.readFile(path.join(root, 'src', 'Components', 'Visual', 'AGENTS.md'), 'utf8');
      assert.match(visualAgents, /CartBadge/);
      const registry = await fs.readFile(path.join(root, 'src', 'Components', 'components.js'), 'utf8');
      assert.match(registry, /"CartBadge": "Visual"/);

      assert.deepEqual(await checkDocs({ projectRoot: root, target: 'agents' }), { ok: true, issues: [] });

      const agentsPath = path.join(root, 'AGENTS.md');
      await fs.appendFile(agentsPath, '\nCustom project note.\n');
      await generateDocs({ projectRoot: root, target: 'agents' });
      assert.match(await fs.readFile(agentsPath, 'utf8'), /Custom project note/);

      await fs.writeFile(path.join(root, 'src', 'Components', 'components.js'), 'const components = {};\n');
      const drift = await checkDocs({ projectRoot: root, target: 'agents' });
      assert.equal(drift.ok, false);
      assert.ok(drift.issues.some((issue) => issue.includes('components.js')));
   } finally {
      await cleanupTestProject(root);
   }
});

test('docs generate types writes declarations and check detects drift', async () => {
   const root = await project();
   try {
      await generateDocs({ projectRoot: root, target: 'types' });
      assert.ok(await fs.pathExists(path.join(root, 'src', 'slice-build.generated.d.ts')));
      assert.ok(await fs.pathExists(path.join(root, 'src', 'slice-events.generated.js')));
      assert.deepEqual(await checkDocs({ projectRoot: root, target: 'types' }), { ok: true, issues: [] });

      await fs.appendFile(path.join(root, 'src', 'slice-build.generated.d.ts'), '\n// drift\n');
      const drift = await checkDocs({ projectRoot: root, target: 'types' });
      assert.equal(drift.ok, false);
      assert.ok(drift.issues.some((issue) => issue.includes('slice-build.generated.d.ts')));
   } finally {
      await cleanupTestProject(root);
   }
});

test('docs generate all produces agents, types and events; check all passes', async () => {
   const root = await project();
   try {
      await generateDocs({ projectRoot: root, target: 'all' });
      assert.ok(await fs.pathExists(path.join(root, 'AGENTS.md')));
      assert.ok(await fs.pathExists(path.join(root, 'src', 'slice-build.generated.d.ts')));
      assert.ok(await fs.pathExists(path.join(root, 'docs', 'events', 'index.md')));
      assert.deepEqual(await checkDocs({ projectRoot: root, target: 'all' }), { ok: true, issues: [] });
   } finally {
      await cleanupTestProject(root);
   }
});

test('event docs group by namespace and ignore specs/tests', async () => {
   const root = await project();
   try {
      await generateEventDocs({ projectRoot: root });
      const index = await fs.readFile(path.join(root, 'docs', 'events', 'index.md'), 'utf8');
      assert.match(index, /cart/);
      assert.doesNotMatch(index, /spec:only/);
      assert.doesNotMatch(index, /test:only/);

      const cart = await fs.readFile(path.join(root, 'docs', 'events', 'cart.md'), 'utf8');
      assert.match(cart, /cart:add/);
      assert.match(cart, /CartBadge/);

      const mermaid = await fs.readFile(path.join(root, 'docs', 'events', 'diagram.mmd'), 'utf8');
      assert.match(mermaid, /cart:add/);
      const html = await fs.readFile(path.join(root, 'docs', 'events', 'diagram.html'), 'utf8');
      assert.match(html, /cart:add/);
      assert.match(html, /<svg/);

      assert.deepEqual(await checkEventDocs({ projectRoot: root }), { ok: true, issues: [] });
      await fs.writeFile(
         path.join(root, 'docs', 'events', 'old.md'),
         '<!-- Generated by `slice docs generate events`. Do not edit by hand. -->\n# old\n',
      );
      const orphan = await checkEventDocs({ projectRoot: root });
      assert.equal(orphan.ok, false);
      assert.ok(orphan.issues.some((issue) => issue.includes('orphan')));
      await fs.remove(path.join(root, 'docs', 'events', 'old.md'));

      await fs.appendFile(
         path.join(root, 'src', 'Components', 'Visual', 'CartBadge', 'CartBadge.js'),
         `\nslice.events.emit('cart:cleared');\n`,
      );
      assert.equal((await checkEventDocs({ projectRoot: root })).ok, false);
   } finally {
      await cleanupTestProject(root);
   }
});
