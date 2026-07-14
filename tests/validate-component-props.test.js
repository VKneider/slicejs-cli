import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { withTestProject } from './helpers/setup.js';
import { validateComponentProps } from '../commands/types/types.js';
import build from '../commands/build/build.js';

// Shared validator used by both `slice doctor` and `slice build`. Errors block
// the build; warnings are advisory.

async function writeWidget(root, propsLiteral) {
  const js = `export default class Widget extends HTMLElement {\n  static props = ${propsLiteral};\n}`;
  await fs.writeFile(path.join(root, 'src', 'Components', 'Visual', 'Widget', 'Widget.js'), js);
}

describe('validateComponentProps', () => {
  test('clean props produce no errors or warnings', async () => {
    await withTestProject(async (root) => {
      await writeWidget(root, `{ label: { type: 'string', default: 'Hi' } }`);
      const { errors, warnings, checkedCount } = await validateComponentProps({ projectRoot: root });
      assert.equal(errors.length, 0);
      assert.equal(warnings.length, 0);
      assert.ok(checkedCount >= 1);
    }, { visualComponents: ['Widget'] });
  });

  test('unknown prop type is an error (blocks build)', async () => {
    await withTestProject(async (root) => {
      await writeWidget(root, `{ x: { type: 'bogus', default: 1 } }`);
      const { errors } = await validateComponentProps({ projectRoot: root });
      assert.ok(errors.some((e) => e.component === 'Widget' && /unknown type/.test(e.message)));
    }, { visualComponents: ['Widget'] });
  });

  test('schema on a non-object prop is an error', async () => {
    await withTestProject(async (root) => {
      await writeWidget(root, `{ x: { type: 'string', schema: { a: 'string' } } }`);
      const { errors } = await validateComponentProps({ projectRoot: root });
      assert.ok(errors.some((e) => /schema/.test(e.message)));
    }, { visualComponents: ['Widget'] });
  });

  test('allowedValues type mismatch is an error', async () => {
    await withTestProject(async (root) => {
      await writeWidget(root, `{ x: { type: 'number', allowedValues: ['a', 'b'] } }`);
      const { errors } = await validateComponentProps({ projectRoot: root });
      assert.ok(errors.some((e) => /allowedValues type mismatch/.test(e.message)));
    }, { visualComponents: ['Widget'] });
  });

  test('type "any" is a warning, not an error', async () => {
    await withTestProject(async (root) => {
      await writeWidget(root, `{ x: { type: 'any' } }`);
      const { errors, warnings } = await validateComponentProps({ projectRoot: root });
      assert.equal(errors.length, 0);
      assert.ok(warnings.some((w) => /any/.test(w.message)));
    }, { visualComponents: ['Widget'] });
  });
});

describe('slice build gate', () => {
  test('build aborts (exit 1) when a component has a prop error', async () => {
    await withTestProject(async (root) => {
      await writeWidget(root, `{ x: { type: 'bogus' } }`);
      const origExit = process.exit;
      // Turn the hard exit into a catchable throw so it doesn't kill the runner.
      process.exit = (code) => { throw new Error(`__slice_exit__:${code}`); };
      try {
        await assert.rejects(() => build({ minify: false, obfuscate: false }), /__slice_exit__:1/);
      } finally {
        process.exit = origExit;
      }
    }, { visualComponents: ['Widget'] });
  });

  test('--no-validate bypasses the gate (does not abort on a prop error)', async () => {
    await withTestProject(async (root) => {
      await writeWidget(root, `{ x: { type: 'bogus' } }`);
      const origExit = process.exit;
      let exited = false;
      process.exit = () => { exited = true; throw new Error('__slice_exit__'); };
      try {
        // validate:false skips the gate; the build proceeds past validation.
        // (It may still succeed or fail later, but it must not exit at the gate.)
        await build({ minify: false, obfuscate: false, validate: false }).catch(() => {});
        assert.equal(exited, false, 'build must not abort at the validation gate with --no-validate');
      } finally {
        process.exit = origExit;
      }
    }, { visualComponents: ['Widget'] });
  });
});
