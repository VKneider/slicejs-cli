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

test('init command action calls initializeProject', () => {
  const hasCall = source.includes('initializeProject()');
  assert.ok(hasCall, 'init command action must call initializeProject');
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
