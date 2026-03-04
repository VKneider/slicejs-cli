import bundle from '../bundle/bundle.js';
import buildProduction, { serveProductionBuild } from '../buildProduction/buildProduction.js';
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
    output: 'dist'
  });

  if (options.preview) {
    await serveProductionBuild(options.port);
  }

  return true;
}
