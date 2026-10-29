// `slice translator init` — add the translator block to sliceConfig and create the
// dictionaries folder. Idempotent: existing values and files are never overwritten.

import fs from 'node:fs';
import path from 'node:path';
import Print from '../Print.js';

/**
 * @returns {{ errors: string[], files: Array<{file: string, status: string}>, configFile: string }}
 */
export function initTranslatorFiles(options = {}) {
  const { projectRoot, dryRun = false, localePath = '/locales' } = options;
  const locales = (Array.isArray(options.locales) ? options.locales : [options.locales || 'en'])
    .map((value) => String(value).trim())
    .filter(Boolean);
  const defaultLocale = options.defaultLocale || locales[0] || 'en';
  const errors = [];
  const files = [];

  const configFile = path.join(projectRoot, 'src', 'sliceConfig.json');
  if (!fs.existsSync(configFile)) {
    return { errors: ['src/sliceConfig.json not found: run `slice init` first'], files, configFile };
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (error) {
    return { errors: [`src/sliceConfig.json is not valid JSON: ${error.message}`], files, configFile };
  }

  const existing = config.translator && typeof config.translator === 'object' ? config.translator : null;
  const declared = [...new Set([
    existing?.defaultLocale || defaultLocale,
    ...(Array.isArray(existing?.locales) ? existing.locales : []),
    ...locales
  ])];
  const translator = existing
    ? {
      ...existing,
      enabled: true,
      defaultLocale: existing.defaultLocale || defaultLocale,
      locales: declared,
      path: existing.path || localePath
    }
    : {
      enabled: true,
      defaultLocale,
      locales: declared,
      path: localePath,
      saveLocally: true,
      useBrowserLocale: true,
      routing: false
    };
  const next = { ...config, translator };

  const before = fs.readFileSync(configFile, 'utf8');
  const after = `${JSON.stringify(next, null, 2)}\n`;
  const alreadyConfigured = existing?.enabled === true
    && existing.defaultLocale
    && existing.path
    && Array.isArray(existing.locales)
    && JSON.stringify(existing.locales) === JSON.stringify(declared);
  if (alreadyConfigured) {
    // Nothing to add: never reformat a config that is already set up.
    files.push({ file: configFile, status: 'unchanged' });
  } else if (before !== after) {
    if (!dryRun) fs.writeFileSync(configFile, after);
    files.push({ file: configFile, status: dryRun ? 'would-change' : 'updated' });
  } else {
    files.push({ file: configFile, status: 'unchanged' });
  }

  const folder = String(next.translator.path || '/locales').replace(/^\/+|\/+$/g, '') || 'locales';
  for (const locale of new Set([next.translator.defaultLocale, ...(next.translator.locales || [])])) {
    const file = path.join(projectRoot, 'src', folder, `${locale}.json`);
    if (fs.existsSync(file)) {
      files.push({ file, status: 'exists' });
      continue;
    }
    if (!dryRun) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{}\n');
    }
    files.push({ file, status: dryRun ? 'would-create' : 'created' });
  }

  return { errors, files, configFile };
}

export default async function initCommand(options = {}, projectRoot) {
  try {
    const locales = String(options.locales || options.locale || 'en')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const result = initTranslatorFiles({
      projectRoot,
      locales,
      defaultLocale: options.default,
      localePath: options.path,
      dryRun: options.dryRun === true
    });

    if (result.errors.length) {
      for (const error of result.errors) Print.error(error);
      process.exitCode = 1;
      return;
    }

    for (const entry of result.files) {
      const name = path.relative(projectRoot, entry.file);
      if (entry.status === 'created' || entry.status === 'updated') Print.success(`${name}: ${entry.status}`);
      else if (entry.status === 'would-create' || entry.status === 'would-change') Print.info(`${name}: ${entry.status}`);
      else Print.info(`${name}: ${entry.status}`);
    }

    Print.info('Dictionaries live in that folder; templates use data-t="key" and code uses slice.t("key").');
    Print.info('Next: `slice translator check`.');
  } catch (error) {
    Print.error('slice translator init failed:', error.message);
    process.exitCode = 1;
  }
}
