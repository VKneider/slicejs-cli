#!/usr/bin/env node
// Release readiness for the CLI package, without publishing anything.
//
// It exists because the published `slicejs-cli@4.3.0` declared
// `slicejs-web-framework@^3.5.0`: installing the CLI gave you a 3.x runtime, and
// nobody noticed until a project behaved like an old one. Version numbers drift;
// a machine check does not.
//
//   node scripts/release-check.mjs                 # release gate
//   node scripts/release-check.mjs --allow-published   # everyday CI
//
// Exit codes: 0 ready, 1 blocked (each reason is printed).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { satisfies, rangeMismatch } from '../commands/utils/semver.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const allowPublished = argv.includes('--allow-published');
const offline = argv.includes('--offline');

const log = {
  ok: (message) => console.log(`[ok]   ${message}`),
  warn: (message) => console.log(`[warn] ${message}`),
  fail: (message) => console.log(`[FAIL] ${message}`),
  info: (message) => console.log(`       ${message}`)
};

const errors = [];
const warnings = [];

function check(condition, message, detail) {
  if (condition) {
    log.ok(message);
    return true;
  }
  log.fail(message);
  if (detail) log.info(detail);
  errors.push(message);
  return false;
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// ── versions ────────────────────────────────────────────────────────────────

function npmView(spec) {
  const result = spawnSync('npm', ['view', spec, 'version'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 60_000
  });

  if (result.status === 0) {
    const version = String(result.stdout || '').trim();
    return version ? { version } : { error: 'empty response' };
  }

  const stderr = String(result.stderr || '').trim();
  // E404 means the version does not exist yet (the normal pre-release state).
  if (/E404|404 Not Found/i.test(stderr)) return { missing: true };
  return { error: stderr.split('\n').slice(-2).join(' ') || `npm exited ${result.status}` };
}

// ── checks ──────────────────────────────────────────────────────────────────

function checkPackaging() {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 120_000
  });

  if (result.status !== 0) {
    check(false, 'the package can be packed with npm', `${result.stdout || ''}${result.stderr || ''}`.trim().slice(0, 400));
    return;
  }

  const pack = JSON.parse(result.stdout)[0];
  const entries = pack.files.map((file) => file.path);
  const has = (prefix) => entries.some((entry) => entry === prefix || entry.startsWith(`${prefix}/`));

  check(has('client.js'), 'the tarball contains client.js');
  check(has('eslint-config.js'), 'the tarball contains eslint-config.js');
  check(has('commands'), 'the tarball contains commands/');
  check(has('assets'), 'the tarball contains assets/');

  // `files` in package.json is the allowlist; if it is missing, everything ships.
  const leaked = entries.filter((entry) => /^(tests|features|\.github|node_modules)\//.test(entry));
  check(
    leaked.length === 0,
    'the tarball contains no tests/, features/, .github/ or node_modules/',
    leaked.slice(0, 5).join(', ')
  );

  log.info(`${entries.length} files, ${(pack.size / 1024).toFixed(0)} KB unpacked (${(pack.unpackedSize / 1024).toFixed(0)} KB installed)`);
}

function checkVersionUnpublished() {
  if (allowPublished) {
    log.info(`version ${pkg.version} — publication not checked (--allow-published)`);
    return;
  }
  if (offline) {
    log.info('registry not consulted (--offline)');
    return;
  }

  const published = npmView(`${pkg.name}@${pkg.version}`);
  if (published.error) {
    // The registry being unreachable must not be reported as "ready".
    const message = `could not ask npm about ${pkg.name}@${pkg.version}: ${published.error}`;
    log.warn(message);
    warnings.push(message);
    return;
  }

  check(!published.version, `version ${pkg.version} is not on npm yet`, 'Bump the version before publishing (npm does not allow overwriting it).');
}

function pairedFrameworkVersion() {
  const local = path.resolve(ROOT, '..', 'slice.js', 'package.json');
  if (fs.existsSync(local)) {
    const version = JSON.parse(fs.readFileSync(local, 'utf8')).version;
    return { version, source: 'the local framework checkout' };
  }
  const published = offline ? null : npmView('slicejs-web-framework');
  if (published?.version) return { version: published.version, source: 'the published framework' };
  if (published?.error) {
    log.warn(`could not ask npm for the published framework: ${published.error}`);
  }
  return null;
}

function checkFrameworkRange() {
  const range = pkg.dependencies?.['slicejs-web-framework'];
  if (!check(Boolean(range), 'the CLI declares slicejs-web-framework')) return;

  const paired = pairedFrameworkVersion();
  if (!paired) {
    log.info(`range ${range} — no framework version available to compare (offline)`);
    return;
  }

  check(
    satisfies(range, paired.version),
    `the declared range ${range} accepts ${paired.version} (${paired.source})`,
    `A published CLI that cannot install the framework it is built against ships the wrong runtime to every new user.`
  );
}

function checkChangelog() {
  const file = path.join(ROOT, 'CHANGELOG.md');
  if (!check(fs.existsSync(file), 'CHANGELOG.md exists')) return;

  const text = fs.readFileSync(file, 'utf8');
  const released = new RegExp(`^##\\s*\\[?v?${pkg.version.replace(/\./g, '\\.')}\\]?`, 'm').test(text);
  check(released, `CHANGELOG.md has a section for ${pkg.version}`, 'Move [Unreleased] into the new version before tagging.');
}

console.log(`\nRelease check — ${pkg.name}@${pkg.version}\n`);

checkPackaging();
checkVersionUnpublished();
checkFrameworkRange();
checkChangelog();

console.log('');
if (warnings.length) console.log(`${warnings.length} warning(s).`);
if (errors.length) {
  console.log(`Not ready: ${errors.length} problem(s).`);
  process.exitCode = 1;
} else {
  console.log('Ready to release.');
}
