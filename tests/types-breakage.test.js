import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestProject, cleanupTestProject } from './helpers/setup.js';
import Print from '../commands/Print.js';

import {
  generateTypesFile,
  generateDeclarationContent,
  extractStaticPropsFromSource,
  parseComponentsRegistry,
  ensureEditorConfigForTypes,
  ensureNoCheckInPublicVendorFiles
} from '../commands/types/types.js';

describe('parseComponentsRegistry — breakage', () => {
  test('nested braces in values parse correctly', () => {
    const content = 'const components = {"Button": {"nested": true}};\nexport default components;\n';
    const result = parseComponentsRegistry(content, '/test/components.js');
    assert.deepEqual(result.Button, { nested: true });
  });

  test('duplicate keys keep last value (no error)', () => {
    const content = 'const components = {"Button": "Visual", "Button": "Service"};\nexport default components;\n';
    const result = parseComponentsRegistry(content, '/test/components.js');
    assert.equal(result.Button, 'Service');
  });

  test('trailing comma in JSON throws', () => {
    const content = 'const components = {"a": "Visual",};\nexport default components;\n';
    assert.throws(
      () => parseComponentsRegistry(content, '/test/components.js'),
      /Failed to parse components registry/
    );
  });

  test('no semicolon after object throws invalid format', () => {
    const content = 'const components = {"a": "Visual"}';
    assert.throws(
      () => parseComponentsRegistry(content, '/test/components.js'),
      /Invalid format in/
    );
  });

  test('literal } inside a string value is valid JSON', () => {
    const content = 'const components = {"a": "foo}"};\nexport default components;\n';
    const result = parseComponentsRegistry(content, '/test/components.js');
    assert.equal(result.a, 'foo}');
  });

  test('multiple const components declarations — only first is captured', () => {
    const content = 'const components = {"a": "Visual"};\nconst components = {"b": "Service"};';
    const result = parseComponentsRegistry(content, '/test/components.js');
    assert.deepEqual(result, { a: 'Visual' });
  });

  test('prototype pollution keys are parsed as normal keys', () => {
    const content = 'const components = {"__proto__": {"polluted": true}};\nexport default components;\n';
    const result = parseComponentsRegistry(content, '/test/components.js');
    assert.deepEqual(result.__proto__, { polluted: true });
  });
});

describe('extractStaticPropsFromSource — breakage', () => {
  test('computed property keys are silently dropped', () => {
    const source = `
      const KEY = 'label';
      export default class Button extends HTMLElement {
        static props = {
          [KEY]: { type: 'string' },
          normal: { type: 'number' }
        };
      }
    `;
    const result = extractStaticPropsFromSource(source, '/test/Button.js');
    assert.equal(result.normal.type, 'number');
    assert.equal(result.label, undefined);
  });

  test('method shorthand in props is skipped', () => {
    const source = `
      export default class Button extends HTMLElement {
        static props = {
          onClick() { console.log('click'); },
          normal: { type: 'string' }
        };
      }
    `;
    const result = extractStaticPropsFromSource(source, '/test/Button.js');
    assert.equal(result.onClick, undefined);
    assert.equal(result.normal.type, 'string');
  });

  test('spread expressions lose the spread content', () => {
    const source = `
      const BASE = { value: { type: 'string' } };
      export default class Button extends HTMLElement {
        static props = {
          ...BASE,
          extra: { type: 'number' }
        };
      }
    `;
    const result = extractStaticPropsFromSource(source, '/test/Button.js');
    assert.equal(result.value, undefined);
    assert.equal(result.extra.type, 'number');
  });

  test('shorthand property is silently dropped', () => {
    const source = `
      const value = { type: 'string' };
      export default class Button extends HTMLElement {
        static props = { value };
      }
    `;
    const result = extractStaticPropsFromSource(source, '/test/Button.js');
    assert.equal(result, null);
  });

  test('null literal as prop value becomes type any', () => {
    const source = `
      export default class Button extends HTMLElement {
        static props = { value: null };
      }
    `;
    const result = extractStaticPropsFromSource(source, '/test/Button.js');
    assert.deepEqual(result.value, { type: 'any', required: false });
  });

  test('getter in static props is skipped', () => {
    const source = `
      export default class Button extends HTMLElement {
        static props = {
          get dynamicProp() { return { type: 'string' }; },
          normal: { type: 'number' }
        };
      }
    `;
    const result = extractStaticPropsFromSource(source, '/test/Button.js');
    assert.equal(result.dynamicProp, undefined);
    assert.equal(result.normal.type, 'number');
  });

  test('reserved JS keywords as prop names parse ok', () => {
    const source = `
      export default class Button extends HTMLElement {
        static props = {
          class: { type: 'string' },
          delete: { type: 'boolean' },
          return: { type: 'number' }
        };
      }
    `;
    const result = extractStaticPropsFromSource(source, '/test/Button.js');
    assert.notEqual(result, null);
    assert.equal(result.class.type, 'string');
    assert.equal(result.delete.type, 'boolean');
    assert.equal(result.return.type, 'number');
  });

  test('async class with static props works', () => {
    const source = `
      export default class DataLoader extends HTMLElement {
        static props = { url: { type: 'string', required: true } };
        async loadData() {}
      }
    `;
    const result = extractStaticPropsFromSource(source, '/test/DataLoader.js');
    assert.deepEqual(result, { url: { type: 'string', required: true } });
  });
});

