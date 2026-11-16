// commands/export/copyDist.js
//
// The export is an allowlist, not a copy of `dist/` minus a denylist. `dist/`
// also holds source (Components/), helpers (utils/), AppConfig.js, generated
// declarations and env files; Express production only serves a subset of it.
import fs from 'fs-extra';
import path from 'path';
import { writeSliceEnv, writeSliceEnvPayload } from '../utils/publicEnv.js';

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

const BLOCKED_SEGMENTS = new Set(['node_modules', '.git']);
const BLOCKED_FILES = /(?:^|\/)(?:\.env(?:\.[^/]+)?|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json)$/i;
const BLOCKED_ARTIFACTS = /\.(?:map(?:\.(?:br|gz))?|d\.ts)$/i;

function isExportableFile(relativePath) {
  const normalized = String(relativePath).replace(/\\/g, '/');
  if (!normalized) return true;
  const segments = normalized.toLowerCase().split('/');
  if (segments.some((segment) => BLOCKED_SEGMENTS.has(segment))) return false;
  if (BLOCKED_FILES.test(normalized)) return false;
  if (BLOCKED_ARTIFACTS.test(normalized)) return false;
  return true;
}

export async function copyDist(outDir, distDir, { keepComponents, skipped }) {
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

export async function flattenPublic(outDir) {
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

export async function ensureEnv(outDir, projectRoot) {
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
