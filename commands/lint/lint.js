// slice lint — the project's own ESLint, with the shared config available as
// `slicejs-cli/eslint-config.js`.
//
// The CLI does not bundle ESLint: the project declares it, like any other dev
// tool, and this command is a thin wrapper so `slice lint` works in scripts and
// CI without remembering the binary name.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import Print from '../Print.js';
import { refreshGeneratedTypes, reportTypesRefresh } from './types.js';

/** Path to the project's eslint binary, or null when it is not installed. */
export function resolveEslint(projectRoot) {
  try {
    const require = createRequire(path.join(projectRoot, 'package.json'));
    const pkgPath = require.resolve('eslint/package.json');
    return path.join(path.dirname(pkgPath), 'bin', 'eslint.js');
  } catch {
    return null;
  }
}

/** Refresh declarations unless the caller opted out with `--no-types`. */
export async function runTypeRefresh(projectRoot, options = {}) {
  if (options.types === false) return null;
  return refreshGeneratedTypes(projectRoot);
}

export default async function lintCommand(options = {}, projectRoot) {
  // One command verifies the project: refresh the declarations the editor reads
  // before running ESLint, so they can never go stale. --no-types opts out.
  if (options.types !== false) {
    try {
      const types = await runTypeRefresh(projectRoot, options);
      if (types) reportTypesRefresh(types, projectRoot);
    } catch (error) {
      Print.error('Could not refresh the generated types:', error.message);
      process.exitCode = 1;
    }
  }

  const eslint = resolveEslint(projectRoot);

  if (!eslint) {
    Print.error('ESLint is not installed in this project.');
    Print.info('Install it: npm i -D eslint   (or "pnpm add -D eslint")');
    Print.info('Then add eslint.config.js: import slice from "slicejs-cli/eslint-config.js"; export default [...slice];');
    process.exitCode = 1;
    return false;
  }

  const targets = options.paths?.length ? options.paths : ['.'];
  const args = [eslint, ...(options.fix ? ['--fix'] : []), ...targets];

  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env
  });

  if (result.error) {
    Print.error('Could not run ESLint:', result.error.message);
    process.exitCode = 1;
    return false;
  }

  if (result.status !== 0) {
    process.exitCode = result.status || 1;
    return false;
  }

  return true;
}
