// commands/utils/sliceScripts.js
//
// Single source of truth for the slice:* package scripts configured by the CLI.
// Used by post.js (the postinstall hook), the `slice postinstall` command in
// client.js, and `slice init` — so the three can never drift apart (they did:
// client.js was missing slice:types, and none of them had slice:build).
export const SLICE_SCRIPTS = {
  'slice:init': 'slice init',
  'slice:dev': 'slice dev',
  'slice:build': 'slice build',
  'slice:start': 'slice start',
  'slice:create': 'slice component create',
  'slice:list': 'slice component list',
  'slice:delete': 'slice component delete',
  'slice:get': 'slice get',
  'slice:browse': 'slice browse',
  'slice:sync': 'slice sync',
  'slice:version': 'slice version',
  'slice:update': 'slice update',
  'slice:types': 'slice types generate',
};
