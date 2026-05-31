import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';
import { createTestProject, cleanupTestProject, withTestProject } from './helpers/setup.js';

describe('runConcurrent', () => {
  let runConcurrent;

  before(async () => {
    ({ runConcurrent } = await import('../commands/getComponent/getComponent.js'));
  });

  test('runs all items', async () => {
    const results = [];
    const worker = async (item) => { results.push(item); };
    await runConcurrent([1, 2, 3], worker, 5);
    assert.deepEqual(results.sort(), [1, 2, 3]);
  });

  test('respects concurrency limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const worker = async (item) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 10));
      concurrent--;
    };
    await runConcurrent([1, 2, 3, 4, 5], worker, 2);
    assert.equal(maxConcurrent <= 2, true);
  });

  test('handles empty array', async () => {
    const worker = async () => {};
    await runConcurrent([], worker, 3);
    assert.ok(true);
  });

  test('propagates worker errors', async () => {
    const worker = async () => { throw new Error('worker fail'); };
    await assert.rejects(() => runConcurrent([1], worker, 3), /worker fail/);
  });

  test('default concurrency is 3', async () => {
    let maxConcurrent = 0;
    let running = 0;
    const worker = async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise(r => setTimeout(r, 10));
      running--;
    };
    await runConcurrent([1, 2, 3, 4, 5], worker);
    assert.equal(maxConcurrent <= 3, true);
  });
});

describe('loadConfig', () => {
  test('returns config object when sliceConfig.json exists', async () => {
    await withTestProject(async (tmpDir) => {
      const { loadConfig } = await import('../commands/getComponent/getComponent.js');
      const config = await loadConfig();
      assert.notEqual(config, null);
      assert.equal(typeof config, 'object');
      assert.equal(config.server?.port, 3001);
    });
  });

  test('returns null when sliceConfig.json is missing', async () => {
    const tmpDir = await createTestProject();
    try {
      process.env.INIT_CWD = tmpDir;
      const fixtureConfig = new URL('../tests/fixtures/sliceConfig.json', import.meta.url);
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const destPath = path.join(tmpDir, 'src', 'sliceConfig.json');
      try { await fs.unlink(destPath); } catch {}
      const { loadConfig } = await import('../commands/getComponent/getComponent.js');
      const config = await loadConfig();
      assert.equal(config, null);
    } finally {
      delete process.env.INIT_CWD;
      await cleanupTestProject(tmpDir);
    }
  });
});

describe('ComponentRegistry.getAvailableComponents', () => {
  let ComponentRegistry;

  before(async () => {
    ({ ComponentRegistry } = await import('../commands/getComponent/getComponent.js'));
  });

  const makeRegistry = (entries) => {
    const registry = new ComponentRegistry();
    registry.componentsRegistry = { ...entries };
    return registry;
  };

  test('returns empty object when registry not loaded', () => {
    const registry = new ComponentRegistry();
    const result = registry.getAvailableComponents();
    assert.deepEqual(result, {});
  });

  test('routing components (Route, MultiRoute, Link) return only .js', () => {
    const registry = makeRegistry({
      Route: 'Visual',
      MultiRoute: 'Visual',
      Link: 'Visual'
    });
    const result = registry.getAvailableComponents('Visual');
    assert.deepEqual(result.Route.files, ['Route.js']);
    assert.deepEqual(result.MultiRoute.files, ['MultiRoute.js']);
    assert.deepEqual(result.Link.files, ['Link.js']);
  });

  test('NotFound returns .js, .html, .css like other visual components', () => {
    const registry = makeRegistry({
      NotFound: 'Visual',
      Button: 'Visual',
      Navbar: 'Visual'
    });
    const result = registry.getAvailableComponents('Visual');
    assert.deepEqual(result.NotFound.files, ['NotFound.js', 'NotFound.html', 'NotFound.css']);
    assert.deepEqual(result.Button.files, ['Button.js', 'Button.html', 'Button.css']);
    assert.deepEqual(result.Navbar.files, ['Navbar.js', 'Navbar.html', 'Navbar.css']);
  });

  test('Service components return only .js', () => {
    const registry = makeRegistry({
      FetchManager: 'Service'
    });
    const result = registry.getAvailableComponents('Service');
    assert.deepEqual(result.FetchManager.files, ['FetchManager.js']);
  });

  test('filters by category - Visual', () => {
    const registry = makeRegistry({
      Button: 'Visual',
      FetchManager: 'Service'
    });
    const result = registry.getAvailableComponents('Visual');
    assert.ok(result.Button);
    assert.ok(!result.FetchManager);
  });

  test('filters by category - Service', () => {
    const registry = makeRegistry({
      Button: 'Visual',
      FetchManager: 'Service'
    });
    const result = registry.getAvailableComponents('Service');
    assert.ok(!result.Button);
    assert.ok(result.FetchManager);
  });

  test('returns all categories when no filter', () => {
    const registry = makeRegistry({
      Button: 'Visual',
      FetchManager: 'Service'
    });
    const result = registry.getAvailableComponents();
    assert.ok(result.Button);
    assert.ok(result.FetchManager);
  });
});

