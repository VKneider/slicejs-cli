import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseUserAgent,
  fromPackageManagerField,
  fromLockfile,
  detectPackageManager,
  resolvePackageManager,
  installCommand,
  uninstallCommand,
  SUPPORTED_PACKAGE_MANAGERS
} from '../commands/utils/PackageManager.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'slice-pm-test-'));
}

test('parseUserAgent detects pnpm', () => {
  const result = parseUserAgent('pnpm/9.12.0 npm/? node/v20.11.0 linux x64');
  assert.equal(result.name, 'pnpm');
  assert.equal(result.version, '9.12.0');
});

test('parseUserAgent detects npm', () => {
  const result = parseUserAgent('npm/10.5.0 node/v20.11.0 linux x64 workspaces/false');
  assert.equal(result.name, 'npm');
});

test('parseUserAgent returns null for missing or unknown agent', () => {
  assert.equal(parseUserAgent(undefined), null);
  assert.equal(parseUserAgent('bun/1.1.0 node/v20.11.0'), null);
});

test('fromPackageManagerField reads corepack-style field', () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', packageManager: 'pnpm@9.12.0' }));
    const result = fromPackageManagerField(dir);
    assert.equal(result.name, 'pnpm');
    assert.equal(result.version, '9.12.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fromPackageManagerField returns null without field or manifest', () => {
  const dir = makeTmpDir();
  try {
    assert.equal(fromPackageManagerField(dir), null);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    assert.equal(fromPackageManagerField(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fromLockfile detects each supported lockfile', () => {
  const cases = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'yarn']
  ];
  for (const [lockfile, expected] of cases) {
    const dir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(dir, lockfile), '');
      assert.equal(fromLockfile(dir).name, expected, `${lockfile} should map to ${expected}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('detectPackageManager prefers packageManager field over lockfile and user agent', () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', packageManager: 'pnpm@9.0.0' }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    const result = detectPackageManager(dir, { userAgent: 'npm/10.5.0 node/v20.11.0' });
    assert.equal(result.name, 'pnpm');
    assert.equal(result.source, 'package-manager-field');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectPackageManager falls back to lockfile, then user agent', () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    assert.equal(detectPackageManager(dir, { userAgent: 'npm/10.5.0 node/v20' }).name, 'pnpm');
    fs.rmSync(path.join(dir, 'pnpm-lock.yaml'));
    assert.equal(detectPackageManager(dir, { userAgent: 'npm/10.5.0 node/v20' }).name, 'npm');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePackageManager never returns null', () => {
  const dir = makeTmpDir();
  try {
    const result = resolvePackageManager(dir, { userAgent: undefined });
    assert.ok(SUPPORTED_PACKAGE_MANAGERS.includes(result.name));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installCommand builds the right command per package manager', () => {
  assert.equal(installCommand('npm', 'slicejs-web-framework'), 'npm install slicejs-web-framework');
  assert.equal(installCommand('pnpm', 'slicejs-web-framework'), 'pnpm add slicejs-web-framework');
  assert.equal(installCommand('yarn', 'slicejs-web-framework'), 'yarn add slicejs-web-framework');
  assert.equal(installCommand('npm', 'slicejs-cli', { dev: true }), 'npm install -D slicejs-cli');
  assert.equal(installCommand('pnpm', 'slicejs-cli', { dev: true }), 'pnpm add -D slicejs-cli');
  assert.equal(installCommand('npm', 'slicejs-cli@latest', { global: true }), 'npm install -g slicejs-cli@latest');
  assert.equal(installCommand('pnpm', 'slicejs-cli@latest', { global: true }), 'pnpm add -g slicejs-cli@latest');
  assert.equal(installCommand('pnpm', ['a', 'b']), 'pnpm add a b');
});

test('uninstallCommand builds the right command per package manager', () => {
  assert.equal(uninstallCommand('npm', 'slicejs-cli'), 'npm uninstall slicejs-cli');
  assert.equal(uninstallCommand('pnpm', 'slicejs-cli'), 'pnpm remove slicejs-cli');
  assert.equal(uninstallCommand('pnpm', 'slicejs-cli', { global: true }), 'pnpm remove -g slicejs-cli');
  assert.equal(uninstallCommand('npm', 'slicejs-cli', { global: true }), 'npm uninstall -g slicejs-cli');
});
