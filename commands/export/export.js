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

const HOSTS = new Set(['cloudflare', 'netlify', 'vercel', 'nginx', 'github', 's3', 'none']);
const PARAM_ROUTE = /\$\{[^}]+\}/;

// Everything a static host is allowed to see. The export is an allowlist, not a
// copy of `dist/` minus a denylist: `dist/` also holds source (Components/),
// helpers (utils/), AppConfig.js, generated declarations and env files. Express
// production only serves a subset of `dist/`; the export must match it.
const EXPORT_ROOT_FILES = new Set([
  'routes.js',
  'sliceConfig.json',
  'slice-env.json',
  'slice-env.generated.js',
  'robots.txt',
  'sitemap.xml',
  'manifest.json',
  'service-worker.js'
]);

const EXPORT_DIRS = new Set(['App', 'bundles', 'Slice', 'locales', 'events']);

// Files the exporter writes itself. `dist/public` is flattened to the root, but
// Express answers these paths with explicit routes before its static middleware,
// so a file with the same name in public/ must not replace them.
const RESERVED_ROOT_FILES = new Set([
  'index.html',
  '404.html',
  'routes.js',
  'sliceConfig.json',
  'slice-env.json',
  'slice-env.generated.js',
  'manifest.json',
  'service-worker.js'
]);

const PROTECTED_OUT_DIRS = new Set([
  'src',
  'dist',
  'api',
  'node_modules',
  '.git',
  'public',
  'locales',
  'components',
  'app',
  'bundles',
  'slice'
]);

const BLOCKED_SEGMENTS = new Set(['node_modules', '.git']);
const BLOCKED_FILES = /(?:^|\/)(?:\.env(?:\.[^/]+)?|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json)$/i;
const BLOCKED_ARTIFACTS = /\.(?:map(?:\.(?:br|gz))?|d\.ts)$/i;

function normalizeHost(value) {
  const host = String(value || 'cloudflare').toLowerCase();
  if (!HOSTS.has(host)) {
    throw new Error(`Unknown host "${value}". Use one of: ${[...HOSTS].join(', ')}.`);
  }
  return host;
}

