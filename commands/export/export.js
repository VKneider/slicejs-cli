// commands/export/export.js
//
// `slice export`: turn the production build into a folder a static host can serve
// without Express. This file is orchestration only; copy rules, prerender, the
// check and each host live in their own module.
import fs from 'fs-extra';
import path from 'path';
import Print from '../Print.js';
import { getProjectRoot, getDistPath } from '../utils/PathHelper.js';
import build from '../build/build.js';
import { resolveSafeOutDir } from './outDir.js';
import { copyDist, ensureEnv, flattenPublic } from './copyDist.js';
import { buildPrerender } from './prerender.js';
import { checkExport } from './checkExport.js';
import { listFiles, writePage } from './files.js';
import { writeClientRedirects, writeClientSpa404 } from './clientRedirects.js';
import { detectHost, getHost } from './hosts/index.js';

function spaLabel(preset, spa) {
  if (!spa) return 'no (unknown routes -> 404.html)';
  if (preset.spaMode === 'omit-404') return 'yes (Cloudflare auto-SPA; no 404.html)';
  if (preset.spaMode === 'client-404') return 'via 404.html (soft 404; host-dependent)';
  return 'yes (unknown routes -> index.html)';
}

export default async function exportStatic(options = {}) {
  const projectRoot = getProjectRoot(import.meta.url);
  const distDir = getDistPath(import.meta.url);
  const checkOnly = Boolean(options.check);
  const dryRun = Boolean(options.dryRun);
  const keepComponents = Boolean(options.keepComponents);

  try {
    Print.warning('slice export is experimental; flags and output may change between releases.');

    // `--check` only reads, so it can inspect any existing folder. Every write
    // path validates the target before touching it (a typo must not delete the
    // project).
    if (checkOnly) {
      const outDir = path.resolve(projectRoot, options.out || 'dist-static');
      const preset = options.host ? getHost(options.host) : await detectHost(outDir);
      const explicitHost = options.host ? preset.id : null;

      Print.title('Static export check');
      const { issues, warnings } = await checkExport(outDir, {
        keepComponents: options.keepComponents,
        preset,
        explicitHost
      });
      for (const warning of warnings) Print.warning(warning);
      if (issues.length > 0) {
        for (const issue of issues) Print.error(issue);
        return false;
      }
      Print.success(`Export looks valid: ${path.relative(projectRoot, outDir)}`);
      return true;
    }

    const outDir = await resolveSafeOutDir(projectRoot, options.out);
    const preset = getHost(options.host);

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

    // A custom host rule inside src/public would be flattened and then silently
    // replaced by the generated preset. Fail instead of losing CSP/redirects.
    const customRuleFiles = (preset.ruleFiles || [])
      .filter((name) => fs.existsSync(path.join(distDir, 'public', name)));
    if (customRuleFiles.length > 0) {
      throw new Error(
        `dist/public/${customRuleFiles.join(', ')} would be replaced by --host ${preset.id}. Move custom host rules out of public/ or merge them into the generated files.`
      );
    }
    if (fs.existsSync(path.join(distDir, 'public', '404.html'))) {
      Print.warning('dist/public/404.html will be replaced by the generated 404.html.');
    }

    const prerender = await buildPrerender(projectRoot, distDir, options);

    if (dryRun) {
      Print.title('Static export (dry run)');
      Print.info(`Would write ${path.relative(projectRoot, outDir)} from ${path.relative(projectRoot, distDir)}.`);
      Print.info(`Host rules: ${preset.id}`);
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
    const cloudflareSpa = preset.spaMode === 'omit-404' && spa;
    const clientSpa = preset.spaMode === 'client-404' && spa;
    const notFoundPage = prerender
      ? (prerender.seo.notFound.get(null) || [...prerender.seo.notFound.values()][0])
      : null;

    if (cloudflareSpa) {
      // Cloudflare Pages only enables its own SPA mode when there is no
      // top-level 404.html. A `_redirects` catch-all is rejected as an infinite
      // loop, and `/* / 200` would hijack every asset.
      await fs.remove(path.join(outDir, '404.html'));
    } else if (clientSpa) {
      // GitHub/S3/none cannot return 200 for unknown routes. The portable
      // fallback is a 404.html that renders the app shell (soft 404).
      await writeClientSpa404(outDir);
    } else if (notFoundPage) {
      await fs.writeFile(path.join(outDir, '404.html'), notFoundPage.html);
    } else {
      await fs.copy(rootIndex, path.join(outDir, '404.html'));
    }

    const envKeys = await ensureEnv(outDir, projectRoot);
    const hostFiles = await preset.write({ outDir, redirects, spa });

    // Hosts without server-side redirect syntax get portable HTML redirect files.
    let clientRedirects = { written: 0, skipped: [] };
    if (preset.clientRedirectPages && redirects.length) {
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
    Print.info(`Host rules: ${hostFiles.length ? hostFiles.join(', ') : 'none'}`);
    Print.info(`SPA fallback: ${spaLabel(preset, spa)}`);
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
