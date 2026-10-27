import fs from 'node:fs';
import path from 'node:path';

function getParentDirectory(dir) {
  const parent = path.dirname(dir);
  return parent === dir ? null : parent;
}

export function isLocalDelegationDisabled(env = process.env) {
  return env.SLICE_NO_LOCAL_DELEGATION === '1';
}

/**
 * The first positional token of the invocation (`init`, `build`, …), skipping
 * flags. `null` when the argv carries no command (`--version`, `--help`).
 */
export function commandNameFromArgv(argv = process.argv.slice(2)) {
  const command = argv.find((arg) => typeof arg === 'string' && !arg.startsWith('-'));
  return command || null;
}

/**
 * Commands that must run on the CLI the user actually invoked.
 *
 * `init` creates a project somewhere else, so resolving "which CLI" by walking
 * up from the current folder is meaningless and harmful: a subdirectory of any
 * existing Slice project would run that project's (possibly old) CLI, and a
 * `pnpm dlx slicejs-cli@latest init` would silently use the local version
 * instead of the one the user asked for. Everything else may delegate: there,
 * matching the project's pinned version is exactly the point.
 */
const NON_DELEGATING_COMMANDS = new Set(['init']);

export function isNonDelegatingCommand(argv = process.argv.slice(2)) {
  return NON_DELEGATING_COMMANDS.has(commandNameFromArgv(argv));
}

export function findNearestLocalCliEntry(startDirectory, resolveCandidate) {
  if (!startDirectory || typeof resolveCandidate !== 'function') {
    return null;
  }

  let current = path.resolve(startDirectory);
  while (current) {
    const candidate = resolveCandidate(current);
    if (candidate) {
      return candidate;
    }
    current = getParentDirectory(current);
  }

  return null;
}

export function resolveLocalCliCandidate(directory) {
  const candidate = path.join(directory, 'node_modules', 'slicejs-cli', 'client.js');

  try {
    const stats = fs.statSync(candidate);
    return stats.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

export function shouldDelegateToLocalCli(currentEntryPath, localEntryPath) {
  if (!localEntryPath) {
    return false;
  }

  try {
    const currentReal = fs.realpathSync(currentEntryPath);
    const localReal = fs.realpathSync(localEntryPath);
    return currentReal !== localReal;
  } catch {
    return path.resolve(currentEntryPath) !== path.resolve(localEntryPath);
  }
}
