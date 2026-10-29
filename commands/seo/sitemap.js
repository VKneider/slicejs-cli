// slice seo sitemap — write public/sitemap.xml (and robots.txt when the
// manifest asks for it) from seo.json.
//
// Both files are build artifacts a human commits: the command warns and asks
// before changing an existing file, `--yes` skips the question, and a
// non-interactive run fails instead of hanging.

import path from 'node:path';
import Print from '../Print.js';
import {
  MANIFEST_FILE,
  ROBOTS_FILE,
  SITEMAP_FILE,
  buildRobotsTxt,
  loadFrameworkSeo,
  loadManifest,
  loadSeoTranslator,
  writeFileConfirmed
} from './support.js';

const LOCAL_ORIGIN = /localhost|127\.0\.0\.1|0\.0\.0\.0|\.local\b/i;

/**
 * Pure-ish core (everything injectable) so the tests do not need a real CLI.
 * @returns {Promise<{ errors: string[], warnings: string[], files: Array<{file: string, status: string}> }>}
 */
export async function generateSeoFiles(options = {}) {
  const { projectRoot, yes = false, dryRun = false, confirm = null } = options;
  const framework = options.framework || await loadFrameworkSeo(projectRoot);
  const manifest = options.manifest || loadManifest(projectRoot).manifest;

  if (!manifest) {
    return { errors: [`${MANIFEST_FILE} not found in ${projectRoot}`], warnings: [], files: [] };
  }

  const { errors, warnings } = framework.validateSeoManifest(manifest, {
    publicDir: path.join(projectRoot, 'src', 'public'),
    translator: await loadSeoTranslator(projectRoot, framework)
  });

  // A sitemap written with localhost URLs is a deploy bug, not a warning.
  if (framework.normalizeOrigin(manifest.origin) && LOCAL_ORIGIN.test(manifest.origin)) {
    errors.push('origin points at localhost: refusing to write a sitemap with local URLs');
  }
  if (errors.length) return { errors, warnings, files: [] };

  const origin = framework.normalizeOrigin(manifest.origin);
  const translator = await loadSeoTranslator(projectRoot, framework);
  const files = [];

  files.push(await writeFileConfirmed(
    path.join(projectRoot, SITEMAP_FILE),
    framework.buildSitemap({ manifest, origin, translator }),
    { yes, dryRun, confirm }
  ));

  const robots = buildRobotsTxt(manifest, origin);
  if (robots) {
    files.push(await writeFileConfirmed(
      path.join(projectRoot, ROBOTS_FILE),
      robots,
      { yes, dryRun, confirm }
    ));
  }

  return { errors, warnings, files };
}

const STATUS_LABEL = {
  created: 'created',
  updated: 'updated',
  unchanged: 'unchanged (not rewritten)',
  skipped: 'skipped (you said no)',
  'would-change': 'would change',
  'needs-confirmation': 'needs confirmation (re-run with --yes)'
};

export default async function sitemapCommand(options = {}, projectRoot) {
  try {
    const result = await generateSeoFiles({ projectRoot, ...options });

    for (const warning of result.warnings) Print.warning(warning);
    if (result.errors.length) {
      for (const error of result.errors) Print.error(error);
      process.exitCode = 1;
      return;
    }

    for (const entry of result.files) {
      const label = STATUS_LABEL[entry.status] || entry.status;
      const message = `${path.relative(projectRoot, entry.file)}: ${label}`;
      if (entry.status === 'created' || entry.status === 'updated') Print.success(message);
      else if (entry.status === 'unchanged') Print.info(message);
      else if (entry.status === 'would-change') Print.info(message);
      else {
        Print.warning(message);
        if (entry.status === 'needs-confirmation') process.exitCode = 1;
      }
    }

    if (result.files.some((entry) => entry.status === 'skipped')) {
      Print.info('Nothing written. Re-run with --yes to overwrite.');
      process.exitCode = 1;
    }
  } catch (error) {
    Print.error('slice seo sitemap failed:', error.message);
    process.exitCode = 1;
  }
}
