import bundle from '../bundle/bundle.js';
import buildProduction, { serveProductionBuild } from '../buildProduction/buildProduction.js';
import { validateProject, validateServerEntry, classifyValidation, describeIssue } from '../utils/ProjectValidation.js';
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

  // One static pass: config rules, components and routes. `slice doctor`
  // reports exactly this result, so a green doctor means the build's pre-flight
  // passes. `--no-validate` skips the component findings; config and routes
  // always run, because both produce a broken deployment rather than a style
  // issue.
  const validation = await validateProject({
    projectRoot: getProjectRoot(import.meta.url),
    skipComponents: options.validate === false
  });
  // The server entry is not part of the bundle, but a deploy with a broken
  // api/index.js is a broken deploy: it joins the same blocking list.
  const server = await validateServerEntry({ projectRoot: getProjectRoot(import.meta.url) });
  const { blocking, advisory } = classifyValidation({ ...validation, ...server });

  if (validation.configErrors.length > 0) {
    for (const problem of validation.configErrors) {
      Print.error(`sliceConfig: ${problem.path} ${problem.message}`);
    }
    Print.info('Fix sliceConfig.json and run the build again.');
    process.exit(1);
  }

  if (blocking.length > 0) {
    Print.error(`Build blocked: ${blocking.length} issue(s) found.`);
    for (const issue of blocking) {
      Print.info(`  ${describeIssue(issue)}`);
    }
    Print.newLine();
    Print.info('Fix the entries above. Component files that do not parse, have no default export or import a missing file cannot be bundled; routes.js is served as-is, so a broken import stops the app from navigating.');
    Print.info('Bypass the component checks with "slice build --no-validate" (not recommended).');
    process.exit(1);
  }

  for (const issue of advisory) {
    Print.warning(describeIssue(issue));
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
