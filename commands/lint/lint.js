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

export default async function lintCommand(options = {}, projectRoot) {
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
