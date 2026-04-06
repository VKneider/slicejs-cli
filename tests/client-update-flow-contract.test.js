import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(__dirname, '..', 'client.js');
const clientSource = fs.readFileSync(clientPath, 'utf-8');

test('runWithVersionCheck uses non-blocking update notifications', () => {
  const runWithVersionCheckMatch = clientSource.match(/async function runWithVersionCheck[\s\S]*?\n}\n/);

  assert.ok(runWithVersionCheckMatch, 'runWithVersionCheck function should exist');
  assert.match(runWithVersionCheckMatch[0], /await updateManager\.notifyAvailableUpdates\(\);/);
  assert.doesNotMatch(runWithVersionCheckMatch[0], /checkAndPromptUpdates\(/);
});

test('update command remains explicitly interactive', () => {
  assert.match(
    clientSource,
    /\.command\("update"\)[\s\S]*?\.action\(async \(options\) => \{[\s\S]*?await updateManager\.checkAndPromptUpdates\(options\);[\s\S]*?\}\);/
  );
});
