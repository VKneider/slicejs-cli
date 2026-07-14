import bundle from '../bundle/bundle.js';
import buildProduction, { serveProductionBuild } from '../buildProduction/buildProduction.js';
import { loadConfigSync } from '../utils/loadConfig.js';
import { validateComponentProps } from '../types/types.js';
import { getProjectRoot, getDistPath } from '../utils/PathHelper.js';
import { precompressDirectory } from '../utils/compressAssets.js';
import Print from '../Print.js';

export default async function build(options = {}) {
  const minify = options.minify !== false;
  const obfuscate = options.obfuscate !== false;

  if (options.analyze) {
    return bundle({ analyze: true, verbose: options.verbose });
  }

  if (options.serve) {
    await serveProductionBuild(options.port);
    return true;
  }

  // Hard-fail before producing a bundle: ContextManager reactivity (setState →
  // watch/bind) is delivered through EventManager, and EventManager is only
  // bundled when events.enabled is true. context on + events off would ship a
  // bundle where every context watcher is silently dead — catch it here so the
  // broken bundle never gets built.
  const config = loadConfigSync(import.meta.url);
  if (config?.context?.enabled && !config?.events?.enabled) {
    Print.error('sliceConfig: context.enabled requires events.enabled.');
    Print.info('ContextManager reactivity (setState → watch/bind) runs through EventManager, which is only bundled when events.enabled is true. Set "events": { "enabled": true } in sliceConfig.json.');
    process.exit(1);
  }

  // Validate component static props before building (same checks as `slice
  // doctor`). Definition errors fail the build so a broken component contract
  // never ships; style issues warn but don't block. Skip with --no-validate.
  if (options.validate !== false) {
    const { errors, warnings } = await validateComponentProps({ projectRoot: getProjectRoot(import.meta.url) });

    for (const w of warnings) {
      Print.warning(`Props: ${w.component}.${w.prop} — ${w.message}`);
    }

    if (errors.length > 0) {
      Print.error(`Build blocked: ${errors.length} component prop error(s) found.`);
      for (const e of errors) {
        Print.info(`  ${e.component}.${e.prop} — ${e.message}`);
      }
      Print.info('Fix the component prop definitions above, or run "slice build --no-validate" to bypass (not recommended).');
      process.exit(1);
    }
  }

  const success = await buildProduction({
    ...options,
    minify,
    obfuscate
  });
  if (!success) {
    return false;
  }

  Print.info('Generating bundles for production build...');
  await bundle({
    verbose: options.verbose,
    minify,
    obfuscate,
    output: 'dist',
    strictExternal: options.strictExternal,
    sourcemap: options.sourcemap,
    hashFilenames: options.hashFilenames
  });

  if (options.compress) {
    Print.info('Precompressing assets (gzip + brotli)...');
    const stats = await precompressDirectory(getDistPath(import.meta.url));
    if (stats.files > 0) {
      const pct = (n) => `${Math.round((1 - n / stats.originalBytes) * 100)}%`;
      Print.info(`Precompressed ${stats.files} file(s): ${(stats.originalBytes / 1024).toFixed(0)} KB → gzip ${(stats.gzipBytes / 1024).toFixed(0)} KB (${pct(stats.gzipBytes)}), brotli ${(stats.brotliBytes / 1024).toFixed(0)} KB (${pct(stats.brotliBytes)})`);
    } else {
      Print.info('No compressible assets found to precompress.');
    }
  }

  if (options.preview) {
    await serveProductionBuild(options.port);
  }

  return true;
}