describe('generateDeclarationContent — breakage', () => {
  test('reserved TS keyword as component name generates invalid TS', () => {
    const content = generateDeclarationContent({
      class: { value: { type: 'string', required: false } },
      delete: { flag: { type: 'boolean', required: false } }
    });
    assert.match(content, /export interface classProps/);
    assert.match(content, /export interface deleteProps/);
  });

  test('digit-starting component name yields a valid interface name', () => {
    // Was characterized as broken: `export interface 123CompProps` is not a
    // valid identifier. The name is now encoded, and the map key quoted.
    const content = generateDeclarationContent({
      '123Comp': { val: { type: 'string', required: false } }
    });
    assert.doesNotMatch(content, /export interface 123CompProps/);
    assert.match(content, /"123Comp": /, 'the props-map key must be quoted');
    const [, interfaceName] = content.match(/export interface (\S+Props) \{/) || [];
    assert.match(interfaceName || '', /^[A-Za-z_$][A-Za-z0-9_$]*$/);
  });

  test('hyphenated component name yields a valid interface name', () => {
    // Was characterized as broken — see tests/types-declaration-safety.test.js.
    const content = generateDeclarationContent({
      'my-component': { val: { type: 'string', required: false } }
    });
    assert.doesNotMatch(content, /export interface my-componentProps/);
    assert.match(content, /"my-component": /, 'the props-map key must be quoted');
  });

  test('__dynamicPropsFallback as real prop is hidden from declaration', () => {
    const content = generateDeclarationContent({
      MyComp: { __dynamicPropsFallback: { type: 'string', required: false } }
    });
    assert.doesNotMatch(content, /__dynamicPropsFallback/);
    assert.match(content, /\[key: string\]: unknown;/);
  });

  test('empty allowedValues produces string type', () => {
    const content = generateDeclarationContent({
      Input: { val: { type: 'string', required: false, allowedValues: [] } }
    });
    assert.match(content, /val\?: string/);
  });
});

describe('generateTypesFile — file corruption breakage', () => {
  test('components.js with BOM is handled', async () => {
    const tmpRoot = await createTestProject({ visualComponents: ['Button'] });
    try {
      const componentsPath = path.join(tmpRoot, 'src', 'Components', 'components.js');
      fs.writeFileSync(componentsPath, '\uFEFFconst components = {"Button": "Visual"};\nexport default components;\n', 'utf8');
      const outputFile = path.join(tmpRoot, 'src', 'slice-build.generated.d.ts');
      const result = await generateTypesFile({ projectRoot: tmpRoot, outputPath: outputFile });
      assert.equal(result.componentsProcessed, 1);
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });

  test('binary content in components.js throws parse error', async () => {
    const tmpRoot = await createTestProject({ visualComponents: ['Button'] });
    try {
      const componentsPath = path.join(tmpRoot, 'src', 'Components', 'components.js');
      fs.writeFileSync(componentsPath, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
      const outputFile = path.join(tmpRoot, 'src', 'slice-build.generated.d.ts');
      await assert.rejects(
        () => generateTypesFile({ projectRoot: tmpRoot, outputPath: outputFile }),
        /Invalid format in/
      );
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });

  test('empty components.js file throws invalid format', async () => {
    const tmpRoot = await createTestProject({ visualComponents: ['Button'] });
    try {
      const componentsPath = path.join(tmpRoot, 'src', 'Components', 'components.js');
      fs.writeFileSync(componentsPath, '', 'utf8');
      const outputFile = path.join(tmpRoot, 'src', 'slice-build.generated.d.ts');
      await assert.rejects(
        () => generateTypesFile({ projectRoot: tmpRoot, outputPath: outputFile }),
        /Invalid format in/
      );
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });

  test('component JS file with only whitespace', async () => {
    const tmpRoot = await createTestProject();
    const srcDir = path.join(tmpRoot, 'src');
    try {
      const visualDir = path.join(srcDir, 'Components', 'Visual', 'Blank');
      fs.mkdirSync(visualDir, { recursive: true });
      fs.writeFileSync(path.join(visualDir, 'Blank.js'), '   \n  \n', 'utf8');
      fs.writeFileSync(
        path.join(srcDir, 'Components', 'components.js'),
        'const components = {"Blank": "Visual"};\nexport default components;\n',
        'utf8'
      );
      const outputFile = path.join(srcDir, 'slice-build.generated.d.ts');
      const result = await generateTypesFile({ projectRoot: tmpRoot, outputPath: outputFile });
      assert.equal(result.componentsProcessed, 1);
      const content = fs.readFileSync(result.outputPath, 'utf8');
      assert.match(content, /\[key: string\]: unknown;/);
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });

  test('running twice produces identical output', async () => {
    const tmpRoot = await createTestProject({ visualComponents: ['Button'] });
    const srcDir = path.join(tmpRoot, 'src');
    try {
      fs.writeFileSync(
        path.join(srcDir, 'Components', 'Visual', 'Button', 'Button.js'),
        'export default class Button extends HTMLElement { static props = { label: { type: "string" } }; }',
        'utf8'
      );
      const outputFile = path.join(srcDir, 'slice-build.generated.d.ts');
      const first = await generateTypesFile({ projectRoot: tmpRoot, outputPath: outputFile });
      const firstContent = fs.readFileSync(first.outputPath, 'utf8');
      const second = await generateTypesFile({ projectRoot: tmpRoot, outputPath: outputFile });
      const secondContent = fs.readFileSync(second.outputPath, 'utf8');
      assert.equal(first.componentsProcessed, 1);
      assert.equal(second.componentsProcessed, 1);
      assert.equal(firstContent, secondContent);
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });
});

describe('ensureNoCheckInPublicVendorFiles — breakage', () => {
  test('returns zero counts when sliceConfig.json is missing', async () => {
    const tmpRoot = await createTestProject();
    try {
      fs.unlinkSync(path.join(tmpRoot, 'src', 'sliceConfig.json'));
      const result = await ensureNoCheckInPublicVendorFiles(tmpRoot);
      assert.deepEqual(result, { updatedFiles: 0, scannedFiles: 0 });
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });

  test('updates no files when src/public/ has no vendored JS', async () => {
    const tmpRoot = await createTestProject();
    try {
      // The starter's src/public holds only CSS/images/PWA files (no .js), so
      // there is nothing to suppress.
      const result = await ensureNoCheckInPublicVendorFiles(tmpRoot);
      assert.equal(result.updatedFiles, 0);
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });
});

describe('Print log counting during generateTypesFile errors', () => {
  test('missing components.js prints no extra logs beyond the thrown error', async () => {
    const tmpRoot = await createTestProject();
    try {
      const componentsPath = path.join(tmpRoot, 'src', 'Components', 'components.js');
      fs.unlinkSync(componentsPath);
      const outputFile = path.join(tmpRoot, 'src', 'slice-build.generated.d.ts');
      let warningCount = 0;
      const origWarning = Print.warning;
      Print.warning = () => { warningCount++; };
      let errorCount = 0;
      const origError = Print.error;
      Print.error = () => { errorCount++; };
      try {
        await assert.rejects(
          () => generateTypesFile({ projectRoot: tmpRoot, outputPath: outputFile }),
          /Cannot read components registry/
        );
      } finally {
        Print.warning = origWarning;
        Print.error = origError;
      }
      assert.equal(warningCount, 0);
      assert.equal(errorCount, 0);
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });

  test('component with Babel parse error triggers Print.warning exactly once', async () => {
    const tmpRoot = await createTestProject();
    const srcDir = path.join(tmpRoot, 'src');
    try {
      const visualDir = path.join(srcDir, 'Components', 'Visual', 'Broken');
      fs.mkdirSync(visualDir, { recursive: true });
      fs.writeFileSync(path.join(visualDir, 'Broken.js'), 'export default class Broken extends HTMLElement {', 'utf8');
      const goodDir = path.join(srcDir, 'Components', 'Visual', 'Good');
      fs.mkdirSync(goodDir, { recursive: true });
      fs.writeFileSync(
        path.join(goodDir, 'Good.js'),
        'export default class Good extends HTMLElement { static props = { x: { type: "string" } }; }',
        'utf8'
      );
      fs.writeFileSync(
        path.join(srcDir, 'Components', 'components.js'),
        'const components = {"Good": "Visual", "Broken": "Visual"};\nexport default components;\n',
        'utf8'
      );
      const outputFile = path.join(srcDir, 'slice-build.generated.d.ts');
      let warningCount = 0;
      const origWarning = Print.warning;
      Print.warning = () => { warningCount++; };
      try {
        await generateTypesFile({ projectRoot: tmpRoot, outputPath: outputFile });
      } finally {
        Print.warning = origWarning;
      }
      assert.equal(warningCount, 1);
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });

  test('missing component file triggers Print.info once for skipped count', async () => {
    const tmpRoot = await createTestProject();
    const srcDir = path.join(tmpRoot, 'src');
    try {
      fs.writeFileSync(
        path.join(srcDir, 'Components', 'components.js'),
        'const components = {"Existing": "Visual", "Missing": "Visual"};\nexport default components;\n',
        'utf8'
      );
      const existingDir = path.join(srcDir, 'Components', 'Visual', 'Existing');
      fs.mkdirSync(existingDir, { recursive: true });
      fs.writeFileSync(
        path.join(existingDir, 'Existing.js'),
        'export default class Existing extends HTMLElement { static props = { x: { type: "string" } }; }',
        'utf8'
      );
      const outputFile = path.join(srcDir, 'slice-build.generated.d.ts');
      let infoCount = 0;
      const origInfo = Print.info;
      Print.info = () => { infoCount++; };
      try {
        await generateTypesFile({ projectRoot: tmpRoot, outputPath: outputFile });
      } finally {
        Print.info = origInfo;
      }
      assert.equal(infoCount, 1);
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });
});

describe('ensureEditorConfigForTypes — config breakage', () => {
  test('jsconfig with compilerOptions: null fills defaults', async () => {
    const tmpRoot = await createTestProject();
    const outputFile = path.join(tmpRoot, 'src', 'slice-build.generated.d.ts');
    const jsconfigPath = path.join(tmpRoot, 'jsconfig.json');
    try {
      fs.writeFileSync(outputFile, 'export {};\n', 'utf8');
      fs.writeFileSync(jsconfigPath, JSON.stringify({ compilerOptions: null }), 'utf8');
      const result = await ensureEditorConfigForTypes({ projectRoot: tmpRoot, outputPath: outputFile });
      assert.equal(result.mode, 'updated_jsconfig');
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });

  test('jsconfig with non-array include gets rebuilt', async () => {
    const tmpRoot = await createTestProject();
    const outputFile = path.join(tmpRoot, 'src', 'slice-build.generated.d.ts');
    const jsconfigPath = path.join(tmpRoot, 'jsconfig.json');
    try {
      fs.writeFileSync(outputFile, 'export {};\n', 'utf8');
      fs.writeFileSync(
        jsconfigPath,
        JSON.stringify({ include: 'src/**/*.js', compilerOptions: {} }),
        'utf8'
      );
      const result = await ensureEditorConfigForTypes({ projectRoot: tmpRoot, outputPath: outputFile });
      assert.match(result.mode, /created_jsconfig|updated_jsconfig|reset_jsconfig/);
      const parsed = JSON.parse(fs.readFileSync(jsconfigPath, 'utf8'));
      assert.ok(Array.isArray(parsed.include));
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });

  test('outputPath outside project root still works', async () => {
    const tmpRoot = await createTestProject();
    const outsideFile = path.join(tmpRoot, '..', 'outside.d.ts');
    try {
      fs.writeFileSync(outsideFile, 'export {};\n', 'utf8');
      const result = await ensureEditorConfigForTypes({
        projectRoot: tmpRoot,
        outputPath: outsideFile
      });
      assert.match(result.mode, /created_jsconfig|updated_jsconfig/);
    } finally {
      fs.unlinkSync(outsideFile);
      await cleanupTestProject(tmpRoot);
    }
  });

  test('both tsconfig.json and jsconfig.json exist — tsconfig takes priority', async () => {
    const tmpRoot = await createTestProject();
    const outputFile = path.join(tmpRoot, 'src', 'slice-build.generated.d.ts');
    const jsconfigPath = path.join(tmpRoot, 'jsconfig.json');
    try {
      fs.writeFileSync(outputFile, 'export {};\n', 'utf8');
      fs.writeFileSync(path.join(tmpRoot, 'tsconfig.json'), '{}', 'utf8');
      fs.writeFileSync(jsconfigPath, JSON.stringify({ include: [], compilerOptions: {} }), 'utf8');
      const result = await ensureEditorConfigForTypes({ projectRoot: tmpRoot, outputPath: outputFile });
      assert.equal(result.mode, 'tsconfig_exists');
    } finally {
      await cleanupTestProject(tmpRoot);
    }
  });
});
