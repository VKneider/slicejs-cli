// Shared plumbing for the `slice seo` commands: locating the project's
// framework, reading the manifest, and writing a file without ever clobbering
// one silently.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getProjectRoot } from '../utils/PathHelper.js';

export const MANIFEST_FILE = 'seo.json';
export const SITEMAP_FILE = path.join('src', 'public', 'sitemap.xml');
export const ROBOTS_FILE = path.join('src', 'public', 'robots.txt');

export const resolveRoot = (moduleUrl) => getProjectRoot(moduleUrl);

/**
 * The validator and the builders live in the framework, so the rules cannot
 * drift between `slice seo check`, `slice doctor` and the server. Resolve it
 * from the project first: that is the version the app actually runs.
 */
export async function loadFrameworkSeo(projectRoot) {
  const seoPath = path.join(projectRoot, 'node_modules', 'slicejs-web-framework', 'api', 'framework', 'seo.js');
  if (fs.existsSync(seoPath)) {
    return import(pathToFileURL(seoPath).href);
  }
  try {
    return await import('slicejs-web-framework/api/framework/seo.js');
  } catch (error) {
    throw new Error(
      `Cannot load the framework SEO module from ${projectRoot} ` +
      `(${error.message}). Update slicejs-web-framework to a version that ships api/framework/seo.js.`
    );
  }
}

export function loadManifest(projectRoot) {
  const file = path.join(projectRoot, MANIFEST_FILE);
  if (!fs.existsSync(file)) return { file, manifest: null };
  return { file, manifest: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

/** Prompt only when there is a human: CI must fail, never hang. */
export async function promptYesNo(question, { defaultValue = false } = {}) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? '[Y/n]' : '[y/N]';
    const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/**
 * Write `content` to `file` unless that would clobber a different file without
 * permission.
 *
 * Statuses: `created`, `unchanged` (nothing written, no mtime churn),
 * `updated`, `skipped` (the user said no), `would-change` (dry run),
 * `needs-confirmation` (no TTY and no --yes).
 *
 * @returns {Promise<{ status: string, file: string }>}
 */
export async function writeFileConfirmed(file, content, options = {}) {
  const { yes = false, dryRun = false, confirm = null } = options;

  const exists = fs.existsSync(file);
  const current = exists ? fs.readFileSync(file, 'utf8') : null;
  if (current === content) return { status: 'unchanged', file };
  if (!exists) {
    if (!dryRun) await writeAtomic(file, content);
    return { status: dryRun ? 'would-change' : 'created', file };
  }

  if (dryRun) return { status: 'would-change', file };
  if (!yes) {
    const allowed = confirm
      ? await confirm(file)
      : isInteractive()
        ? await promptYesNo(`${file} already exists and would change. Overwrite it?`, { defaultValue: false })
        : false;
    if (!allowed) {
      return { status: isInteractive() || confirm ? 'skipped' : 'needs-confirmation', file };
    }
  }

  await writeAtomic(file, content);
  return { status: 'updated', file };
}

async function writeAtomic(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, content);
  await fsp.rename(tmp, file);
}

/**
 * `robots.txt` from the manifest. Returns null when the manifest does not ask
 * for one, so a hand-written file is never touched.
 */
export function buildRobotsTxt(manifest, origin) {
  const config = manifest?.robotsTxt;
  if (!config || config === false) return null;

  const lines = ['User-agent: *'];
  const allow = Array.isArray(config.allow) ? config.allow : [];
  const disallow = Array.isArray(config.disallow) ? config.disallow : [];
  if (!allow.length && !disallow.length) lines.push('Allow: /');
  for (const entry of allow) lines.push(`Allow: ${entry}`);
  for (const entry of disallow) lines.push(`Disallow: ${entry}`);
  if (config.sitemap !== false) lines.push(`Sitemap: ${origin}/sitemap.xml`);
  return `${lines.join('\n')}\n`;
}
