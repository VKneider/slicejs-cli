import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestProject, cleanupTestProject } from './helpers/setup.js';

import {
  ensureEditorConfigForTypes,
  ensureNoCheckInPublicVendorFiles,
  extractStaticPropsFromSource,
  generateDeclarationContent,
  generateTypesFile
} from '../commands/types/types.js';

test('extractStaticPropsFromSource reads static props definitions', () => {
  const source = `
    export default class Button extends HTMLElement {
      static props = {
        value: { type: 'string', default: 'Button', allowedValues: ['Button', 'Submit'] },
        disabled: { type: 'boolean', default: false },
        size: { type: 'number', allowedValues: [12, 16, 20] },
        options: {
          type: 'object',
          schema: {
            theme: {
              type: 'object',
              schema: {
                mode: { type: 'string', allowedValues: ['light', 'dark'] }
              }
            }
          }
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            schema: {
              id: { type: 'string', required: true },
              enabled: { type: 'boolean', default: true }
            }
          }
        },
        onClickCallback: { type: 'function', required: true }
      };
    }
  `;

  const result = extractStaticPropsFromSource(source);

  assert.deepEqual(result, {
    value: { type: 'string', required: false, allowedValues: ['Button', 'Submit'] },
    disabled: { type: 'boolean', required: false },
    size: { type: 'number', required: false, allowedValues: [12, 16, 20] },
    options: {
      type: 'object',
      required: false,
      schema: {
        theme: {
          type: 'object',
          required: false,
          schema: {
            mode: {
              type: 'string',
              required: false,
              allowedValues: ['light', 'dark']
            }
          }
        }
      }
    },
    steps: {
      type: 'array',
      required: false,
      items: {
        type: 'object',
        required: false,
        schema: {
          id: { type: 'string', required: true },
          enabled: { type: 'boolean', required: false }
        }
      }
    },
    onClickCallback: { type: 'function', required: true }
  });
});

