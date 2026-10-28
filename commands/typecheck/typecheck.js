// slice typecheck — run the project's TypeScript over the JS, using the jsconfig
// that `slice types generate` maintains (`allowJs` + `checkJs`).
//
// ESLint does not type-check (no tsconfig, no type information). This is the
// compiler step: it compares the code against the generated prop and event
// declarations. TypeScript is the project's devDependency, like ESLint.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import Print from '../Print.js';
import { refreshGeneratedTypes } from '../lint/types.js';

/** The project's own tsc, or null when TypeScript is not installed. */
export function resolveTypeScript(projectRoot) {
  try {
    const require = createRequire(path.join(projectRoot, 'package.json'));
    const pkgPath = require.resolve('typescript/package.json');
    return path.join(path.dirname(pkgPath), 'bin', 'tsc');
  } catch {
    return null;
  }
}

/** The config to type-check with: explicit, jsconfig.json, or tsconfig.json. */
export function resolveProjectConfig(projectRoot, explicit = null) {
  const candidates = explicit ? [explicit] : ['jsconfig.json', 'tsconfig.json'];
  for (const candidate of candidates) {
    const file = path.isAbsolute(candidate) ? candidate : path.join(projectRoot, candidate);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export default async function typecheckCommand(options = {}, projectRoot) {
  // Check the declarations that exist now, not the ones from before the last
  // `slice get`: the registry changed, so the .d.ts has to follow.
  if (options.types !== false) {
    try {
      const types = await refreshGeneratedTypes(projectRoot);
      if (types.status === 'created') Print.info(`Generated types: ${path.relative(projectRoot, types.file)}`);
      else if (types.status === 'updated') Print.info(`Refreshed generated types: ${path.relative(projectRoot, types.file)}`);
    } catch (error) {
      Print.warning('Could not refresh the generated types:', error.message);
    }
  }

  const tsc = resolveTypeScript(projectRoot);
  if (!tsc) {
    Print.error('TypeScript is not installed in this project.');
    Print.info('Install it: npm i -D typescript   (or "pnpm add -D typescript")');
    process.exitCode = 1;
    return false;
  }

  const config = resolveProjectConfig(projectRoot, options.project);
  if (!config) {
    Print.error('No jsconfig.json or tsconfig.json here: nothing to type-check with.');
    Print.info('Run "slice types generate" to create the jsconfig that includes the generated declarations.');
    process.exitCode = 1;
    return false;
  }

  const result = spawnSync(process.execPath, [tsc, '--noEmit', '-p', config], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env
  });

  if (result.error) {
    Print.error('Could not run tsc:', result.error.message);
    process.exitCode = 1;
    return false;
  }

  if (result.status !== 0) {
    process.exitCode = result.status || 1;
    return false;
  }

  return true;
}
