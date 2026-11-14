// commands/export/export.js
//
// Experimental MVP for `slice export`: turn the production build into a folder a
// static host can serve without Express. It flattens `dist/public` to the root,
// creates the root `index.html`, freezes `slice-env.json`, and writes the host
// rules. Per-route SEO prerendering is a later phase; without it the host falls
// back to the SPA shell.
import fs from 'fs-extra';
import path from 'path';
import Print from '../Print.js';
import { getProjectRoot, getDistPath } from '../utils/PathHelper.js';
import { writeSliceEnv, writeSliceEnvPayload } from '../utils/publicEnv.js';
import build from '../build/build.js';

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

async function writeHostRules(outDir, host) {
  const written = [];

  if (host === 'cloudflare' || host === 'netlify') {
    await fs.writeFile(path.join(outDir, '_redirects'), '/*  /index.html  200\n', 'utf8');
    await fs.writeFile(path.join(outDir, '_headers'), HEADER_RULES, 'utf8');
    written.push('_redirects', '_headers');
  } else if (host === 'vercel') {
    const vercel = {
      rewrites: [{ source: '/(.*)', destination: '/index.html' }],
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
    await fs.writeFile(path.join(outDir, 'vercel.json'), `${JSON.stringify(vercel, null, 2)}\n`, 'utf8');
    written.push('vercel.json');
  } else if (host === 'nginx') {
    const nginx = `root /var/www/dist-static;
index index.html;

location / {
  try_files $uri $uri/ /index.html;
}

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

  return written;
}

async function checkExport(outDir) {
  const issues = [];
  const required = ['index.html', 'slice-env.json', 'slice-env.generated.js', 'bundles/bundle.config.json', 'Slice/Slice.js'];

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

    if (dryRun) {
      Print.title('Static export (dry run)');
      Print.info(`Would write ${path.relative(projectRoot, outDir)} from ${path.relative(projectRoot, distDir)}.`);
      Print.info(`Host rules: ${host}`);
      return true;
    }

    await fs.remove(outDir);
    await fs.copy(distDir, outDir, {
      filter: (src) => !shouldSkip(src)
    });

    await flattenPublic(outDir);

    const rootIndex = path.join(outDir, 'index.html');
    if (!await fs.pathExists(rootIndex)) {
      await fs.copy(path.join(outDir, 'App', 'index.html'), rootIndex);
    }

    // Hosts that serve 404.html (GitHub Pages, Netlify, static servers) get the
    // SPA shell there too. Real per-route SEO/404 pages are phase 2.
    await fs.copy(rootIndex, path.join(outDir, '404.html'));

    const envKeys = await ensureEnv(outDir, projectRoot);
    const rules = await writeHostRules(outDir, host);
    const files = await listFiles(outDir);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

    Print.title('Static export');
    Print.success(`Exported to ${path.relative(projectRoot, outDir) || '.'}`);
    Print.info(`${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
    Print.info(`Public env: ${envKeys} key(s) (JSON + ESM)`);
    Print.info(`Host rules: ${rules.length ? rules.join(', ') : 'none'}`);
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
