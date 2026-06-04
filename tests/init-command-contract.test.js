import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(__dirname, '..', 'client.js');
const source = fs.readFileSync(clientPath, 'utf-8');

test('init command is registered in client.js', () => {
  const hasInit = source.includes('.command("init")');
  assert.ok(hasInit, 'client.js must register an "init" command');
});

test('init command has a description', () => {
  const match = source.match(/\.command\(["']init["']\)\s*\.description\(["']([^"']+)["']\)/);
  assert.ok(match, 'init command must have a .description() call');
  assert.ok(match[1].length > 0, 'init command description must not be empty');
});

test('init command has -y / --yes option', () => {
  const hasShort = source.includes('"-y, --yes');
  assert.ok(hasShort, 'init command must have a -y/--yes option for non-interactive use');
});

test('init command action calls initializeProject with the chosen package manager', () => {
  const hasCall = source.includes('initializeProject({ packageManager })');
  assert.ok(hasCall, 'init command action must call initializeProject passing the package manager');
});

test('init command has a --pm option for package manager selection', () => {
  assert.ok(source.includes('--pm <packageManager>'), 'init command must expose a --pm option');
});

test('init command normalizes project name (lowercase, hyphens)', () => {
  const hasFilter = source.includes('.toLowerCase()');
  assert.ok(hasFilter, 'init command must normalize project name to lowercase');
  assert.ok(source.includes('.replace(/\\s+/g'), 'init command must replace spaces with hyphens');
});

test('init command validates project name', () => {
  assert.ok(source.includes("'Project name cannot be empty'"), 'init command must validate non-empty name');
  assert.ok(source.includes("'Use a simple name, not a path'"), 'init command must reject path separators');
});

test('init command creates project directory', () => {
  assert.ok(source.includes('fs.mkdirSync(projectDir'), 'init command must create the project directory');
  assert.ok(source.includes('process.chdir(projectDir)'), 'init command must chdir into project');
});

// --- initializeProject (commands/init/init.js) contracts ---

const initPath = path.join(__dirname, '..', 'commands', 'init', 'init.js');
const initSource = fs.readFileSync(initPath, 'utf-8');

test('initializeProject creates package.json BEFORE installing anything', () => {
  // Without a manifest in the project folder, npm/pnpm walk up the directory
  // tree and anchor node_modules OUTSIDE the new project. The manifest must
  // exist before the first install command runs.
  const manifestIdx = initSource.indexOf('await ensureProjectManifest(');
  const installIdx = initSource.indexOf('execSync(installCommand(');
  assert.ok(manifestIdx !== -1, 'init.js must call ensureProjectManifest');
  assert.ok(installIdx !== -1, 'init.js must install via PackageManager.installCommand');
  assert.ok(manifestIdx < installIdx, 'package.json must be created before any install runs');
});

test('initializeProject does not hardcode npm commands', () => {
  assert.ok(!initSource.includes("execSync('npm "), 'init.js must not execSync hardcoded npm commands');
  assert.ok(!initSource.includes('execSync(`npm '), 'init.js must not execSync hardcoded npm template commands');
});

test('initializeProject does not pin an exact registry version on install', () => {
  // Pinning the freshest registry version breaks pnpm installs under
  // minimumReleaseAge (release-age quarantine). Install unpinned instead.
  assert.ok(!initSource.includes('@${latest}'), 'init.js must not pin the freshest registry version');
});

test('initializeProject installs slicejs-cli as devDependency', () => {
  assert.ok(
    initSource.includes("installCommand(packageManager, 'slicejs-cli', { dev: true })"),
    'init.js must install slicejs-cli locally as a devDependency'
  );
});

test('initializeProject persists the packageManager field', () => {
  assert.ok(initSource.includes('pkg.packageManager ='), 'init.js must persist the packageManager field in package.json');
});

test('initializeProject configures pnpm allowBuilds for slicejs-cli', () => {
  assert.ok(
    initSource.includes("if (packageManager === 'pnpm')")
      && initSource.includes('ensurePnpmAllowBuilds(projectRoot)'),
    'init.js must configure pnpm allowBuilds when pnpm is selected'
  );
  assert.ok(
    initSource.includes("allowBuilds:") && initSource.includes("slicejs-cli: true"),
    'init.js must write allowBuilds.slicejs-cli: true in pnpm-workspace.yaml'
  );
});
