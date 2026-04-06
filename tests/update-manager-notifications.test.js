import { test } from 'node:test';
import assert from 'node:assert/strict';
import Print from '../commands/Print.js';
import { UpdateManager } from '../commands/utils/updateManager.js';

test('notifyAvailableUpdates shows advisory output and never invokes interactive update flow', async () => {
  const manager = new UpdateManager();
  const calls = {
    display: 0,
    prompted: 0,
    info: [],
    error: []
  };

  manager.checkForUpdates = async () => ({
    hasUpdates: true,
    updates: [
      {
        name: 'slicejs-web-framework',
        displayName: 'Slice.js Framework',
        current: '2.4.3',
        latest: '2.5.0',
        type: 'framework'
      }
    ],
    allCurrent: false
  });

  manager.displayUpdates = () => {
    calls.display += 1;
  };

  manager.checkAndPromptUpdates = async () => {
    calls.prompted += 1;
    return true;
  };

  const originalInfo = Print.info;
  const originalError = Print.error;

  Print.info = (message) => calls.info.push(message);
  Print.error = (message) => calls.error.push(message);

  try {
    const result = await manager.notifyAvailableUpdates();

    assert.equal(result, true);
    assert.equal(calls.display, 1);
    assert.equal(calls.prompted, 0);
    assert.equal(calls.error.length, 0);
    assert.equal(calls.info.length, 1);
    assert.match(calls.info[0], /slice update/);
  } finally {
    Print.info = originalInfo;
    Print.error = originalError;
  }
});

test('notifyAvailableUpdates returns false and prints nothing when no updates are available', async () => {
  const manager = new UpdateManager();
  const calls = {
    display: 0,
    info: []
  };

  manager.checkForUpdates = async () => ({
    hasUpdates: false,
    updates: [],
    allCurrent: true
  });

  manager.displayUpdates = () => {
    calls.display += 1;
  };

  const originalInfo = Print.info;
  Print.info = (message) => calls.info.push(message);

  try {
    const result = await manager.notifyAvailableUpdates();

    assert.equal(result, false);
    assert.equal(calls.display, 0);
    assert.equal(calls.info.length, 0);
  } finally {
    Print.info = originalInfo;
  }
});
