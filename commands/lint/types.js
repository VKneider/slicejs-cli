// Keeping the generated declarations in sync is part of "lint" from the user's
// point of view: one command that verifies the project, not two. ESLint itself
// does not type-check (JS, no tsconfig); what this phase guarantees is that the
// `.d.ts` the editor reads still matches the props on disk.

import fs from 'fs-extra';
import path from 'node:path';
import { generateTypesFile } from '../types/types.js';

export const DEFAULT_TYPES_OUTPUT = path.join('src', 'slice-build.generated.d.ts');

/** A project opts into types by having the file or a script that generates it. */
export async function usesGeneratedTypes(projectRoot) {
  const packagePath = path.join(projectRoot, 'package.json');
  let scripts = {};
  try {
    scripts = JSON.parse(await fs.readFile(packagePath, 'utf8')).scripts || {};
  } catch { /* no package.json: nothing to configure */ }

  if (Object.values(scripts).some((command) => /types\s+generate/.test(String(command)))) return true;
  return fs.pathExists(path.join(projectRoot, DEFAULT_TYPES_OUTPUT));
}

/**
 * Regenerate the declarations in place.
 * @returns {Promise<{status: 'created'|'updated'|'unchanged'|'skipped', file?: string, components?: number}>}
 */
export async function refreshGeneratedTypes(projectRoot, output = DEFAULT_TYPES_OUTPUT) {
  if (!await usesGeneratedTypes(projectRoot)) {
    return { status: 'skipped' };
  }

  // Types come from the component registry. A repo with a leftover `slice:types`
  // script but no Slice app (the CLI itself, for instance) has nothing to type.
  if (!await fs.pathExists(path.join(projectRoot, 'src', 'Components', 'components.js'))) {
    return { status: 'skipped' };
  }

  const file = path.isAbsolute(output) ? output : path.join(projectRoot, output);
  const before = await fs.readFile(file, 'utf8').catch(() => null);

  const result = await generateTypesFile({ projectRoot, outputPath: file });
  const after = await fs.readFile(file, 'utf8').catch(() => null);

  return {
    status: before === null ? 'created' : before === after ? 'unchanged' : 'updated',
    file,
    components: result.componentsProcessed
  };
}