describe('fetchWithRetry', () => {
  let fetchWithRetry;
  let originalFetch;

  before(async () => {
    ({ fetchWithRetry } = await import('../commands/getComponent/getComponent.js'));
  });

  after(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  test('succeeds on first attempt', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      text: async () => 'response body'
    }));
    const result = await fetchWithRetry('https://example.com');
    assert.equal(result, 'response body');
    assert.equal(globalThis.fetch.mock.calls.length, 1);
    globalThis.fetch = originalFetch;
  });

  test('retries and eventually succeeds', async () => {
    let attempts = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => {
      attempts++;
      if (attempts < 3) throw new Error('network error');
      return { ok: true, text: async () => 'success after retry' };
    });
    const result = await fetchWithRetry('https://example.com', 3, 5);
    assert.equal(result, 'success after retry');
    assert.equal(attempts, 3);
    globalThis.fetch = originalFetch;
  });

  test('fails after exhausting retries', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => { throw new Error('persistent error'); });
    await assert.rejects(() => fetchWithRetry('https://example.com', 2, 5), /persistent error/);
    globalThis.fetch = originalFetch;
  });

  test('rejects non-ok response', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found'
    }));
    await assert.rejects(() => fetchWithRetry('https://example.com', 2, 5), /HTTP 404/);
    globalThis.fetch = originalFetch;
  });
});

describe('filterOfficialComponents', () => {
  let ComponentRegistry;

  before(async () => {
    ({ ComponentRegistry } = await import('../commands/getComponent/getComponent.js'));
  });

  test('includes Visual and Service components', () => {
    const registry = new ComponentRegistry();
    const result = registry.filterOfficialComponents({
      Button: 'Visual',
      FetchManager: 'Service'
    });
    assert.deepEqual(result, { Button: 'Visual', FetchManager: 'Service' });
  });

  test('excludes AppComponents and other categories', () => {
    const registry = new ComponentRegistry();
    const result = registry.filterOfficialComponents({
      Button: 'Visual',
      AppShell: 'AppComponents',
      SomeOther: 'Unknown'
    });
    assert.deepEqual(result, { Button: 'Visual' });
  });

  test('returns empty object for empty input', () => {
    const registry = new ComponentRegistry();
    const result = registry.filterOfficialComponents({});
    assert.deepEqual(result, {});
  });

  test('returns empty when no Visual or Service components', () => {
    const registry = new ComponentRegistry();
    const result = registry.filterOfficialComponents({
      AppShell: 'AppComponents',
      Custom: 'Other'
    });
    assert.deepEqual(result, {});
  });
});

describe('findComponentInRegistry', () => {
  let ComponentRegistry;

  before(async () => {
    ({ ComponentRegistry } = await import('../commands/getComponent/getComponent.js'));
  });

  const makeRegistry = (entries) => {
    const registry = new ComponentRegistry();
    registry.componentsRegistry = { ...entries };
    return registry;
  };

  test('finds component by name (case-insensitive)', () => {
    const registry = makeRegistry({ Button: 'Visual' });
    const result = registry.findComponentInRegistry('button');
    assert.deepEqual(result, { name: 'Button', category: 'Visual' });
  });

  test('returns null for non-existent component', () => {
    const registry = makeRegistry({ Button: 'Visual' });
    const result = registry.findComponentInRegistry('NonExistent');
    assert.equal(result, null);
  });

  test('returns null when registry not loaded', () => {
    const registry = new ComponentRegistry();
    const result = registry.findComponentInRegistry('Button');
    assert.equal(result, null);
  });

  test('finds component with exact case', () => {
    const registry = makeRegistry({ FetchManager: 'Service' });
    const result = registry.findComponentInRegistry('FetchManager');
    assert.deepEqual(result, { name: 'FetchManager', category: 'Service' });
  });
});