function isExportableFile(relativePath) {
  const normalized = String(relativePath).replace(/\\/g, '/');
  if (!normalized) return true;
  const segments = normalized.toLowerCase().split('/');
  if (segments.some((segment) => BLOCKED_SEGMENTS.has(segment))) return false;
  if (BLOCKED_FILES.test(normalized)) return false;
  if (BLOCKED_ARTIFACTS.test(normalized)) return false;
  return true;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function nearestExistingAncestor(target) {
  let current = target;
  while (!await fs.pathExists(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/**
 * `slice export --out` runs `fs.remove()` on the target. Validate it before any
 * write, so a typo like `--out .` or `--out src` cannot delete the project.
 */
async function resolveSafeOutDir(projectRoot, outOption) {
  const requested = outOption == null || outOption === '' ? 'dist-static' : String(outOption);
  const outDir = path.resolve(projectRoot, requested);
  const relative = path.relative(projectRoot, outDir);

  if (relative === '') {
    throw new Error('Refusing to export into the project root. Use a dedicated folder such as dist-static.');
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to export outside the project: ${outDir}`);
  }
  if (isInside(outDir, projectRoot)) {
    throw new Error(`Refusing to export into an ancestor of the project: ${outDir}`);
  }

  const topLevel = relative.split(path.sep)[0];
  if (PROTECTED_OUT_DIRS.has(topLevel.toLowerCase())) {
    throw new Error(
      `Refusing to export into ${topLevel}/: it holds source, build or runtime files. Use a dedicated folder such as dist-static.`
    );
  }

  if (await fs.pathExists(outDir)) {
    const stat = await fs.lstat(outDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing to overwrite ${outDir}: the output path is not a directory.`);
    }

    // Existing folders are only overwritten when they look like a previous
    // export. This protects `docs/`, `tests/`, `.github/` and any other real
    // project folder from a mistyped `--out`.
    const markers = await Promise.all([
      fs.pathExists(path.join(outDir, 'index.html')),
      fs.pathExists(path.join(outDir, 'bundles', 'bundle.config.json')),
      fs.pathExists(path.join(outDir, 'slice-env.json'))
    ]);
    if (!markers.some(Boolean)) {
      throw new Error(
        `Refusing to overwrite ${outDir}: it exists but does not look like a previous export. Remove it or choose a new --out folder.`
      );
    }
  }

  // A parent folder can be a symlink that points outside the project even when
  // the textual path is inside it. Resolve the nearest existing ancestor before
  // allowing `fs.remove()` to run.
  const realProject = await fs.realpath(projectRoot);
  const realExisting = await fs.realpath(await nearestExistingAncestor(outDir));
  if (!isInside(realProject, realExisting)) {
    throw new Error(`Refusing to export through a symlink that leaves the project: ${outDir}`);
  }

  return outDir;
}

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

/**
 * Copy only the parts of `dist/` that Express production serves: the shell
 * (`App/`), bundles, runtime, dictionaries, events and the public folder.
 * `Components/` is opt-in for debugging; everything else is skipped.
 */
async function copyDist(outDir, distDir, { keepComponents, skipped }) {
  const filter = (src) => {
    const relative = path.relative(distDir, src);
    return isExportableFile(relative);
  };

  for (const entry of await fs.readdir(distDir, { withFileTypes: true })) {
    const name = entry.name;
    const from = path.join(distDir, name);

    if (entry.isDirectory()) {
      if (name === 'public') {
        await fs.copy(from, path.join(outDir, 'public'), { filter });
        continue;
      }
      if (name === 'Components' && !keepComponents) {
        skipped.push('Components/');
        continue;
      }
      if (!EXPORT_DIRS.has(name) && name !== 'Components') {
        skipped.push(`${name}/`);
        continue;
      }
      await fs.copy(from, path.join(outDir, name), { filter });
      continue;
    }

    if (!entry.isFile()) continue;
    if (!EXPORT_ROOT_FILES.has(name)) {
      skipped.push(name);
      continue;
    }
    if (!isExportableFile(name)) continue;
    await fs.copy(from, path.join(outDir, name), { overwrite: true });
  }
}

async function flattenPublic(outDir) {
  const publicDir = path.join(outDir, 'public');
  if (!await fs.pathExists(publicDir)) return 0;

  let copied = 0;
  for (const entry of await fs.readdir(publicDir, { withFileTypes: true })) {
    if (RESERVED_ROOT_FILES.has(entry.name)) continue;
    await fs.copy(path.join(publicDir, entry.name), path.join(outDir, entry.name), { overwrite: true });
    copied += 1;
  }
  await fs.remove(publicDir);
  return copied;
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

  if (host === 'cloudflare') {
    // Cloudflare Pages treats `/* /index.html 200` as an infinite loop (it
    // normalizes `/index.html` to `/`, which matches `/*` again) and ignores it.
    // `/* / 200` is accepted but hijacks every asset. Cloudflare's own SPA mode
    // is enabled by *not* shipping a top-level 404.html, so `--spa` is handled
    // by omitting that file instead of writing a catch-all.
    const redirectBlock = redirects.length ? `${redirectLines(redirects)}\n` : '';
    await fs.writeFile(path.join(outDir, '_redirects'), redirectBlock, 'utf8');
    await fs.writeFile(path.join(outDir, '_headers'), HEADER_RULES, 'utf8');
    written.push('_redirects', '_headers');
  } else if (host === 'netlify') {
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
      // Vercel's `permanent` boolean maps to 308/307, not 301/302. Use
      // `statusCode` to preserve the status the SEO context decided.
      vercel.redirects = redirects.map(({ from, to, status }) => ({
        source: from,
        destination: to,
        statusCode: status
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

async function readJsonIfExists(file) {
  if (!await fs.pathExists(file)) return null;
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function hasSpaFallback(outDir) {
  const redirectsFile = path.join(outDir, '_redirects');
  const has404 = await fs.pathExists(path.join(outDir, '404.html'));
  if (await fs.pathExists(redirectsFile)) {
    const text = await fs.readFile(redirectsFile, 'utf8');
    // Cloudflare Pages enables its own SPA mode when there is no top-level
    // 404.html; no catch-all rule is written in that case.
    if (!has404) return true;
    if (/^\s*\/\*\s+\/index\.html\s+200\s*$/m.test(text)) return true;
  }

  const vercelFile = path.join(outDir, 'vercel.json');
  const vercel = await readJsonIfExists(vercelFile);
  if (vercel) {
    const rewrites = Array.isArray(vercel.rewrites) ? vercel.rewrites : [];
    if (rewrites.some((rewrite) => rewrite?.destination === '/index.html')) return true;
  }

  const nginxFile = path.join(outDir, 'nginx.conf');
  if (await fs.pathExists(nginxFile)) {
    const text = await fs.readFile(nginxFile, 'utf8');
    if (/try_files\s+\$uri\s+\$uri\/\s+\/index\.html/.test(text)) return true;
  }

  return false;
}

function routeCandidatesForCheck(pathname, translator) {
  if (!translator?.enabled) return [pathname];
  const locales = Array.isArray(translator.locales) && translator.locales.length
    ? translator.locales
    : [translator.defaultLocale || 'en'];
  const prefix = translator.localePrefix;
  if (prefix !== 'always' && prefix !== 'except-default') return [pathname];

  return locales.map((locale) => {
    if (prefix === 'except-default' && locale === (translator.defaultLocale || locales[0])) {
      return pathname;
    }
    const tail = pathname === '/' ? '' : pathname;
    return `/${locale}${tail}`;
  });
}

async function checkHostRules(outDir, explicitHost, issues) {
  const redirects = path.join(outDir, '_redirects');
  const headers = path.join(outDir, '_headers');
  const vercel = path.join(outDir, 'vercel.json');
  const nginx = path.join(outDir, 'nginx.conf');
  const nojekyll = path.join(outDir, '.nojekyll');

  const hasRedirects = await fs.pathExists(redirects);
  const hasHeaders = await fs.pathExists(headers);
  const hasVercel = await fs.pathExists(vercel);
  const hasNginx = await fs.pathExists(nginx);

  if (hasRedirects !== hasHeaders) {
    issues.push('_redirects and _headers must be written together (Cloudflare/Netlify).');
  }

  if (hasVercel && !await readJsonIfExists(vercel)) {
    issues.push('vercel.json is not valid JSON.');
  }

  if (hasNginx) {
    const text = await fs.readFile(nginx, 'utf8');
    if (!/error_page\s+404\s+\/404\.html/.test(text)) {
      issues.push('nginx.conf does not map 404 to /404.html.');
    }
  }

  if (explicitHost === 'github' && !await fs.pathExists(nojekyll)) {
    issues.push('GitHub Pages export is missing .nojekyll.');
  }
  if ((explicitHost === 'cloudflare' || explicitHost === 'netlify') && !hasRedirects) {
    issues.push(`${explicitHost} export is missing _redirects.`);
  }
  if (explicitHost === 'vercel' && !hasVercel) {
    issues.push('Vercel export is missing vercel.json.');
  }
  if (explicitHost === 'nginx' && !hasNginx) {
    issues.push('nginx export is missing nginx.conf.');
  }
}

/**
 * `--check` validates what the exporter promises: the runtime files exist, no
 * source/secret artifacts slipped in, host rules are coherent, and every
 * literal route has a prerendered page unless the export declares an SPA
 * fallback. It cannot validate dynamic `${param}` routes: list concrete values
 * in `seo.json -> routes[pattern].sitemap.paths` if you need pages for them.
 */
async function checkExport(outDir, { keepComponents = false, host } = {}) {
  const issues = [];
  const warnings = [];

  if (!await fs.pathExists(outDir)) {
    return { issues: [`Export directory not found: ${outDir}`], warnings };
  }

  const required = [
    'index.html',
    'routes.js',
    'sliceConfig.json',
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

  const has404 = await fs.pathExists(path.join(outDir, '404.html'));
  const hasRedirects = await fs.pathExists(path.join(outDir, '_redirects'));
  let redirectsCatchAll = false;
  if (hasRedirects) {
    const redirectsText = await fs.readFile(path.join(outDir, '_redirects'), 'utf8');
    redirectsCatchAll = /^\s*\/\*\s+\/index\.html\s+200\s*$/m.test(redirectsText);
  }
  // Cloudflare's SPA mode requires *no* top-level 404.html. Accept that shape
  // when the host is explicit, or when the export has _redirects without an SPA
  // catch-all (the Cloudflare preset).
  const cloudflareAutoSpa = !has404
    && (host === 'cloudflare' || (host == null && hasRedirects && !redirectsCatchAll));
  if (!has404 && !cloudflareAutoSpa) {
    issues.push('Missing 404.html');
  } else if (cloudflareAutoSpa) {
    warnings.push('No 404.html: Cloudflare Pages will serve index.html for unknown routes (SPA).');
  }

  if (!keepComponents && await fs.pathExists(path.join(outDir, 'Components'))) {
    issues.push('Components/ is present; component source is fetchable. Remove it or pass --keep-components.');
  }
  if (await fs.pathExists(path.join(outDir, 'public'))) {
    issues.push('public/ was not flattened; /Themes, /images and other public assets will 404.');
  }

  const suspectDirs = new Set(['utils', 'src', 'api', 'node_modules', '.git']);
  const suspectFiles = new Set([
    'appconfig.js',
    'slice-events.generated.js',
    'slice-build.generated.d.ts',
    'slice-runtime.generated.d.ts'
  ]);
  for (const entry of await fs.readdir(outDir, { withFileTypes: true })) {
    if (entry.isDirectory() && suspectDirs.has(entry.name.toLowerCase())) {
      issues.push(`Source/build directory in export: ${entry.name}/`);
    }
    if (entry.isFile() && suspectFiles.has(entry.name.toLowerCase())) {
      issues.push(`Source/build file in export: ${entry.name}`);
    }
  }

  const files = await listFiles(outDir);
  for (const file of files) {
    const relative = file.path;
    if (/\.map(?:\.(?:br|gz))?$/i.test(relative)) issues.push(`Source map in export: ${relative}`);
    if (/\.d\.ts$/i.test(relative)) issues.push(`Type declaration in export: ${relative}`);
    if (/(?:^|\/)\.env(?:\.[^/]+)?$/i.test(relative)) issues.push(`Env file in export: ${relative}`);
    if (/(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json)$/i.test(relative)) {
      issues.push(`Package manifest in export: ${relative}`);
    }
    if (/(?:^|\/)(?:node_modules|\.git)(?:\/|$)/.test(relative)) {
      issues.push(`Dependency or VCS folder in export: ${relative}`);
    }
    if (relative.endsWith('.js')) {
      const content = await fs.readFile(path.join(outDir, relative), 'utf8');
      if (/sourceMappingURL\s*=/.test(content)) {
        issues.push(`sourceMappingURL reference in export: ${relative}`);
      }
    }
  }

  await checkHostRules(outDir, host, issues);

  const routesFile = path.join(outDir, 'routes.js');
  if (await fs.pathExists(routesFile)) {
    const source = await fs.readFile(routesFile, 'utf8');
    const literalPaths = [...source.matchAll(/path\s*:\s*["'`]([^"'`]+)["'`]/g)]
      .map((match) => match[1])
      .filter((pathname) => pathname.startsWith('/') && !PARAM_ROUTE.test(pathname) && !pathname.includes('*'));

    if (literalPaths.length === 0) {
      warnings.push('Could not find literal routes in routes.js; route coverage was not checked.');
    } else if (!await hasSpaFallback(outDir)) {
      const config = await readJsonIfExists(path.join(outDir, 'sliceConfig.json'));
      for (const pathname of literalPaths) {
        const candidates = routeCandidatesForCheck(pathname, config?.translator);
        const present = [];
        for (const candidate of candidates) {
          if (await fs.pathExists(path.join(outDir, pagePathForUrl(candidate)))) present.push(candidate);
        }
        if (present.length === 0) {
          issues.push(
            `Route ${pathname} has no prerendered page and the export has no SPA fallback. Add sitemap.paths, prerender it, or pass --spa.`
          );
        } else if (present.length < candidates.length) {
          warnings.push(`Route ${pathname} is missing ${candidates.length - present.length} localized page(s).`);
        }
      }
    }
  }

  return { issues, warnings };
}

async function buildPrerender(projectRoot, distDir, options) {
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
  const checkOnly = Boolean(options.check);
  const dryRun = Boolean(options.dryRun);
  const keepComponents = Boolean(options.keepComponents);

  try {
    // `--check` only reads, so it can inspect any existing folder. Every write
    // path validates the target before touching it (a typo must not delete the
    // project).
    const outDir = checkOnly
      ? path.resolve(projectRoot, options.out || 'dist-static')
      : await resolveSafeOutDir(projectRoot, options.out);

    // Keep the difference between "no --host, use the default" and an explicit
    // `--host cloudflare` so `--check` can validate the right rule files.
    const explicitHost = options.host ? normalizeHost(options.host) : null;
    const host = explicitHost || 'cloudflare';

    if (checkOnly) {
      Print.title('Static export check');
      const { issues, warnings } = await checkExport(outDir, {
        keepComponents: options.keepComponents,
        host: explicitHost
      });
      for (const warning of warnings) Print.warning(warning);
      if (issues.length > 0) {
        for (const issue of issues) Print.error(issue);
        return false;
      }
      Print.success(`Export looks valid: ${path.relative(projectRoot, outDir)}`);
      return true;
    }

    if (options.sourcemap) {
      Print.warning('--sourcemap builds maps that the export filters out; they will not be published.');
    }
    if (options.minify === false) {
      Print.warning('--no-minify ships readable bundles; use it only for debugging.');
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

    const skippedEntries = [];
    await fs.remove(outDir);
    await copyDist(outDir, distDir, { keepComponents, skipped: skippedEntries });
    await flattenPublic(outDir);

    // In Express production `/Components` answers 404. Match that in the static
    // export: component source is minified but still source, and every component
    // used at runtime is in a bundle. `--keep-components` is a debugging escape.
    let componentsState = 'none';
    if (keepComponents && await fs.pathExists(path.join(outDir, 'Components'))) {
      componentsState = 'kept';
    } else if (skippedEntries.includes('Components/')) {
      componentsState = 'pruned';
    }

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

    const redirects = prerender?.seo.redirects || [];
    const spa = options.spa === true || !prerender;
    const clientHosts = new Set(['github', 's3', 'none']);
    const clientSpa = clientHosts.has(host) && spa;
    // Cloudflare Pages only enables its own SPA mode when there is no top-level
    // 404.html. A `_redirects` catch-all is rejected as an infinite loop, and
    // `/* / 200` would hijack every asset, so remove the 404 page instead.
    const cloudflareSpa = host === 'cloudflare' && spa;

    const notFoundPage = prerender
      ? (prerender.seo.notFound.get(null) || [...prerender.seo.notFound.values()][0])
      : null;
    if (cloudflareSpa) {
      await fs.remove(path.join(outDir, '404.html'));
    } else if (clientSpa) {
      // GitHub/S3/none cannot return 200 for unknown routes. The portable
      // fallback is a 404.html that renders the shell (soft 404).
      await fs.copy(rootIndex, path.join(outDir, '404.html'));
    } else if (notFoundPage) {
      await fs.writeFile(path.join(outDir, '404.html'), notFoundPage.html);
    } else {
      await fs.copy(rootIndex, path.join(outDir, '404.html'));
    }

    const envKeys = await ensureEnv(outDir, projectRoot);
    const hostRules = await writeHostRules(outDir, host, redirects, { spa });

    // Hosts without server-side redirect syntax get portable HTML redirect files.
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
      if (cloudflareSpa) {
        Print.info('404.html: omitted (Cloudflare auto-SPA)');
      } else {
        Print.info(`404.html${notFoundPage && !clientSpa ? ' (noindex)' : ''}`);
      }
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
    let spaLabel = 'no (unknown routes -> 404.html)';
    if (cloudflareSpa) {
      spaLabel = 'yes (Cloudflare auto-SPA; no 404.html)';
    } else if (clientSpa) {
      spaLabel = 'via 404.html (soft 404; host-dependent)';
    } else if (spa) {
      spaLabel = 'yes (unknown routes -> index.html)';
    }
    Print.info(`SPA fallback: ${spaLabel}`);
    if (componentsState === 'pruned') {
      Print.info('Components: pruned (source not shipped)');
    } else if (componentsState === 'kept') {
      Print.warning('Components: kept; component source is fetchable.');
    }
    if (skippedEntries.length > 0 && process.env.SLICE_DEBUG) {
      Print.verbose(`Skipped from dist: ${skippedEntries.join(', ')}`);
    }
    if (clientRedirects.written) {
      Print.info(`${clientRedirects.written} client redirect page(s)`);
    }
    for (const skipped of clientRedirects.skipped) {
      Print.warning(`Redirect path already has a page; kept the page: ${skipped}`);
    }
    for (const warning of hostRules.warnings) Print.warning(warning);

    Print.newLine();
    Print.subtitle('Next step');
    Print.commandExample('Serve the export locally', `npx serve ${path.relative(projectRoot, outDir) || '.'}`);
    Print.info('Use "npx serve -s" only to test the SPA fallback: it hides the real 404.html.');
    return true;
  } catch (error) {
    Print.error(`Static export failed: ${error.message}`);
    Print.stack(error);
    return false;
  }
}
