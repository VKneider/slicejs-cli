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
  // The event debugger dynamically imports this catalog at runtime.
  'slice-events.generated.js',
  'robots.txt',
  'sitemap.xml',
  'manifest.json',
  'service-worker.js'
]);

const EXPORT_DIRS = new Set(['App', 'bundles', 'locales']);

// Files the exporter writes itself. `dist/public` is flattened to the root, but
// Express answers these paths with explicit routes before its static middleware,
// so a file with the same name in public/ must not replace them.
// `manifest.json` and `service-worker.js` are intentionally not reserved:
// Express prefers `dist/public/<file>` over `dist/<file>` for those two.
const RESERVED_ROOT_FILES = new Set([
  'index.html',
  '404.html',
  'routes.js',
  'sliceConfig.json',
  'slice-env.json',
  'slice-env.generated.js'
]);

// Express has a narrow carve-out for two generated docs data modules:
// `/bundles/documentationRoutes.generated.js` and `/bundles/docsIndex.js` are
// read from ComponentsPage. The static export prunes Components/, so copy just
// those two files into the public bundles folder.
const COMPONENTS_PAGE_BUNDLE_FILES = [
  'documentationRoutes.generated.js',
  'docsIndex.js'
];

function readDeployedConfig(distDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(distDir, 'sliceConfig.json'), 'utf8'));
  } catch {
    return null;
  }
}

function readTranslatorFolder(distDir) {
  const translator = readDeployedConfig(distDir)?.translator;
  if (!translator?.enabled) return null;
  const value = typeof translator.path === 'string' && translator.path.trim()
    ? translator.path
    : '/locales';
  const folder = value.replace(/^\/+|\/+$/g, '');
  return folder && !folder.includes('..') ? folder : null;
}

function eventsUiEnabled(distDir) {
  return readDeployedConfig(distDir)?.events?.ui?.enabled === true;
}

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
      // Express production only serves `/Slice/Slice.js`; copying the whole
      // folder would publish framework internals that Express 404s.
      if (name === 'Slice') {
        const sliceEntry = path.join(from, 'Slice.js');
        if (await fs.pathExists(sliceEntry)) {
          await fs.ensureDir(path.join(outDir, 'Slice'));
          await fs.copy(sliceEntry, path.join(outDir, 'Slice', 'Slice.js'), { overwrite: true });
        }
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
    // The static event graph only exists for the debugger UI.
    if (name === 'slice-events.generated.js' && !eventsUiEnabled(distDir)) {
      skipped.push(name);
      continue;
    }
    if (!isExportableFile(name)) continue;
    await fs.copy(from, path.join(outDir, name), { overwrite: true });
  }

  // `translator.path` is configurable (`/locales` by default). Express mounts
  // that exact folder, so copy it even when it is not a top-level allowlist dir.
  const translatorFolder = readTranslatorFolder(distDir);
  if (translatorFolder && !EXPORT_DIRS.has(translatorFolder)) {
    const translatorDir = path.join(distDir, translatorFolder);
    if (await fs.pathExists(translatorDir)) {
      await fs.copy(translatorDir, path.join(outDir, translatorFolder), { filter });
    }
  }

  // Narrow parity for the docs app: the Express bundle handler serves these two
  // generated modules from ComponentsPage. Copy only these, never Components/.
  const componentsPage = path.join(distDir, 'Components', 'AppComponents', 'ComponentsPage');
  for (const fileName of COMPONENTS_PAGE_BUNDLE_FILES) {
    const source = path.join(componentsPage, fileName);
    if (!await fs.pathExists(source)) continue;
    await fs.ensureDir(path.join(outDir, 'bundles'));
    await fs.copy(source, path.join(outDir, 'bundles', fileName), { overwrite: true });
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
