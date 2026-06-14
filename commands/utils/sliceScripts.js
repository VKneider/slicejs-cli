// commands/utils/sliceScripts.js
//
// Single source of truth for the slice:* package scripts configured by the CLI.
// Used by the `slice postinstall` command in
// client.js, and `slice init` — so the three can never drift apart (they did:
// client.js was missing slice:types, and none of them had slice:build).

import fs from 'fs';

/**
 * Reads a project's package.json and verifies it contains all SLICE_SCRIPTS.
 * Returns { missing: string[] } where each entry is the script name not found.
 */
export function verifySliceScriptsInPackageJson(pkgPath) {
  const missing = [];
  try {
    if (!fs.existsSync(pkgPath)) {
      return { missing: Object.keys(SLICE_SCRIPTS) };
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const scripts = pkg.scripts || {};
    for (const script of Object.keys(SLICE_SCRIPTS)) {
      if (!scripts[script]) {
        missing.push(script);
      }
    }
  } catch {
    return { missing: Object.keys(SLICE_SCRIPTS) };
  }
  return { missing };
}

export const SLICE_SCRIPTS = {
  'slice:init': 'node ./node_modules/slicejs-cli/client.js init',
  'slice:dev': 'node ./node_modules/slicejs-cli/client.js dev',
  'slice:build': 'node ./node_modules/slicejs-cli/client.js build',
  'slice:start': 'node ./node_modules/slicejs-cli/client.js start',
  'slice:create': 'node ./node_modules/slicejs-cli/client.js component create',
  'slice:list': 'node ./node_modules/slicejs-cli/client.js component list',
  'slice:delete': 'node ./node_modules/slicejs-cli/client.js component delete',
  'slice:get': 'node ./node_modules/slicejs-cli/client.js get',
  'slice:browse': 'node ./node_modules/slicejs-cli/client.js browse',
  'slice:sync': 'node ./node_modules/slicejs-cli/client.js sync',
  'slice:doctor': 'node ./node_modules/slicejs-cli/client.js doctor',
  'slice:version': 'node ./node_modules/slicejs-cli/client.js version',
  'slice:help': 'node ./node_modules/slicejs-cli/client.js --help',
  'slice:types': 'node ./node_modules/slicejs-cli/client.js types generate',
};
