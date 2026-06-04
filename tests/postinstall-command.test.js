import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLICE_SCRIPTS } from '../commands/utils/sliceScripts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(__dirname, '..', 'client.js');
const source = fs.readFileSync(clientPath, 'utf-8');
const postSource = fs.readFileSync(path.join(__dirname, '..', 'post.js'), 'utf-8');
const initSource = fs.readFileSync(path.join(__dirname, '..', 'commands', 'init', 'init.js'), 'utf-8');

test('postinstall command is registered in client.js', () => {
  const hasSetupCommand = source.includes('.command("postinstall")');
  assert.ok(hasSetupCommand, 'client.js must register a "postinstall" command');
});

test('postinstall command has a description', () => {
  const match = source.match(/\.command\(["']postinstall["']\)\s*\.description\(["']([^"']+)["']\)/);
  assert.ok(match, 'postinstall command must have a .description() call');
  assert.ok(match[1].length > 0, 'postinstall command description must not be empty');
});

test('postinstall command checks npm_config_global environment variable', () => {
  const hasGlobalCheck = source.includes('npm_config_global');
  assert.ok(hasGlobalCheck, 'postinstall command must check npm_config_global to detect global installation');
});

test('postinstall command prints global install warning', () => {
  const hasGlobalWarning = source.includes('Global installation');
  assert.ok(hasGlobalWarning, 'postinstall command must warn about global installation');
});

test('postinstall command prints local install success message', () => {
  const hasSuccessMsg = source.includes('installed successfully');
  assert.ok(hasSuccessMsg, 'postinstall command must show success message for local installs');
});

test('postinstall command uses getProjectRoot from PathHelper', () => {
  const hasPathHelper = source.includes("getProjectRoot(import.meta.url)");
  assert.ok(hasPathHelper, 'postinstall command must use getProjectRoot resolver');
});

test('postinstall command writes npm scripts to package.json via fs', () => {
  const hasFsWrite = source.includes('writeFileSync(pkgPath');
  assert.ok(hasFsWrite, 'postinstall command must write scripts to package.json');
});

test('SLICE_SCRIPTS contains every slice:* command', () => {
  const expected = [
    'slice:init', 'slice:dev', 'slice:build', 'slice:start',
    'slice:create', 'slice:list', 'slice:delete',
    'slice:get', 'slice:browse', 'slice:sync',
    'slice:version', 'slice:update', 'slice:types'
  ];
  for (const script of expected) {
    assert.ok(SLICE_SCRIPTS[script], `SLICE_SCRIPTS must define ${script}`);
    assert.ok(SLICE_SCRIPTS[script].startsWith('slice '), `${script} must run a slice command`);
  }
  assert.equal(Object.keys(SLICE_SCRIPTS).length, expected.length, 'no unexpected scripts in SLICE_SCRIPTS');
});

test('postinstall command, post.js and slice init all use the shared SLICE_SCRIPTS', () => {
  // Single source of truth: the three writers must import the shared module so
  // they cannot drift apart (client.js used to miss slice:types, none had slice:build).
  assert.ok(source.includes('SLICE_SCRIPTS'), 'client.js postinstall must use SLICE_SCRIPTS');
  assert.ok(source.includes("from './commands/utils/sliceScripts.js'"), 'client.js must import sliceScripts.js');
  assert.ok(postSource.includes('SLICE_SCRIPTS'), 'post.js must use SLICE_SCRIPTS');
  assert.ok(postSource.includes("from './commands/utils/sliceScripts.js'"), 'post.js must import sliceScripts.js');
  assert.ok(initSource.includes('Object.assign(pkg.scripts, SLICE_SCRIPTS)'), 'init.js must apply SLICE_SCRIPTS');
  assert.ok(initSource.includes("from '../utils/sliceScripts.js'"), 'init.js must import sliceScripts.js');
});

test('postinstall command action is a function', () => {
  const SetupActionPattern = /\.command\(["']postinstall["']\)[\s\S]*?\.action\(\(\)\s*=>\s*\{[\s\S]*?\}\)/;
  const match = source.match(SetupActionPattern);
  assert.ok(match, 'postinstall command must have an .action() with arrow function');
});

test('postinstall command provides npm uninstall -g instruction for global installs', () => {
  const hasUninstallInstruction = source.includes('npm uninstall -g slicejs-cli');
  assert.ok(hasUninstallInstruction, 'postinstall command must tell users how to uninstall global CLI');
});
