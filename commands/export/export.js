// commands/export/export.js
//
// `slice export`: turn the production build into a folder a static host can serve
// without Express. It flattens dist/public to the root, creates the root
// index.html, copies the build-time env artifacts, prerenders every literal SEO
// route (plus sitemap.paths patterns), emits a real 404.html and writes the host
// rules.
import fs from 'fs-extra';
import path from 'path';
import Print from '../Print.js';
import { getProjectRoot, getDistPath } from '../utils/PathHelper.js';
import { writeSliceEnv, writeSliceEnvPayload } from '../utils/publicEnv.js';
import build from '../build/build.js';
import { prepareSeo } from 'slicejs-web-framework/api/framework/server.js';
import { expandPatternPaths } from 'slicejs-web-framework/api/framework/seo.js';

const HOSTS = new Set(['cloudflare', 'netlify', 'vercel', 'nginx', 'github', 's3', 'none']);

function normalizeHost(value) {
  const host = String(value || 'cloudflare').toLowerCase();
  if (!HOSTS.has(host)) {
    throw new Error(`Unknown host "${value}". Use one of: ${[...HOSTS].join(', ')}.`);
  }
  return host;
}

async function listFiles(dir, base = dir) {
  const files = [];
  for (const entry of await fs.readdir(dir)) {
    const full = path.join(dir, entry);
    const stat = await fs.stat(full);
    if (stat.isDirectory()) {
      files.push(...await listFiles(full, base));
    } else {
      files.push({ path: path.relative(base, full).replace(/\\/g, '/'), size: stat.size });
    }
  }
  return files;
}

function shouldSkip(filePath) {
  return filePath.endsWith('.map') || filePath.endsWith('.d.ts');
}

async function flattenPublic(outDir) {
  const publicDir = path.join(outDir, 'public');
  if (!await fs.pathExists(publicDir)) return;

  for (const entry of await fs.readdir(publicDir)) {
    await fs.copy(path.join(publicDir, entry), path.join(outDir, entry), { overwrite: true });
  }
  await fs.remove(publicDir);
}

async function ensureEnv(outDir, projectRoot) {
  const envPath = path.join(outDir, 'slice-env.json');
  if (await fs.pathExists(envPath)) {
    const payload = JSON.parse(await fs.readFile(envPath, 'utf8'));
    // Re-emit both artifacts so an older build gets the ESM shim too.
    await writeSliceEnvPayload(outDir, payload);
    return Object.keys(payload.env || {}).length;
  }
  // Older builds (before env moved into `slice build`) get the files here.
  return writeSliceEnv(outDir, projectRoot);
}