describe('getLocalComponents', () => {
  let ComponentRegistry;

  before(async () => {
    ({ ComponentRegistry } = await import('../commands/getComponent/getComponent.js'));
  });

  test('returns components from local components.js', async () => {
    await withTestProject(async (tmpDir) => {
      const registry = new ComponentRegistry();
      const result = await registry.getLocalComponents();
      assert.deepEqual(result, { Button: 'Visual' });
    }, { visualComponents: ['Button'] });
  });

  test('returns empty object when no components.js exists', async () => {
    const tmpDir = await createTestProject();
    try {
      process.env.INIT_CWD = tmpDir;
      const componentsPath = path.join(tmpDir, 'src', 'Components', 'components.js');
      await fs.remove(componentsPath);
      const registry = new ComponentRegistry();
      const result = await registry.getLocalComponents();
      assert.deepEqual(result, {});
    } finally {
      delete process.env.INIT_CWD;
      await cleanupTestProject(tmpDir);
    }
  });

  test('returns empty object when components.js has invalid format', async () => {
    const tmpDir = await createTestProject();
    try {
      process.env.INIT_CWD = tmpDir;
      const componentsPath = path.join(tmpDir, 'src', 'Components', 'components.js');
      await fs.writeFile(componentsPath, 'not valid javascript', 'utf8');
      const registry = new ComponentRegistry();
      const result = await registry.getLocalComponents();
      assert.deepEqual(result, {});
    } finally {
      delete process.env.INIT_CWD;
      await cleanupTestProject(tmpDir);
    }
  });
});

describe('updateLocalRegistrySafe', () => {
  let ComponentRegistry;

  before(async () => {
    ({ ComponentRegistry } = await import('../commands/getComponent/getComponent.js'));
  });

  test('registers a new component in components.js', async () => {
    await withTestProject(async (tmpDir) => {
      const registry = new ComponentRegistry();
      await registry.updateLocalRegistrySafe('NewComp', 'Visual');
      const components = await registry.getLocalComponents();
      assert.equal(components.NewComp, 'Visual');
    }, { visualComponents: [] });
  });

  test('does not duplicate existing component', async () => {
    await withTestProject(async (tmpDir) => {
      const registry = new ComponentRegistry();
      await registry.updateLocalRegistrySafe('Button', 'Visual');
      const components = await registry.getLocalComponents();
      assert.equal(components.Button, 'Visual');
      assert.deepEqual(Object.keys(components).filter(k => k === 'Button'), ['Button']);
    }, { visualComponents: ['Button'] });
  });
});

describe('findUpdatableComponents', () => {
  let ComponentRegistry;

  before(async () => {
    ({ ComponentRegistry } = await import('../commands/getComponent/getComponent.js'));
  });

  test('returns empty when no local components match remote registry', async () => {
    await withTestProject(async (tmpDir) => {
      const registry = new ComponentRegistry();
      registry.componentsRegistry = { SomeRemote: 'Visual' };
      const result = await registry.findUpdatableComponents();
      assert.deepEqual(result, []);
    }, { visualComponents: ['Button'] });
  });

  test('returns components that exist both locally and remotely', async () => {
    await withTestProject(async (tmpDir) => {
      const registry = new ComponentRegistry();
      registry.componentsRegistry = { Button: 'Visual', FetchManager: 'Service' };
      const result = await registry.findUpdatableComponents();
      assert.equal(result.length, 1);
      assert.equal(result[0].name, 'Button');
      assert.equal(result[0].category, 'Visual');
    }, { visualComponents: ['Button'] });
  });
});
