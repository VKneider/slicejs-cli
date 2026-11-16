// commands/export/prerender.js
import fs from 'fs-extra';
import path from 'path';

export const PARAM_ROUTE = /\$\{[^}]+\}/;

/**
 * `slice export` needs a framework new enough to expose prepareSeo's
 * pages/notFound/redirects and expandPatternPaths. Import lazily so a CLI
 * installed with an older framework still runs every other command.
 */
async function loadExportFramework() {
  let serverModule;
  let seoModule;
  try {
    serverModule = await import('slicejs-web-framework/api/framework/server.js');
    seoModule = await import('slicejs-web-framework/api/framework/seo.js');
  } catch (error) {
    throw new Error(
      `slice export needs a slicejs-web-framework with prepareSeo pages/notFound/redirects and expandPatternPaths. Update it with "npm install slicejs-web-framework@latest". ${error.message}`
    );
  }

  const prepareSeo = serverModule?.prepareSeo;
  const expandPatternPaths = seoModule?.expandPatternPaths;
  if (typeof prepareSeo !== 'function' || typeof expandPatternPaths !== 'function') {
    throw new Error(
      'The installed slicejs-web-framework is too old for slice export: prepareSeo must expose pages/notFound/redirects and seo.js must export expandPatternPaths. Update it with "npm install slicejs-web-framework@latest".'
    );
  }

  return { prepareSeo, expandPatternPaths };
}

async function findSeoManifest(projectRoot, distDir, options) {
  const candidates = [];
  if (options.seo) candidates.push(options.seo);
  candidates.push(
    'seo.json',
    'src/public/seo.json',
    'src/seo.json',
    path.join(distDir, 'public', 'seo.json'),
    path.join(distDir, 'seo.json')
  );
  for (const candidate of candidates) {
    const full = path.isAbsolute(candidate) ? candidate : path.resolve(projectRoot, candidate);
    if (await fs.pathExists(full)) return full;
  }
  return null;
}

async function findImagesManifest(projectRoot, distDir, options) {
  const candidates = [];
  if (options.images) candidates.push(options.images);
  candidates.push(
    'src/public/og/manifest.json',
    path.join(distDir, 'public', 'og', 'manifest.json')
  );
  for (const candidate of candidates) {
    const full = path.isAbsolute(candidate) ? candidate : path.resolve(projectRoot, candidate);
    if (await fs.pathExists(full)) return full;
  }
  return null;
}

export async function buildPrerender(projectRoot, distDir, options) {
  if (options.prerender === false) return null;

  const seoFile = await findSeoManifest(projectRoot, distDir, options);
  if (!seoFile) return null;

  const imagesFile = await findImagesManifest(projectRoot, distDir, options);
  const { prepareSeo, expandPatternPaths } = await loadExportFramework();
  const seo = await prepareSeo({
    projectRoot,
    mode: 'production',
    port: options.port ? Number(options.port) : undefined,
    seo: {
      manifest: seoFile,
      ...(options.origin ? { origin: options.origin } : {}),
      ...(imagesFile ? { images: imagesFile } : {})
    }
  });
  if (!seo) return null;

  if (!(seo.pages instanceof Map) || !(seo.notFound instanceof Map) || !Array.isArray(seo.redirects)) {
    throw new Error(
      'prepareSeo() from the installed slicejs-web-framework did not return pages/notFound/redirects. Update it with "npm install slicejs-web-framework@latest".'
    );
  }

  // A `${param}` route cannot be enumerated unless it opts in with sitemap.paths.
  const pages = new Map(seo.pages);
  const locales = seo.translator?.enabled ? seo.translator.locales : [null];
  let patternsSkipped = 0;

  for (const route of seo.routes) {
    if (!PARAM_ROUTE.test(route.path)) continue;
    const values = seo.manifest.routes?.[route.path]?.sitemap?.paths;
    const concretePaths = expandPatternPaths(route.path, values);
    if (concretePaths.length === 0) {
      patternsSkipped += 1;
      continue;
    }
    for (const concrete of concretePaths) {
      for (const locale of locales) {
        const url = seo.translator?.enabled ? seo.translator.localize(concrete, locale) : concrete;
        if (pages.has(url)) continue;
        const result = seo.resolve(url);
        if (result.status === 200 && result.page) pages.set(url, result.page);
      }
    }
  }

  return {
    seo,
    pages,
    patternsSkipped,
    localeCount: seo.translator?.enabled ? seo.translator.locales.length : 0
  };
}
