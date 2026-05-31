import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createTestProject, cleanupTestProject } from './helpers/setup.js';

/** @type {string} */
let tmpRoot;
const origInitCwd = process.env.INIT_CWD;

before(async () => {
  tmpRoot = await createTestProject();
  process.env.INIT_CWD = tmpRoot;
});

after(async () => {
  if (origInitCwd === undefined) {
    delete process.env.INIT_CWD;
  } else {
    process.env.INIT_CWD = origInitCwd;
  }
  await cleanupTestProject(tmpRoot);
});

describe('getProjectRoot', () => {
  test('resolves project root via INIT_CWD when pointing to a real project', async () => {
    const { getProjectRoot } = await import('../commands/utils/PathHelper.js');
    const root = getProjectRoot(import.meta.url);
    assert.ok(root, 'should return a path');
    assert.ok(fs.existsSync(root), `resolved path should exist: ${root}`);
    assert.equal(path.resolve(root), path.resolve(tmpRoot));
  });

  test('resolves project root via cwd when INIT_CWD is not set', async () => {
    const prev = process.env.INIT_CWD;
    delete process.env.INIT_CWD;
    try {
      const { getProjectRoot } = await import('../commands/utils/PathHelper.js');
      const root = getProjectRoot(import.meta.url);
      assert.ok(root, 'should return a path');
      assert.ok(fs.existsSync(root), `resolved path should exist: ${root}`);
    } finally {
      process.env.INIT_CWD = prev;
    }
  });
});

describe('getSrcPath', () => {
  test('returns src path relative to project root', async () => {
    const { getSrcPath } = await import('../commands/utils/PathHelper.js');
    const srcPath = getSrcPath(import.meta.url);
    assert.ok(srcPath.endsWith('src'), `should end with 'src': ${srcPath}`);
    assert.ok(fs.existsSync(srcPath), `src path should exist: ${srcPath}`);
  });

  test('accepts subpath segments', async () => {
    const { getSrcPath } = await import('../commands/utils/PathHelper.js');
    const result = getSrcPath(import.meta.url, 'Components', 'components.js');
    assert.ok(result.endsWith('src/Components/components.js') || result.endsWith('src\\Components\\components.js'));
    assert.ok(fs.existsSync(result), `file should exist: ${result}`);
  });
});

describe('getApiPath', () => {
  test('returns api path relative to project root', async () => {
    const { getApiPath } = await import('../commands/utils/PathHelper.js');
    const apiPath = getApiPath(import.meta.url);
    assert.ok(apiPath.endsWith('api'), `should end with 'api': ${apiPath}`);
    assert.ok(fs.existsSync(apiPath), `api path should exist: ${apiPath}`);
  });

  test('appends subpath to api', async () => {
    const { getApiPath } = await import('../commands/utils/PathHelper.js');
    const result = getApiPath(import.meta.url, 'index.js');
    assert.ok(result.endsWith('api/index.js') || result.endsWith('api\\index.js'));
  });
});

describe('getDistPath', () => {
  test('returns dist path relative to project root', async () => {
    const { getDistPath } = await import('../commands/utils/PathHelper.js');
    const distPath = getDistPath(import.meta.url);
    assert.ok(distPath.endsWith('dist'), `should end with 'dist': ${distPath}`);
  });
});

describe('getConfigPath', () => {
  test('returns sliceConfig.json path', async () => {
    const { getConfigPath } = await import('../commands/utils/PathHelper.js');
    const configPath = getConfigPath(import.meta.url);
    assert.ok(configPath.endsWith('sliceConfig.json'), `should end with 'sliceConfig.json': ${configPath}`);
    assert.ok(fs.existsSync(configPath), `config file should exist: ${configPath}`);
  });
});

describe('getComponentsJsPath', () => {
  test('returns components.js path', async () => {
    const { getComponentsJsPath } = await import('../commands/utils/PathHelper.js');
    const compPath = getComponentsJsPath(import.meta.url);
    assert.ok(compPath.endsWith('components.js'), `should end with 'components.js': ${compPath}`);
    assert.ok(fs.existsSync(compPath), `components.js should exist: ${compPath}`);
  });
});

