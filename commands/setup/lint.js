// slice setup lint — add linting to a project that already exists.
//
// `slice init` does not decide this for you: ESLint is a choice (some projects
// use another linter, some none), and init only runs once. This command is
// idempotent, never overwrites an eslint config you wrote, and works on any
// Slice project.

import fs from 'fs-extra';
import path from 'node:path';
import { execSync } from 'node:child_process';
import Print from '../Print.js';
import { installCommand, resolvePackageManager } from '../utils/PackageManager.js';

export const ESLINT_CONFIG_FILE = 'eslint.config.js';

/** The config written when the project has none. */
export const eslintConfigContent = `import slice from 'slicejs-cli/eslint-config.js';

export default [...slice];
`;

const LINT_SCRIPTS = {
  lint: 'slice lint',
  'lint:fix': 'slice lint --fix'
};

const TYPE_SCRIPTS = {
  typecheck: 'slice typecheck'
};

const hasLocalPackage = (projectRoot, name) => fs.pathExistsSync(
  path.join(projectRoot, 'node_modules', name, 'package.json')
);

/**
 * Inspects, installs and writes. `runInstall` is injectable so the tests do not
 * touch the network.
 */
export async function setupLint({ projectRoot, dryRun = false, withTypes = false, runInstall = null }) {
  const packagePath = path.join(projectRoot, 'package.json');
  if (!(await fs.pathExists(packagePath))) {
    return {
      ok: false,
      error: 'No package.json here. Run this from the root of a Slice project.',
      actions: []
    };
  }

  const pkg = await fs.readJson(packagePath);
  const packageManager = resolvePackageManager(projectRoot).name;
  const actions = [];

  // 1. The tools the config and the command need, as devDependencies.
  const required = withTypes ? ['eslint', 'slicejs-cli', 'typescript'] : ['eslint', 'slicejs-cli'];
  const missing = required.filter((name) => !hasLocalPackage(projectRoot, name));
  if (missing.length > 0) {
    const command = installCommand(packageManager, missing.join(' '), { dev: true });
    actions.push({ kind: 'install', detail: command });
    if (!dryRun) {
      if (runInstall) await runInstall(command);
      else execSync(command, { cwd: projectRoot, stdio: 'inherit' });
    }
  }

  // 2. The config, only when there is none. A project may have its own, and it
  //    may use another linter entirely: never overwrite it.
  const configPath = path.join(projectRoot, ESLINT_CONFIG_FILE);
  const hasConfig = await fs.pathExists(configPath);
  if (!hasConfig) {
    actions.push({ kind: 'write', detail: ESLINT_CONFIG_FILE });
    if (!dryRun) await fs.writeFile(configPath, eslintConfigContent, 'utf8');
  } else {
    actions.push({ kind: 'keep', detail: `${ESLINT_CONFIG_FILE} already exists` });
  }

  // 3. Scripts, without clobbering what the project already wires.
  const scripts = { ...(pkg.scripts || {}) };
  const scriptChanges = [];
  const wanted = withTypes ? { ...LINT_SCRIPTS, ...TYPE_SCRIPTS } : LINT_SCRIPTS;
  for (const [name, command] of Object.entries(wanted)) {
    if (scripts[name] === undefined) {
      scripts[name] = command;
      scriptChanges.push({ name, command });
    } else if (scripts[name] !== command) {
      actions.push({ kind: 'keep', detail: `script "${name}" already set to "${scripts[name]}"` });
    }
  }

  if (scriptChanges.length > 0) {
    actions.push({ kind: 'scripts', detail: scriptChanges.map((change) => `${change.name}: ${change.command}`).join(', ') });
    if (!dryRun) {
      await fs.writeJson(packagePath, { ...pkg, scripts }, { spaces: 2 });
    }
  }

  return { ok: true, actions, dryRun };
}

export default async function setupLintCommand(options = {}, projectRoot) {
  const dryRun = Boolean(options.dryRun);

  let result;
  try {
    result = await setupLint({ projectRoot, dryRun, withTypes: Boolean(options.withTypes) });
  } catch (error) {
    Print.error('slice setup lint:', error.message);
    process.exitCode = 1;
    return false;
  }

  if (!result.ok) {
    Print.error(result.error);
    process.exitCode = 1;
    return false;
  }

  for (const action of result.actions) {
    if (action.kind === 'install') Print.info(`Install devDependencies: ${action.detail}`);
    else if (action.kind === 'write') Print.success(`Created ${action.detail}`);
    else if (action.kind === 'scripts') Print.success(`Added scripts: ${action.detail}`);
    else Print.info(action.detail);
  }

  if (dryRun) {
    Print.info('Dry run: nothing was written.');
    return true;
  }

  Print.newLine();
  Print.success('Linting is set up. Run "slice lint" (or "npm run lint").');
  return true;
}
