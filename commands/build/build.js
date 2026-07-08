import bundle from '../bundle/bundle.js';
import buildProduction, { serveProductionBuild } from '../buildProduction/buildProduction.js';
import { loadConfigSync } from '../utils/loadConfig.js';
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
