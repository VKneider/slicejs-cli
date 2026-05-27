import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(__dirname, '..', 'client.js');
const source = fs.readFileSync(clientPath, 'utf-8');

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

test('postinstall command writes slice:dev script to package.json', () => {
  const hasDevScript = source.includes("'slice:dev': 'slice dev'");
  assert.ok(hasDevScript, 'postinstall command must add "slice:dev" script to package.json');
});

test('postinstall command writes all slice:* scripts to package.json', () => {
  const scripts = [
    'slice:dev', 'slice:start', 'slice:create', 'slice:list',
    'slice:delete', 'slice:init', 'slice:get', 'slice:browse',
    'slice:sync', 'slice:version', 'slice:update'
  ];
  for (const script of scripts) {
    assert.ok(source.includes(script), `postinstall command must configure ${script} script`);
  }
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