function pagePathForUrl(url) {
  const clean = String(url).split(/[?#]/)[0].replace(/^\/+|\/+$/g, '');
  if (!clean) return 'index.html';
  const normalized = path.normalize(clean);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error(`Refusing to export an unsafe route: ${url}`);
  }
  return path.join(normalized, 'index.html');
}

async function writePage(outDir, url, page) {
  const file = path.join(outDir, pagePathForUrl(url));
  await fs.ensureDir(path.dirname(file));
  await fs.writeFile(file, page.html);
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

const HEADER_RULES = `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
/bundles/*
  Cache-Control: no-store
/slice-env.json
  Cache-Control: no-store
/slice-env.generated.js
  Cache-Control: no-store
`;

function redirectLines(redirects) {
  return redirects.map(({ from, to, status }) => `${from}  ${to}  ${status}`).join('\n');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clientRedirectHtml(to, origin) {
  const absolute = /^https?:\/\//i.test(to) ? to : `${origin}${to}`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Redirecting…</title>
  <link rel="canonical" href="${escapeHtml(absolute)}">
  <meta name="robots" content="noindex">
  <meta http-equiv="refresh" content="0; url=${escapeHtml(to)}">
</head>
<body>
  <p>Redirecting to <a href="${escapeHtml(to)}">${escapeHtml(to)}</a>…</p>
</body>
</html>
`;
}

async function writeClientRedirects(outDir, redirects, origin, { allowRoot = false } = {}) {
  let written = 0;
  const skipped = [];
  for (const { from, to } of redirects) {
    const file = path.join(outDir, pagePathForUrl(from));
    if (await fs.pathExists(file)) {
      if (!(allowRoot && from === '/')) {
        // A canonical page already owns this path; do not replace it with a redirect.
        skipped.push(from);
        continue;
      }
    }
    await fs.ensureDir(path.dirname(file));
    await fs.writeFile(file, clientRedirectHtml(to, origin), 'utf8');
    written += 1;
  }
  return { written, skipped };
}

async function writeHostRules(outDir, host, redirects = [], { spa = false } = {}) {
  const written = [];
  const warnings = [];

  if (host === 'cloudflare' || host === 'netlify') {
    const redirectBlock = redirects.length ? `${redirectLines(redirects)}\n` : '';
    const spaBlock = spa ? '/*  /index.html  200\n' : '';
    await fs.writeFile(path.join(outDir, '_redirects'), `${redirectBlock}${spaBlock}`, 'utf8');
    await fs.writeFile(path.join(outDir, '_headers'), HEADER_RULES, 'utf8');
    written.push('_redirects', '_headers');
  } else if (host === 'vercel') {
    const vercel = {
      headers: [
        {
          source: '/bundles/(.*)',
          headers: [{ key: 'Cache-Control', value: 'no-store' }]
        },
        {
          source: '/slice-env.json',
          headers: [{ key: 'Cache-Control', value: 'no-store' }]
        },
        {
          source: '/slice-env.generated.js',
          headers: [{ key: 'Cache-Control', value: 'no-store' }]
        }
      ]
    };
    if (spa) {
      vercel.rewrites = [{ source: '/(.*)', destination: '/index.html' }];
    }
    if (redirects.length) {
      vercel.redirects = redirects.map(({ from, to, status }) => ({
        source: from,
        destination: to,
        permanent: status === 301
      }));
    }
    await fs.writeFile(path.join(outDir, 'vercel.json'), `${JSON.stringify(vercel, null, 2)}\n`, 'utf8');
    written.push('vercel.json');
  } else if (host === 'nginx') {
    const redirectBlock = redirects
      .map(({ from, to, status }) => `location = ${from} {\n  return ${status} ${to};\n}\n`)
      .join('\n');
    const fallback = spa ? 'try_files $uri $uri/ /index.html;' : 'try_files $uri $uri/ =404;';
    const nginx = `root /var/www/dist-static;
index index.html;

${redirectBlock}location / {
  ${fallback}
}

error_page 404 /404.html;

location /bundles/ {
  add_header Cache-Control "no-store";
}

location = /slice-env.json {
  add_header Cache-Control "no-store";
}

location = /slice-env.generated.js {
  add_header Cache-Control "no-store";
}
`;
    await fs.writeFile(path.join(outDir, 'nginx.conf'), nginx, 'utf8');
    written.push('nginx.conf');
  } else if (host === 'github') {
    await fs.writeFile(path.join(outDir, '.nojekyll'), '', 'utf8');
    written.push('.nojekyll');
  }

  return { written, warnings };
}

async function checkExport(outDir) {
  const issues = [];
  const required = [
    'index.html',
    '404.html',
    'slice-env.json',
    'slice-env.generated.js',
    'bundles/bundle.config.json',
    'Slice/Slice.js'
  ];

  for (const file of required) {
    if (!await fs.pathExists(path.join(outDir, file))) {
      issues.push(`Missing ${file}`);
    }
  }

  if (await fs.pathExists(outDir)) {
    const files = await listFiles(outDir);
    for (const file of files) {
      if (file.path.endsWith('.map')) issues.push(`Source map in export: ${file.path}`);
      if (file.path.endsWith('.d.ts')) issues.push(`Type declaration in export: ${file.path}`);
    }
  }

  return issues;
}

async function buildPrerender(projectRoot, distDir, options) {
  if (options.prerender === false) return null;

  const seoFile = await findSeoManifest(projectRoot, distDir, options);
  if (!seoFile) return null;

  const imagesFile = await findImagesManifest(projectRoot, distDir, options);
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

  // A `${param}` route cannot be enumerated unless it opts in with sitemap.paths.
  const pages = new Map(seo.pages);
  const locales = seo.translator?.enabled ? seo.translator.locales : [null];
  let patternsSkipped = 0;

  for (const route of seo.routes) {
    if (!/\$\{[^}]+\}/.test(route.path)) continue;
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

export default async function exportStatic(options = {}) {
  const projectRoot = getProjectRoot(import.meta.url);
  const distDir = getDistPath(import.meta.url);
  const outDir = path.resolve(projectRoot, options.out || 'dist-static');
  const checkOnly = Boolean(options.check);
  const dryRun = Boolean(options.dryRun);

  try {
    const host = normalizeHost(options.host);
    if (checkOnly) {
      Print.title('Static export check');
      const issues = await checkExport(outDir);
      if (issues.length > 0) {
        for (const issue of issues) Print.error(issue);
        return false;
      }
      Print.success(`Export looks valid: ${path.relative(projectRoot, outDir)}`);
      return true;
    }

    if (!options.fromDist) {
      const built = await build({
        minify: options.minify,
        obfuscate: options.obfuscate,
        sourcemap: options.sourcemap,
        hashFilenames: options.hashFilenames,
        compress: options.compress
      });
      if (built === false) return false;
    }

    if (!await fs.pathExists(distDir)) {
      throw new Error('No dist/ found. Run "slice build" first, or drop --from-dist.');
    }
    if (!await fs.pathExists(path.join(distDir, 'App', 'index.html'))) {
      throw new Error('dist/App/index.html is missing. Run "slice build" again.');
    }

    const prerender = await buildPrerender(projectRoot, distDir, options);

    if (dryRun) {
      Print.title('Static export (dry run)');
      Print.info(`Would write ${path.relative(projectRoot, outDir)} from ${path.relative(projectRoot, distDir)}.`);
      Print.info(`Host rules: ${host}`);
      if (prerender) {
        Print.info(`${prerender.pages.size} route(s) would be prerendered`);
        if (prerender.seo.redirects.length) {
          Print.info(`${prerender.seo.redirects.length} locale redirect(s)`);
        }
      } else {
        Print.info('No SEO manifest; the SPA shell would be the only page.');
      }
      return true;
    }

    await fs.remove(outDir);
    await fs.copy(distDir, outDir, {
      filter: (src) => !shouldSkip(src)
    });

    await flattenPublic(outDir);

    const rootIndex = path.join(outDir, 'index.html');
    let pagesWritten = 0;

    if (prerender) {
      for (const [url, page] of prerender.pages) {
        await writePage(outDir, url, page);
        pagesWritten += 1;
      }
    }

    if (!await fs.pathExists(rootIndex)) {
      await fs.copy(path.join(outDir, 'App', 'index.html'), rootIndex);
    }

    const notFoundPage = prerender
      ? (prerender.seo.notFound.get(null) || [...prerender.seo.notFound.values()][0])
      : null;
    if (notFoundPage) {
      await fs.writeFile(path.join(outDir, '404.html'), notFoundPage.html);
    } else {
      await fs.copy(rootIndex, path.join(outDir, '404.html'));
    }

    const envKeys = await ensureEnv(outDir, projectRoot);
    const redirects = prerender?.seo.redirects || [];
    const spa = options.spa === true || !prerender;
    const hostRules = await writeHostRules(outDir, host, redirects, { spa });

    // Hosts without server-side redirect syntax get portable HTML redirect files.
    const clientHosts = new Set(['github', 's3', 'none']);
    let clientRedirects = { written: 0, skipped: [] };
    if (clientHosts.has(host) && redirects.length) {
      clientRedirects = await writeClientRedirects(
        outDir,
        redirects,
        prerender?.seo.origin || '',
        { allowRoot: !prerender?.pages.has('/') }
      );
    }
    const files = await listFiles(outDir);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

    Print.title('Static export');
    Print.success(`Exported to ${path.relative(projectRoot, outDir) || '.'}`);
    Print.info(`${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

    if (prerender) {
      const localeLabel = prerender.localeCount ? ` (${prerender.localeCount} locales)` : '';
      Print.info(`${pagesWritten} route(s) prerendered${localeLabel}`);
      Print.info(`404.html${notFoundPage ? ' (noindex)' : ''}`);
      if (redirects.length) Print.info(`${redirects.length} locale redirect(s)`);
      if (prerender.patternsSkipped) {
        Print.warning(`${prerender.patternsSkipped} dynamic route(s) not prerendered; add sitemap.paths or pass --spa.`);
      }
    } else if (options.prerender === false) {
      Print.warning('Prerender disabled; using the SPA shell (soft 404).');
    } else {
      Print.warning('No seo.json found; using the SPA shell (soft 404).');
    }

    Print.info(`Public env: ${envKeys} key(s) (JSON + ESM)`);
    Print.info(`Host rules: ${hostRules.written.length ? hostRules.written.join(', ') : 'none'}`);
    Print.info(`SPA fallback: ${spa ? 'yes (unknown routes -> index.html)' : 'no (unknown routes -> 404.html)'}`);
    if (clientRedirects.written) {
      Print.info(`${clientRedirects.written} client redirect page(s)`);
    }
    for (const skipped of clientRedirects.skipped) {
      Print.warning(`Redirect path already has a page; kept the page: ${skipped}`);
    }
    for (const warning of hostRules.warnings) Print.warning(warning);

    Print.newLine();
    Print.subtitle('Next step');
    Print.commandExample('Serve the export locally', `npx serve -s ${path.relative(projectRoot, outDir) || '.'}`);
    return true;
  } catch (error) {
    Print.error(`Static export failed: ${error.message}`);
    Print.stack(error);
    return false;
  }
}
