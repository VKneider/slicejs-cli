import bundle from '../bundle/bundle.js';
import buildProduction, { serveProductionBuild } from '../buildProduction/buildProduction.js';
import { loadConfigSync } from '../utils/loadConfig.js';
import { validateComponentProps } from '../types/types.js';
import { validateConfigRules, classifyValidation, describeIssue } from '../utils/ProjectValidation.js';
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
  // bundled when events.enabled is true. The rule lives in ProjectValidation so
  // `slice doctor` reports the same thing instead of calling the config valid.
  const config = loadConfigSync(import.meta.url);
  const configErrors = validateConfigRules(config);
  if (configErrors.length > 0) {
    for (const problem of configErrors) {
      Print.error(`sliceConfig: ${problem.path} ${problem.message}`);
    }
    Print.info('Fix sliceConfig.json and run the build again.');
    process.exit(1);
  }

  // One validation pass for every registered component; `slice doctor` reports
  // the same result. Blocking findings fail the build, advisories only warn.
  // Skip with --no-validate.
  if (options.validate !== false) {
    const validation = await validateComponentProps({ projectRoot: getProjectRoot(import.meta.url) });
    const { blocking, advisory } = classifyValidation(validation);

    if (blocking.length > 0) {
      Print.error(`Build blocked: ${blocking.length} component issue(s) found.`);
      for (const issue of blocking) {
        Print.info(`  ${describeIssue(issue)}`);
      }
      Print.newLine();
      Print.info('Fix the components above. Files that do not parse, have no default export or import a missing file cannot be bundled; prop errors would ship a broken contract.');
      Print.info('Bypass with "slice build --no-validate" (not recommended).');
      process.exit(1);
    }

    for (const issue of advisory) {
      Print.warning(describeIssue(issue));
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
