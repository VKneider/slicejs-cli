import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestProject, cleanupTestProject } from './helpers/setup.js';

import {
  ensureEditorConfigForTypes,
  extractStaticPropsFromSource,
  generateTypesFile,
  generateDeclarationContent
} from '../commands/types/types.js';

describe('parseComponentsRegistry', () => {
  let parseComponentsRegistry;

  before(async () => {
    const types = await import('../commands/types/types.js');
    parseComponentsRegistry = types.parseComponentsRegistry;
  });

  test('parses valid components.js content', () => {
    const content = 'const components = {"Button": "Visual", "FetchManager": "Service"};\nexport default components;\n';
    const result = parseComponentsRegistry(content, '/fake/path/components.js');
    assert.deepEqual(result, { Button: 'Visual', FetchManager: 'Service' });
  });

  test('parses components.js with newlines and whitespace', () => {
    const content = 'const components = {\n  "Button": "Visual",\n  "FetchManager": "Service"\n};\nexport default components;\n';
    const result = parseComponentsRegistry(content, '/fake/path/components.js');
    assert.deepEqual(result, { Button: 'Visual', FetchManager: 'Service' });
  });

  test('throws on content that does not match expected format', () => {
    const content = 'export default {};\n';
    assert.throws(
      () => parseComponentsRegistry(content, '/project/src/Components/components.js'),
      /Invalid format in.*components.js.*Expected: const components/
    );
  });

  test('throws on completely unrelated content', () => {
    assert.throws(
      () => parseComponentsRegistry('not javascript at all!!!', '/project/src/Components/components.js'),
      /Invalid format in/
    );
  });

  test('throws on malformed JSON inside matched pattern', () => {
    const content = 'const components = {"Button": "Visual", invalid};\nexport default components;\n';
    assert.throws(
      () => parseComponentsRegistry(content, '/project/src/Components/components.js'),
      /Failed to parse components registry/
    );
  });

  test('throws on empty object literal but JSON valid', () => {
    const content = 'const components = {};\nexport default components;\n';
    const result = parseComponentsRegistry(content, '/fake/path/components.js');
    assert.deepEqual(result, {});
  });
});

describe('extractStaticPropsFromSource errors', () => {
  test('returns null when source has a syntax error', () => {
    const source = 'export default class Broken extends HTMLElement {';
    const result = extractStaticPropsFromSource(source, '/test/Broken.js');
    assert.equal(result, null);
  });

  test('returns null when source has no static props', () => {
    const source = `
      export default class Button extends HTMLElement {
        constructor() { super(); }
        connectedCallback() {}
      }
    `;
    const result = extractStaticPropsFromSource(source, '/test/Button.js');
    assert.equal(result, null);
  });

  test('returns null for an empty static props object', () => {
    const source = `
      export default class Button extends HTMLElement {
        static props = {};
      }
    `;
    const result = extractStaticPropsFromSource(source, '/test/Button.js');
    assert.equal(result, null);
  });

  test('returns null when there is no class at all', () => {
    const source = 'const x = 42;';
    const result = extractStaticPropsFromSource(source, '/test/NotClass.js');
    assert.equal(result, null);
  });

  test('parses static props with simple types', () => {
    const source = `
      export default class Button extends HTMLElement {
        static props = {
          label: { type: 'string' },
          count: { type: 'number' },
          active: { type: 'boolean' }
        };
      }
    `;
    const result = extractStaticPropsFromSource(source, '/test/Button.js');
    assert.deepEqual(result, {
      label: { type: 'string', required: false },
      count: { type: 'number', required: false },
      active: { type: 'boolean', required: false }
    });
  });
});

