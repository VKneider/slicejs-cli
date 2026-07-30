import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { parse } from '@babel/parser';
import { withTestProject } from './helpers/setup.js';
import buildProduction from '../commands/buildProduction/buildProduction.js';

const MODULE_URL = import.meta.url;

async function writeSrc(root, rel, content) {
  const p = path.join(root, 'src', rel);
  await fs.ensureDir(path.dirname(p));
  await fs.writeFile(p, content, 'utf8');
  return p;
}

function collectBuiltFiles(distDir, pattern) {
  const results = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js') && (pattern ? e.name.match(pattern) : true)) results.push(full);
    }
  }
  walk(distDir);
  return results;
}

describe('e2e: property names survive minification', () => {

  describe('build succeeds and preserves public props', () => {

    test('build completes successfully', async () => {
      await withTestProject(async (root) => {
        const ok = await buildProduction({ minify: true });
        assert.equal(ok, true);
      });
    });

    test('onClick preserved across all built component files', async () => {
      await withTestProject(async (root) => {
        await writeSrc(root, 'Components/Visual/Pagination/Pagination.js', `
          import { Component } from '../../App/index.js';
          class Pagination extends HTMLElement {
            static props = {
              currentPage: { type: 'number' },
              totalPages: { type: 'number' },
              onClick: { type: 'function' },
              onChange: { type: 'function' }
            }
            handleClick() { this.onClick() }
          }
          customElements.define('slice-pagination', Pagination);
          export { Pagination };
        `);
        await writeSrc(root, 'Components/Visual/Table/Table.js', `
          import { Component } from '../../App/index.js';
          class Table extends HTMLElement {
            static props = {
              items: { type: 'array' },
              onClick: { type: 'function' },
              onChange: { type: 'function' },
              setPage: { type: 'function' },
              sliceId: { type: 'string' }
            }
            handle(target) { target.onClick(); target.onChange(); target.setPage(1); }
            getId() { return this.sliceId }
          }
          customElements.define('slice-table', Table);
          export { Table };
        `);

        const ok = await buildProduction({ minify: true });
        assert.equal(ok, true);

        const builtFiles = collectBuiltFiles(root + '/dist');
        const allContent = builtFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');

        assert.ok(allContent.includes('onClick'), '"onClick" must survive mangling');
        assert.ok(allContent.includes('onChange'), '"onChange" must survive mangling');
        assert.ok(allContent.includes('sliceId'), '"sliceId" must survive mangling');
        assert.ok(allContent.includes('setPage'), '"setPage" must survive mangling');
      });
    });

    test('_private properties ARE mangled', async () => {
      await withTestProject(async (root) => {
        await writeSrc(root, 'Components/Visual/Toast/Toast.js', `
          import { Component } from '../../App/index.js';
          class Toast extends HTMLElement {
            static props = { message: { type: 'string' }, type: { type: 'string' }, duration: { type: 'number' } }
            set message(v) { this._message = v; this.render(); }
            set type(v) { this._type = v; this.render(); }
            set duration(v) { this._duration = v; this.initTimer(); }
            get message() { return this._message }
            get type() { return this._type }
            get duration() { return this._duration }
            render() { this.shadowRoot.innerHTML = this._message }
            initTimer() { setTimeout(() => this.hide(), this._duration) }
            hide() {}
          }
          customElements.define('slice-toast', Toast);
          export { Toast };
        `);

        const ok = await buildProduction({ minify: true });
        assert.equal(ok, true);

        const distJs = path.join(root, 'dist', 'Components', 'Visual', 'Toast', 'Toast.js');
        const built = fs.readFileSync(distJs, 'utf8');

        // Property mangling is off (see JsMinifier.sourceFileOptions): the
        // bundler never mangled properties, and mangling them here gave the same
        // field two names across dist/ artifacts.
        assert.match(built, /_message/, '_message backing field must be preserved');
        assert.match(built, /_type/, '_type backing field must be preserved');
        assert.match(built, /_duration/, '_duration backing field must be preserved');

        assert.doesNotThrow(() => parse(built, { sourceType: 'module' }), 'output must be valid JS');
      });
    });

  });

  describe('cross-file access — public props preserved', () => {

    test('Table calls Pagination.onClick — both preserve same name', async () => {
      await withTestProject(async (root) => {
        await writeSrc(root, 'Components/Visual/Pagination/Pagination.js', `
          class Pagination extends HTMLElement {
            static props = { currentPage: { type: 'number' }, onClick: { type: 'function' } }
            fire() { this.onClick(this.currentPage) }
          }
          customElements.define('slice-pagination', Pagination);
          export { Pagination };
        `);
        await writeSrc(root, 'Components/Visual/Table/Table.js', `
          class Table extends HTMLElement {
            connect(pager) { pager.onClick(this.handlePageChange) }
            handlePageChange(p) {}
          }
          customElements.define('slice-table', Table);
          export { Table };
        `);

        const ok = await buildProduction({ minify: true });
        assert.equal(ok, true);

        const distPagination = fs.readFileSync(path.join(root, 'dist', 'Components', 'Visual', 'Pagination', 'Pagination.js'), 'utf8');
        const distTable = fs.readFileSync(path.join(root, 'dist', 'Components', 'Visual', 'Table', 'Table.js'), 'utf8');

        assert.ok(distPagination.includes('onClick'), 'Pagination must preserve onClick');
        assert.ok(distTable.includes('onClick'), 'Table must preserve onClick');
      });
    });

    test('TreeView passes onClick to TreeItem — both preserve same name', async () => {
      await withTestProject(async (root) => {
        await writeSrc(root, 'Components/Visual/TreeItem/TreeItem.js', `
          class TreeItem extends HTMLElement {
            static props = { value: { type: 'string' }, onClick: { type: 'function' } }
            handle() { this.onClick() }
          }
          customElements.define('slice-tree-item', TreeItem);
          export { TreeItem };
        `);
        await writeSrc(root, 'Components/Visual/TreeView/TreeView.js', `
          import { TreeItem } from '../TreeItem/TreeItem.js';
          class TreeView extends HTMLElement {
            static props = { items: { type: 'array' }, onClick: { type: 'function' } }
            makeItem() { const item = new TreeItem(); item.onClick = this.onClick; return item; }
          }
          customElements.define('slice-tree-view', TreeView);
          export { TreeView };
        `);

        const ok = await buildProduction({ minify: true });
        assert.equal(ok, true);

        const distItem = fs.readFileSync(path.join(root, 'dist', 'Components', 'Visual', 'TreeItem', 'TreeItem.js'), 'utf8');
        const distView = fs.readFileSync(path.join(root, 'dist', 'Components', 'Visual', 'TreeView', 'TreeView.js'), 'utf8');

        assert.ok(distItem.includes('onClick'), 'TreeItem must preserve onClick');
        assert.ok(distView.includes('onClick'), 'TreeView must preserve onClick');

        assert.doesNotThrow(() => parse(distItem, { sourceType: 'module' }));
        assert.doesNotThrow(() => parse(distView, { sourceType: 'module' }));
      });
    });

    test('MiniInspector accesses sliceId on target — preserved', async () => {
      await withTestProject(async (root) => {
        await writeSrc(root, 'Components/Visual/MiniInspector/MiniInspector.js', `
          class MiniInspector extends HTMLElement {
            inspect(target) { return target.sliceId }
          }
          customElements.define('slice-inspector', MiniInspector);
          export { MiniInspector };
        `);
        await writeSrc(root, 'Components/Visual/Button/Button.js', `
          class Button extends HTMLElement {
            static props = { value: { type: 'string' }, sliceId: { type: 'string' } }
            get id() { return this.sliceId }
          }
          customElements.define('slice-button', Button);
          export { Button };
        `);

        const ok = await buildProduction({ minify: true });
        assert.equal(ok, true);

        const built = collectBuiltFiles(root + '/dist', /\.js$/);
        const allContent = built.map(f => fs.readFileSync(f, 'utf8')).join('\n');
        assert.ok(allContent.includes('sliceId'), 'sliceId must survive in all files');
      });
    });

  });

  describe('_private props stay consistent between reads and writes', () => {

    test('internal _ backing fields self-consistent within each component', async () => {
      await withTestProject(async (root) => {
        await writeSrc(root, 'Components/Visual/Counter/Counter.js', `
          class Counter extends HTMLElement {
            static props = { value: { type: 'number' } }
            set value(v) { this._value = v; this.updateDisplay(); }
            get value() { return this._value }
            updateDisplay() { this.textContent = this._value }
            increment() { this._value++; this.updateDisplay(); }
          }
          customElements.define('slice-counter', Counter);
          export { Counter };
        `);

        const ok = await buildProduction({ minify: true });
        assert.equal(ok, true);

        const distJs = path.join(root, 'dist', 'Components', 'Visual', 'Counter', 'Counter.js');
        const built = fs.readFileSync(distJs, 'utf8');

        assert.match(built, /_value/, '_value must be preserved, not mangled');

        // Reads and writes still have to line up — trivially now, but this is
        // what actually matters and it is what used to break across files.
        const reads = [...built.matchAll(/this\._value(?!\w)/g)];
        const writes = [...built.matchAll(/this\._value\s*=/g)];
        assert.ok(reads.length >= 2, `_value must be read at least twice (getter + updateDisplay), got ${reads.length}`);
        assert.ok(writes.length >= 1, `_value must be written at least once (setter), got ${writes.length}`);

        assert.doesNotThrow(() => parse(built, { sourceType: 'module' }));
      });
    });

  });

  describe('dist/ output integrity', () => {

    test('all built JS files are valid ES modules', async () => {
      await withTestProject(async (root) => {
        const ok = await buildProduction({ minify: true });
        assert.equal(ok, true);

        const builtFiles = collectBuiltFiles(root + '/dist', /\.js$/);
        for (const f of builtFiles) {
          const content = fs.readFileSync(f, 'utf8');
          assert.doesNotThrow(
            () => parse(content, { sourceType: 'module', ecmaVersion: 2022 }),
            `${path.relative(root, f)} must be valid JS`
          );
        }
      });
    });

    test('critical Slice files survive with expected content', async () => {
      await withTestProject(async (root) => {
        const ok = await buildProduction({ minify: true });
        assert.equal(ok, true);

        const componentsJs = fs.readFileSync(path.join(root, 'dist', 'Components', 'components.js'), 'utf8');
        assert.match(componentsJs, /const components/);
        assert.match(componentsJs, /export default/);
      });
    });

  });

});