describe('getPath', () => {
  test('joins arbitrary segments to project root', async () => {
    const { getPath } = await import('../commands/utils/PathHelper.js');
    const result = getPath(import.meta.url, 'src', 'routes.js');
    assert.ok(result.endsWith('routes.js'), `should end with 'routes.js': ${result}`);
    assert.ok(fs.existsSync(result), `routes.js should exist: ${result}`);
  });

  test('sanitizes leading slashes from segments', async () => {
    const { getPath } = await import('../commands/utils/PathHelper.js');
    const result = getPath(import.meta.url, '/src/', '/routes.js');
    assert.ok(result.endsWith('routes.js'), `should handle sanitized segments: ${result}`);
  });
});

describe('resolveProjectRoot (fallback via candidates)', () => {
  test('uses candidates() when INIT_CWD is not a valid path', async () => {
    const orig = process.env.INIT_CWD;
    process.env.INIT_CWD = 'C:\\nonexistent\\path';

    try {
      const { getProjectRoot } = await import('../commands/utils/PathHelper.js');
      const root = getProjectRoot(import.meta.url);
      assert.ok(root, 'should return a path');
      assert.ok(fs.existsSync(root), `fallback path should exist: ${root}`);
    } finally {
      process.env.INIT_CWD = orig;
    }
  });
});

describe('joinRoot', () => {
  test('joins segments relative to explicit root path', async () => {
    const { joinRoot } = await import('../commands/utils/PathHelper.js');
    const root = path.resolve('/test/project');
    const result = joinRoot(root, 'src', 'components');
    assert.equal(result, path.join(root, 'src', 'components'));
  });

  test('sanitizes leading slashes from segments', async () => {
    const { joinRoot } = await import('../commands/utils/PathHelper.js');
    const root = path.resolve('/test/project');
    const result = joinRoot(root, '/src', '/components');
    assert.equal(result, path.join(root, 'src', 'components'));
  });

  test('handles single segment', async () => {
    const { joinRoot } = await import('../commands/utils/PathHelper.js');
    const root = path.resolve('/test/project');
    const result = joinRoot(root, 'package.json');
    assert.equal(result, path.join(root, 'package.json'));
  });

  test('handles empty segments', async () => {
    const { joinRoot } = await import('../commands/utils/PathHelper.js');
    const root = path.resolve('/test/project');
    const result = joinRoot(root);
    assert.equal(result, root);
  });
});

describe('getConfigPath with explicit root', () => {
  test('returns sliceConfig.json under explicit root', async () => {
    const { getConfigPath } = await import('../commands/utils/PathHelper.js');
    const explicitRoot = path.resolve('/custom/project');
    const result = getConfigPath(import.meta.url, explicitRoot);
    assert.equal(result, path.join(explicitRoot, 'src', 'sliceConfig.json'));
  });

  test('returns sliceConfig.json without root (auto-resolve)', async () => {
    const { getConfigPath } = await import('../commands/utils/PathHelper.js');
    const result = getConfigPath(import.meta.url);
    assert.ok(result.endsWith('sliceConfig.json'));
    assert.ok(fs.existsSync(result));
  });
});

describe('getComponentsJsPath with explicit root', () => {
  test('returns components.js under explicit root', async () => {
    const { getComponentsJsPath } = await import('../commands/utils/PathHelper.js');
    const explicitRoot = path.resolve('/custom/project');
    const result = getComponentsJsPath(import.meta.url, explicitRoot);
    assert.equal(result, path.join(explicitRoot, 'src', 'Components', 'components.js'));
  });

  test('returns components.js without root (auto-resolve)', async () => {
    const { getComponentsJsPath } = await import('../commands/utils/PathHelper.js');
    const result = getComponentsJsPath(import.meta.url);
    assert.ok(result.endsWith('components.js'));
    assert.ok(fs.existsSync(result));
  });
});

describe('getSrcPath integration', () => {
  test('getSrcPath matches joinRoot with src prefix', async () => {
    const { getSrcPath, getProjectRoot, joinRoot } = await import('../commands/utils/PathHelper.js');
    const root = getProjectRoot(import.meta.url);
    const viaHelper = getSrcPath(import.meta.url, 'Components', 'components.js');
    const viaJoinRoot = joinRoot(root, 'src', 'Components', 'components.js');
    assert.equal(viaHelper, viaJoinRoot);
  });
});
