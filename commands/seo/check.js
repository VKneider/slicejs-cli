// slice seo check — the strict, exit-code-1 gate for CI:
//   1. validates seo.json (same validator the server uses),
//   2. cross-checks it against routes.js,
//   3. compares the committed sitemap against what the manifest would produce.
//
// `slice doctor` reports the same information in a friendlier table; this one
// is meant to fail a pipeline.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Print from '../Print.js';
import {
  MANIFEST_FILE,
  SITEMAP_FILE,
  loadFrameworkSeo,
  loadManifest
} from './support.js';

export async function loadRoutes(projectRoot) {
  const candidates = [
    path.join(projectRoot, 'src', 'routes.js'),
    path.join(projectRoot, 'dist', 'routes.js')
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const module = await import(pathToFileURL(candidate).href);
    const routes = module.default ?? module.routes ?? [];
    return Array.isArray(routes) ? routes : [];
  }
  return [];
}

/** @returns {Promise<{ errors: string[], warnings: string[], sitemap: string }>} */
export async function checkSeo(options = {}) {
  const { projectRoot } = options;
  const framework = options.framework || await loadFrameworkSeo(projectRoot);
  const manifest = options.manifest || loadManifest(projectRoot).manifest;

  if (!manifest) {
    return { errors: [`${MANIFEST_FILE} not found in ${projectRoot}`], warnings: [], sitemap: 'missing' };
  }

  const routes = options.routes || await loadRoutes(projectRoot);
  const { errors, warnings } = framework.validateSeoManifest(manifest, {
    routes,
    publicDir: path.join(projectRoot, 'src', 'public')
  });

  let sitemap = 'ok';
  if (manifest.sitemap === false) {
    sitemap = 'disabled';
  } else {
    const file = path.join(projectRoot, SITEMAP_FILE);
    if (!fs.existsSync(file)) {
      sitemap = 'missing';
      errors.push(`${SITEMAP_FILE} is missing: run \`slice seo sitemap\``);
    } else {
      const origin = framework.normalizeOrigin(manifest.origin);
      const expected = origin ? framework.buildSitemap({ manifest, origin }) : null;
      if (expected !== null && fs.readFileSync(file, 'utf8') !== expected) {
        sitemap = 'drifted';
        errors.push(`${SITEMAP_FILE} is out of date: run \`slice seo sitemap\``);
      }
    }
  }

  return { errors, warnings, sitemap, routes: routes.length };
}

export default async function checkCommand(options = {}, projectRoot) {
  try {
    const result = await checkSeo({ projectRoot, ...options });

    for (const warning of result.warnings) Print.warning(warning);

    if (result.errors.length) {
      for (const error of result.errors) Print.error(error);
      Print.error(`SEO check failed: ${result.errors.length} problem(s).`);
      process.exitCode = 1;
      return;
    }

    Print.success(
      `SEO OK: sitemap ${result.sitemap}, ${result.routes} route(s) cross-checked.`
    );
  } catch (error) {
    Print.error('slice seo check failed:', error.message);
    process.exitCode = 1;
  }
}
