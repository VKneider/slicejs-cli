import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  findNearestLocalCliEntry,
  shouldDelegateToLocalCli,
  isLocalDelegationDisabled
} from '../commands/utils/LocalCliDelegation.js';

test('isLocalDelegationDisabled returns true when env flag is set', () => {
  const env = { SLICE_NO_LOCAL_DELEGATION: '1' };
  assert.equal(isLocalDelegationDisabled(env), true);
});

test('isLocalDelegationDisabled returns false when env flag is missing', () => {
  const env = {};
  assert.equal(isLocalDelegationDisabled(env), false);
});

test('shouldDelegateToLocalCli is false when candidate is null', () => {
  assert.equal(shouldDelegateToLocalCli('/tmp/current/client.js', null), false);
});

test('shouldDelegateToLocalCli is false when candidate realpath equals current realpath', () => {
  const same = '/tmp/current/client.js';
  assert.equal(shouldDelegateToLocalCli(same, same), false);
});

test('shouldDelegateToLocalCli is true when candidate differs from current', () => {
  const current = '/tmp/global/client.js';
  const local = '/tmp/project/node_modules/slicejs-cli/client.js';
  assert.equal(shouldDelegateToLocalCli(current, local), true);
});

test('findNearestLocalCliEntry returns null when no candidate resolver hits', () => {
  const cwd = path.join('/tmp', 'slice-nonexistent-project');
  const resolver = () => null;
  const result = findNearestLocalCliEntry(cwd, resolver);
  assert.equal(result, null);
});

test('findNearestLocalCliEntry returns first match while traversing upward', () => {
  const cwd = '/repo/apps/web/src';
  const calls = [];
  const resolver = (dir) => {
    calls.push(dir);
    if (dir === '/repo/apps/web') {
      return '/repo/apps/web/node_modules/slicejs-cli/client.js';
    }
    return null;
  };

  const result = findNearestLocalCliEntry(cwd, resolver);

  assert.equal(result, '/repo/apps/web/node_modules/slicejs-cli/client.js');
  assert.deepEqual(calls, ['/repo/apps/web/src', '/repo/apps/web']);
});