describe('generateTypesFile error scenarios', () => {
  test('throws when components.js does not exist', async () => {
    const tmpRoot = await createTestProject();
    try {
      const componentsPath = path.join(tmpRoot, 'src', 'Components', 'components.js');
      fs.unlinkSync(componentsPath);
      const outputFile = path.join(tmpRoot, 'src', 'slice-build.generated.d.ts');
      await assert.rejects(
        () => generateTypesFile({ projectRoot: tmpRoot, outputPath: outputFile }),
        /Cannot read components registry/
      );
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });

  test('throws when components.js has invalid format', async () => {
    const tmpRoot = await createTestProject({ visualComponents: ['Button'] });
    try {
      const componentsPath = path.join(tmpRoot, 'src', 'Components', 'components.js');
      fs.writeFileSync(componentsPath, 'export default {};\n', 'utf8');
      const outputFile = path.join(tmpRoot, 'src', 'slice-build.generated.d.ts');
      await assert.rejects(
        () => generateTypesFile({ projectRoot: tmpRoot, outputPath: outputFile }),
        /Invalid format in/
      );
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });

  test('throws when components.js has malformed JSON', async () => {
    const tmpRoot = await createTestProject({ visualComponents: ['Button'] });
    try {
      const componentsPath = path.join(tmpRoot, 'src', 'Components', 'components.js');
      fs.writeFileSync(componentsPath, 'const components = {"Button": "Visual", invalid};\nexport default components;\n', 'utf8');
      const outputFile = path.join(tmpRoot, 'src', 'slice-build.generated.d.ts');
      await assert.rejects(
        () => generateTypesFile({ projectRoot: tmpRoot, outputPath: outputFile }),
        /Failed to parse components registry/
      );
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });

  test('continues when a component JS file has parse error (Babel failure)', async () => {
    const tmpRoot = await createTestProject();
    const srcDir = path.join(tmpRoot, 'src');
    try {
      const visualDir = path.join(srcDir, 'Components', 'Visual', 'Button');
      const outputFile = path.join(srcDir, 'slice-build.generated.d.ts');
      fs.mkdirSync(visualDir, { recursive: true });
      fs.writeFileSync(
        path.join(visualDir, 'Button.js'),
        'export default class Button extends HTMLElement { static props = { value: { type: "string" } }; }',
        'utf8'
      );
      fs.mkdirSync(path.join(srcDir, 'Components', 'Visual', 'Broken'), { recursive: true });
      fs.writeFileSync(
        path.join(srcDir, 'Components', 'Visual', 'Broken', 'Broken.js'),
        'export default class Broken extends HTMLElement { ',
        'utf8'
      );
      fs.writeFileSync(
        path.join(srcDir, 'Components', 'components.js'),
        'const components = {"Button": "Visual", "Broken": "Visual"};\nexport default components;\n',
        'utf8'
      );
      const result = await generateTypesFile({ projectRoot: tmpRoot, outputPath: outputFile });
      assert.equal(result.componentsProcessed, 2);
      assert.equal(fs.existsSync(result.outputPath), true);
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });

  test('skips component when JS file is missing', async () => {
    const tmpRoot = await createTestProject();
    const srcDir = path.join(tmpRoot, 'src');
    try {
      const visualDir = path.join(srcDir, 'Components', 'Visual', 'Button');
      const outputFile = path.join(srcDir, 'slice-build.generated.d.ts');
      fs.mkdirSync(visualDir, { recursive: true });
      fs.writeFileSync(
        path.join(visualDir, 'Button.js'),
        'export default class Button extends HTMLElement { static props = { value: { type: "string" } }; }',
        'utf8'
      );
      fs.writeFileSync(
        path.join(srcDir, 'Components', 'components.js'),
        'const components = {"Button": "Visual", "MissingComp": "Visual"};\nexport default components;\n',
        'utf8'
      );
      const result = await generateTypesFile({ projectRoot: tmpRoot, outputPath: outputFile });
      assert.equal(result.componentsProcessed, 1);
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });

  test('handles an empty registry gracefully', async () => {
    const tmpRoot = await createTestProject();
    const srcDir = path.join(tmpRoot, 'src');
    try {
      const outputFile = path.join(srcDir, 'slice-build.generated.d.ts');
      fs.writeFileSync(
        path.join(srcDir, 'Components', 'components.js'),
        'const components = {};\nexport default components;\n',
        'utf8'
      );
      const result = await generateTypesFile({ projectRoot: tmpRoot, outputPath: outputFile });
      assert.equal(result.componentsProcessed, 0);
      assert.equal(fs.existsSync(result.outputPath), true);
      const content = fs.readFileSync(result.outputPath, 'utf8');
      assert.match(content, /SliceBuildApi/);
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });

  test('component without static props gets dynamic fallback', async () => {
    const tmpRoot = await createTestProject();
    const srcDir = path.join(tmpRoot, 'src');
    try {
      const visualDir = path.join(srcDir, 'Components', 'Visual', 'NoProps');
      const outputFile = path.join(srcDir, 'slice-build.generated.d.ts');
      fs.mkdirSync(visualDir, { recursive: true });
      fs.writeFileSync(
        path.join(visualDir, 'NoProps.js'),
        'export default class NoProps extends HTMLElement { connectedCallback() {} }',
        'utf8'
      );
      fs.writeFileSync(
        path.join(srcDir, 'Components', 'components.js'),
        'const components = {"NoProps": "Visual"};\nexport default components;\n',
        'utf8'
      );
      const result = await generateTypesFile({ projectRoot: tmpRoot, outputPath: outputFile });
      assert.equal(result.componentsProcessed, 1);
      const content = fs.readFileSync(result.outputPath, 'utf8');
      assert.match(content, /export interface NoPropsProps/);
      assert.match(content, /\[key: string\]: unknown;/);
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });
});

describe('generateDeclarationContent edge cases', () => {
  test('handles empty props map', () => {
    const content = generateDeclarationContent({});
    assert.match(content, /SliceComponentName = keyof SliceComponentPropsMap;/);
    assert.match(content, /export interface SliceComponentPropsMap/);
  });

  test('handles component with no props', () => {
    const content = generateDeclarationContent({ Button: {} });
    assert.match(content, /export interface ButtonProps/);
    assert.match(content, /\[key: string\]: unknown;/);
  });

  test('handles allowed values with mixed types', () => {
    const content = generateDeclarationContent({
      Input: {
        value: { type: 'string', required: false, allowedValues: ['a', 'b'] },
        size: { type: 'number', required: false, allowedValues: [1, 2, 3] }
      }
    });
    assert.match(content, /value\?: 'a' \| 'b';/);
    assert.match(content, /size\?: 1 \| 2 \| 3;/);
  });
});

describe('ensureEditorConfigForTypes robustness', () => {
  test('returns tsconfig_exists when tsconfig.json is present', async () => {
    const tmpRoot = await createTestProject();
    const outputFile = path.join(tmpRoot, 'src', 'slice-build.generated.d.ts');
    try {
      fs.writeFileSync(outputFile, 'export {};\n', 'utf8');
      fs.writeFileSync(path.join(tmpRoot, 'tsconfig.json'), '{}', 'utf8');
      const result = await ensureEditorConfigForTypes({ projectRoot: tmpRoot, outputPath: outputFile });
      assert.equal(result.mode, 'tsconfig_exists');
      assert.equal(fs.existsSync(path.join(tmpRoot, 'jsconfig.json')), false);
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });

  test('resets jsconfig when file is unreadable', async () => {
    const tmpRoot = await createTestProject();
    const outputFile = path.join(tmpRoot, 'src', 'slice-build.generated.d.ts');
    try {
      fs.writeFileSync(outputFile, 'export {};\n', 'utf8');
      const jsconfigPath = path.join(tmpRoot, 'jsconfig.json');
      fs.writeFileSync(jsconfigPath, '{', 'utf8');
      const result = await ensureEditorConfigForTypes({ projectRoot: tmpRoot, outputPath: outputFile });
      assert.equal(result.mode, 'reset_jsconfig');
      assert.equal(result.reason, 'invalid_json');
      assert.equal(fs.existsSync(jsconfigPath), true);
      const parsed = JSON.parse(fs.readFileSync(jsconfigPath, 'utf8'));
      assert.ok(parsed.compilerOptions);
      assert.ok(Array.isArray(parsed.include));
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });

  test('returns jsconfig_already_has_include when config is already correct', async () => {
    const tmpRoot = await createTestProject();
    const outputFile = path.join(tmpRoot, 'src', 'slice-build.generated.d.ts');
    try {
      fs.writeFileSync(outputFile, 'export {};\n', 'utf8');
      const result = await ensureEditorConfigForTypes({ projectRoot: tmpRoot, outputPath: outputFile });
      assert.equal(result.mode, 'created_jsconfig');
      const result2 = await ensureEditorConfigForTypes({ projectRoot: tmpRoot, outputPath: outputFile });
      assert.equal(result2.mode, 'updated_jsconfig');
      assert.equal(result2.includeAdded, false);
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });

  test('preserves existing compilerOptions when updating jsconfig', async () => {
    const tmpRoot = await createTestProject();
    const outputFile = path.join(tmpRoot, 'src', 'slice-build.generated.d.ts');
    const jsconfigPath = path.join(tmpRoot, 'jsconfig.json');
    try {
      fs.writeFileSync(outputFile, 'export {};\n', 'utf8');
      fs.writeFileSync(
        jsconfigPath,
        JSON.stringify({ compilerOptions: { strict: true, customOption: true }, include: ['src/Components/**/*.js'] }),
        'utf8'
      );
      const result = await ensureEditorConfigForTypes({ projectRoot: tmpRoot, outputPath: outputFile });
      assert.equal(result.mode, 'updated_jsconfig');
      const parsed = JSON.parse(fs.readFileSync(jsconfigPath, 'utf8'));
      assert.equal(parsed.compilerOptions.strict, true);
      assert.equal(parsed.compilerOptions.customOption, true);
      assert.equal(parsed.compilerOptions.checkJs, true);
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });
});
