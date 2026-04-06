import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(__dirname, '..', 'client.js');
const source = fs.readFileSync(clientPath, 'utf-8');

test('client imports LocalCliDelegation utility', () => {
  assert.match(source, /LocalCliDelegation/);
});

test('client checks SLICE_NO_LOCAL_DELEGATION behavior before command runtime', () => {
  assert.match(source, /isLocalDelegationDisabled\(/);
});

test('client performs local candidate resolution and delegation decision', () => {
  assert.match(source, /findNearestLocalCliEntry\(/);
  assert.match(source, /shouldDelegateToLocalCli\(/);
});
