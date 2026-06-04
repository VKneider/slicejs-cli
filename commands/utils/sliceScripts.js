// commands/utils/sliceScripts.js
//
// Single source of truth for the slice:* package scripts configured by the CLI.
// Used by post.js (the postinstall hook), the `slice postinstall` command in
// client.js, and `slice init` — so the three can never drift apart (they did:
// client.js was missing slice:types, and none of them had slice:build).
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
  'slice:update': 'node ./node_modules/slicejs-cli/client.js update',
  'slice:types': 'node ./node_modules/slicejs-cli/client.js types generate',
};
