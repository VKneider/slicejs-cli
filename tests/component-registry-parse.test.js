import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestProject, cleanupTestProject, withTestProject } from './helpers/setup.js';

test('generateTypesFile parses JSON from components.js (no eval)', async () => {
  const tmpRoot = await createTestProject({ visualComponents: ['Button'] });

  try {
    const srcDir = path.join(tmpRoot, 'src');
    const { generateTypesFile } = await import('../commands/types/types.js');
    const result = await generateTypesFile({
      projectRoot: tmpRoot,
      outputPath: path.join(srcDir, 'slice-build.generated.d.ts')
    });

    assert.ok(result.componentsProcessed > 0);
    assert.equal(fs.existsSync(result.outputPath), true);

    const declaration = fs.readFileSync(result.outputPath, 'utf8');
    assert.match(declaration, /export interface ButtonProps/);
  } finally {
    await cleanupTestProject(tmpRoot);
  }
});

test('Validations componentExists with JSON.parse (no eval)', async () => {
  await withTestProject(async (tmpDir) => {
    const validations = (await import('../commands/Validations.js')).default;
    assert.equal(validations.componentExists('Button'), true);
    assert.equal(validations.componentExists('NonExistent'), false);
  });
});
