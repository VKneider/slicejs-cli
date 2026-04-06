import fs from 'node:fs';
import path from 'node:path';

function getParentDirectory(dir) {
  const parent = path.dirname(dir);
  return parent === dir ? null : parent;
}

export function isLocalDelegationDisabled(env = process.env) {
  return env.SLICE_NO_LOCAL_DELEGATION === '1';
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
