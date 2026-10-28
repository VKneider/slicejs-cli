// Keeping the generated declarations in sync is part of "lint" from the user's
// point of view: one command that verifies the project, not two. ESLint itself
// does not type-check (JS, no tsconfig); what this phase guarantees is that the
// `.d.ts` the editor reads still matches the props on disk.

import fs from 'fs-extra';
import path from 'node:path';
import Print from '../Print.js';
import { generateTypesFile, ensureEditorConfigForTypes } from '../types/types.js';

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

  // Without this the declarations exist but `slice typecheck` has nothing to
  // point tsc at (its error message tells you to run types generate).
  const jsconfig = await ensureEditorConfigForTypes({ projectRoot, outputPath: file });

  return {
    status: before === null ? 'created' : before === after ? 'unchanged' : 'updated',
    file,
    components: result.componentsProcessed,
    jsconfig: jsconfig.mode,
    jsconfigReason: jsconfig.reason,
    jsconfigError: jsconfig.errorMessage
  };
}

/** Explain what the refresh did, including the jsconfig decisions it took. */
export function reportTypesRefresh(types, projectRoot) {
  if (types.status === 'created') Print.info(`Generated types: ${path.relative(projectRoot, types.file)}`);
  else if (types.status === 'updated') Print.info(`Updated generated types: ${path.relative(projectRoot, types.file)}`);
  else if (types.status === 'skipped') Print.info('Types: not configured in this project, skipped.');

  switch (types.jsconfig) {
    case 'created_jsconfig':
      Print.info('Created jsconfig.json for type-checking.');
      break;
    case 'updated_jsconfig':
      Print.info('Updated jsconfig.json for type-checking.');
      break;
    case 'reset_jsconfig':
      Print.warning(`Rewrote jsconfig.json (${types.jsconfigReason || 'unreadable or invalid'}).`);
      break;
    case 'tsconfig_exists':
      Print.info('Using tsconfig.json; the generated declarations are not added to it.');
      break;
    case 'editor_config_error':
      Print.warning('Could not update jsconfig.json:', types.jsconfigError || 'unknown error');
      break;
    default:
      break;
  }
}