test('generateDeclarationContent creates build typing map', () => {
  const content = generateDeclarationContent({
    Button: {
      value: { type: 'string', required: false, allowedValues: ['primary', 'secondary', 'danger'] },
      size: { type: 'number', required: false, allowedValues: [12, 16] },
      disabled: { type: 'boolean', required: false },
      status: { type: 'string', required: false, allowedValues: ['ok', 1] },
      options: {
        type: 'object',
        required: false,
        schema: {
          mode: { type: 'string', required: false, allowedValues: ['light', 'dark'] }
        }
      },
      steps: {
        type: 'array',
        required: false,
        items: {
          type: 'object',
          required: false,
          schema: {
            id: { type: 'string', required: true }
          }
        }
      }
    },
    FetchManager: {
      baseUrl: { type: 'string', required: true }
    }
  });

  assert.match(content, /export interface ButtonProps/);
  assert.match(content, /\[key: string\]: unknown;/);
  assert.match(content, /value\?: 'primary' \| 'secondary' \| 'danger';/);
  assert.match(content, /size\?: 12 \| 16;/);
  assert.match(content, /disabled\?: boolean;/);
  assert.match(content, /status\?: string;/);
  assert.match(content, /export interface FetchManagerProps/);
  assert.match(content, /baseUrl: string;/);
  assert.match(content, /export interface SliceComponentPropsMap/);
  assert.match(content, /Button: ButtonProps;/);
  assert.match(content, /FetchManager: FetchManagerProps;/);
  assert.match(content, /options\?: \{/);
  assert.match(content, /mode\?: 'light' \| 'dark';/);
  assert.match(content, /steps\?: \{/);
  assert.match(content, /id: string;/);
  assert.match(content, /}\[\];/);
  assert.match(content, /declare module 'slicejs-web-framework'/);
  assert.match(content, /interface SliceApi \{/);
  assert.match(content, /export type SliceDynamicElement = HTMLElement & Record<string, any>;/);
  assert.match(content, /build<K extends SliceComponentName>/);
  assert.match(content, /getComponent<T extends SliceDynamicElement = SliceDynamicElement>\(/);
  assert.match(content, /componentSliceId: string/);
  assert.match(content, /\): T \| undefined;/);
  assert.match(content, /interface Element \{/);
  assert.match(content, /querySelector<E extends Element = HTMLElement>\(selectors: string\): E \| null;/);
  assert.match(content, /querySelectorAll<E extends Element = HTMLElement>\(selectors: string\): NodeListOf<E>;/);
  assert.match(content, /interface HTMLElement \{/);
  assert.match(content, /\[key: string\]: any;/);
  assert.match(content, /const slice: SliceBuildApi & Record<string, any>;/);
  assert.match(content, /interface EventTarget \{/);
  assert.match(content, /interface Event \{/);
  assert.match(content, /detail: any;/);
  assert.match(content, /currentTarget: any;/);
});

test('generateTypesFile creates declaration file from local components', async () => {
  const tmpRoot = await createTestProject();
  const srcDir = path.join(tmpRoot, 'src');

  try {
    const visualDir = path.join(srcDir, 'Components', 'Visual', 'Button');
    const noStaticDir = path.join(srcDir, 'Components', 'Visual', 'Tabs');
    const serviceDir = path.join(srcDir, 'Components', 'Service', 'FetchManager');
    const outputFile = path.join(srcDir, 'slice-build.generated.d.ts');

    fs.mkdirSync(noStaticDir, { recursive: true });

    fs.writeFileSync(
      path.join(visualDir, 'Button.js'),
      `
      export default class Button extends HTMLElement {
        static props = {
          value: { type: 'string', default: 'Button', allowedValues: ['Button', 'Submit'] },
          size: { type: 'number', allowedValues: [12, 16] },
          disabled: { type: 'boolean', default: false }
        };
      }
      `,
      'utf8'
    );

    fs.writeFileSync(
      path.join(noStaticDir, 'Tabs.js'),
      `
      export default class Tabs extends HTMLElement {
        constructor() {
          super();
        }
      }
      `,
      'utf8'
    );

    fs.writeFileSync(
      path.join(serviceDir, 'FetchManager.js'),
      `
      export default class FetchManager extends HTMLElement {
        static props = {
          baseUrl: { type: 'string', required: true }
        };
      }
      `,
      'utf8'
    );

    fs.writeFileSync(
      path.join(srcDir, 'Components', 'components.js'),
      'const components = {"Button": "Visual", "Tabs": "Visual", "FetchManager": "Service"};\n\nexport default components;\n',
      'utf8'
    );

    const result = await generateTypesFile({
      projectRoot: tmpRoot,
      outputPath: outputFile
    });

    assert.equal(result.componentsProcessed, 3);
    assert.equal(fs.existsSync(result.outputPath), true);

    const declaration = fs.readFileSync(result.outputPath, 'utf8');
    assert.match(declaration, /export interface ButtonProps/);
    assert.match(declaration, /value\?: 'Button' \| 'Submit';/);
    assert.match(declaration, /size\?: 12 \| 16;/);
    assert.match(declaration, /export interface TabsProps/);
    assert.match(declaration, /\[key: string\]: unknown;/);
    assert.match(declaration, /export interface FetchManagerProps/);
    assert.match(declaration, /Tabs: TabsProps;/);
    assert.match(declaration, /build<K extends SliceComponentName>/);
  } finally {
    await cleanupTestProject(tmpRoot);
  }
});

test('ensureEditorConfigForTypes creates jsconfig when missing', async () => {
  const tmpRoot = await createTestProject();
  const outputFile = path.join(tmpRoot, 'src', 'slice-build.generated.d.ts');

  try {
    fs.writeFileSync(outputFile, 'export {};\n', 'utf8');

    const result = await ensureEditorConfigForTypes({
      projectRoot: tmpRoot,
      outputPath: outputFile
    });

    assert.equal(result.mode, 'created_jsconfig');

    const jsconfigPath = path.join(tmpRoot, 'jsconfig.json');
    assert.equal(fs.existsSync(jsconfigPath), true);

    const jsconfig = JSON.parse(fs.readFileSync(jsconfigPath, 'utf8'));
    assert.equal(Array.isArray(jsconfig.include), true);
    assert.equal(jsconfig.include.includes('src/Components/**/*.js'), true);
    assert.equal(jsconfig.include.includes('src/**/*.d.ts'), true);
    assert.equal(jsconfig.include.includes('api/**/*.js'), false);
    assert.equal(jsconfig.include.includes('tests/**/*.js'), false);
    assert.equal(jsconfig.include.includes('src/**/*.js'), false);
    assert.equal(jsconfig.compilerOptions.checkJs, true);
    assert.equal(jsconfig.compilerOptions.strictNullChecks, false);
    assert.equal(jsconfig.compilerOptions.noImplicitAny, false);
    assert.equal(jsconfig.compilerOptions.strict, false);
    assert.equal(Array.isArray(jsconfig.exclude), true);
    assert.equal(jsconfig.exclude.includes('src/libs/**'), true);
    assert.equal(jsconfig.exclude.includes('tests/**'), true);
  } finally {
    await cleanupTestProject(tmpRoot);
  }
});

test('types functions use PathHelper with explicit projectRoot', async () => {
  const tmpRoot = await createTestProject({ visualComponents: ['Button'] });
  const srcDir = path.join(tmpRoot, 'src');
  const outputFile = path.join(srcDir, 'slice-build.generated.d.ts');

  try {
    const visualDir = path.join(srcDir, 'Components', 'Visual', 'Button');
    fs.writeFileSync(
      path.join(visualDir, 'Button.js'),
      `export default class Button extends HTMLElement {
        static props = { value: { type: 'string' } };
      }`,
      'utf8'
    );

    const result = await generateTypesFile({
      projectRoot: tmpRoot,
      outputPath: outputFile
    });

    assert.equal(result.componentsProcessed, 1);
    assert.equal(fs.existsSync(result.outputPath), true);

    const declaration = fs.readFileSync(result.outputPath, 'utf8');
    assert.match(declaration, /export interface ButtonProps/);
    assert.match(declaration, /build<K extends SliceComponentName>/);
  } finally {
    await cleanupTestProject(tmpRoot);
  }
});

test('ensureEditorConfigForTypes augments existing jsconfig include list', async () => {
  const tmpRoot = await createTestProject();
  const outputFile = path.join(tmpRoot, 'src', 'slice-build.generated.d.ts');
  const jsconfigPath = path.join(tmpRoot, 'jsconfig.json');

  try {
    fs.writeFileSync(outputFile, 'export {};\n', 'utf8');
    fs.writeFileSync(
      jsconfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            allowJs: true
          },
          include: ['src/Components/**/*.js', 'src/**/*.js', 'api/**/*.js', 'tests/**/*.js']
        },
        null,
        2
      ),
      'utf8'
    );

    const result = await ensureEditorConfigForTypes({
      projectRoot: tmpRoot,
      outputPath: outputFile
    });

    assert.equal(result.mode, 'updated_jsconfig');

    const jsconfig = JSON.parse(fs.readFileSync(jsconfigPath, 'utf8'));
    assert.equal(jsconfig.include.includes('src/Components/**/*.js'), true);
    assert.equal(jsconfig.include.includes('src/**/*.d.ts'), true);
    assert.equal(jsconfig.include.includes('src/**/*.js'), false);
    assert.equal(jsconfig.include.includes('api/**/*.js'), false);
    assert.equal(jsconfig.include.includes('tests/**/*.js'), false);
    assert.equal(jsconfig.compilerOptions.allowJs, true);
    assert.equal(jsconfig.compilerOptions.checkJs, true);
    assert.equal(jsconfig.compilerOptions.noImplicitAny, false);
    assert.equal(jsconfig.compilerOptions.strictNullChecks, false);
    assert.equal(jsconfig.compilerOptions.strict, false);
    assert.equal(Array.isArray(jsconfig.exclude), true);
    assert.equal(jsconfig.exclude.includes('src/libs/**'), true);
    assert.equal(jsconfig.exclude.includes('tests/**'), true);
  } finally {
    await cleanupTestProject(tmpRoot);
  }
});
