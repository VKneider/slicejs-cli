// commands/export/checkExport.js
import fs from 'fs-extra';
import path from 'path';
import { listFiles, pagePathForUrl } from './files.js';
import { PARAM_ROUTE } from './prerender.js';

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

async function readJsonIfExists(file) {
  if (!await fs.pathExists(file)) return null;
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * `--check` validates what the exporter promises: the runtime files exist, no
 * source/secret artifacts slipped in, host rules are coherent, and every
 * literal route has a prerendered page unless the export declares an SPA
 * fallback. It cannot validate dynamic `${param}` routes: list concrete values
 * in `seo.json -> routes[pattern].sitemap.paths` if you need pages for them.
 */
export async function checkExport(outDir, { keepComponents = false, preset, explicitHost = null } = {}) {
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
  const autoSpa = preset?.spaMode === 'omit-404' && !has404;
  if (!has404 && !autoSpa) {
    issues.push('Missing 404.html');
  } else if (autoSpa) {
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

  if (preset) {
    const hostCheck = await preset.check({ outDir, explicitHost });
    issues.push(...hostCheck.issues);
    warnings.push(...hostCheck.warnings);
  }

  const routesFile = path.join(outDir, 'routes.js');
  if (await fs.pathExists(routesFile)) {
    const source = await fs.readFile(routesFile, 'utf8');
    const literalPaths = [...source.matchAll(/path\s*:\s*["'`]([^"'`]+)["'`]/g)]
      .map((match) => match[1])
      .filter((pathname) => pathname.startsWith('/') && !PARAM_ROUTE.test(pathname) && !pathname.includes('*'));

    if (literalPaths.length === 0) {
      warnings.push('Could not find literal routes in routes.js; route coverage was not checked.');
    } else if (!preset || !await preset.spaFallback({ outDir })) {
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
