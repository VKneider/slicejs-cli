// cli/commands/bundle/bundle.js
import path from 'path';
import fs from 'fs-extra';
import DependencyAnalyzer from '../utils/bundling/DependencyAnalyzer.js';
import BundleGenerator from '../utils/bundling/BundleGenerator.js';
import Print from '..//Print.js';
import { getProjectRoot, getSrcPath } from '../utils/PathHelper.js';

/**
 * Main bundling command
 */
export default async function bundle(options = {}) {
  const startTime = Date.now();
  const projectRoot = getProjectRoot(import.meta.url);

  try {
    Print.title('📦 Slice.js Bundle Generator');
    Print.newLine();

    // Validate that it's a Slice.js project
    await validateProject(projectRoot);

    // Create default bundle config if needed
    const bundleGenerator = new BundleGenerator(import.meta.url, null);
    await bundleGenerator.createDefaultBundleConfig();

    // Phase 1: Analysis
    Print.buildProgress('Analyzing project...');
    const analyzer = new DependencyAnalyzer(import.meta.url);
    const analysisData = await analyzer.analyze();

    // Show report if in verbose mode
    if (options.verbose || options.analyze) {
      Print.newLine();
      analyzer.generateReport(analysisData.metrics);
      Print.newLine();
    }

    // If only analysis is requested, finish here
    if (options.analyze) {
      Print.success('Analysis completed');
      return;
    }

    // Phase 2: Bundle generation
    Print.buildProgress('Generating bundles...');
    const generator = new BundleGenerator(import.meta.url, analysisData, {
      minify: !!options.minify,
      obfuscate: !!options.obfuscate,
      output: options.output || 'src'
    });
    const result = await generator.generate();

    // Phase 3: Save configuration
    Print.buildProgress('Saving configuration...');
    await generator.saveBundleConfig(result.config);

    // Phase 4: Summary
    Print.newLine();
    printSummary(result, startTime);

    // Show next step
    Print.newLine();
    Print.info('💡 Next step:');
    console.log('   Update your Slice.js to use the generated bundles');
    console.log('   Bundles will load automatically in production\n');

  } catch (error) {
    Print.error('Error generating bundles:', error.message);
    console.error('\n📍 Complete stack trace:');
    console.error(error.stack);

    if (error.code) {
      console.error('\n📍 Error code:', error.code);
    }

    process.exit(1);
  }
}

/**
 * Validates that the project has the correct structure
 */
async function validateProject(projectRoot) {
  const requiredPaths = [
    getSrcPath(import.meta.url, 'Components', 'components.js'),
    getSrcPath(import.meta.url, 'routes.js')
  ];

  for (const fullPath of requiredPaths) {
    if (!await fs.pathExists(fullPath)) {
      const relativePath = path.relative(projectRoot, fullPath);
      throw new Error(`Required file not found: ${relativePath}`);
    }
  }
}

/**
 * Prints summary of generated bundles
 */
function printSummary(result, startTime) {
  const { bundles, config, files } = result;
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  Print.success(`Bundles generated in ${duration}s\n`);

  // Critical bundle
  if (bundles.critical.components.length > 0) {
    Print.info('📦 Critical Bundle:');
    console.log(`   Components: ${bundles.critical.components.length}`);
    console.log(`   Size: ${(bundles.critical.size / 1024).toFixed(1)} KB`);
    console.log(`   File: ${bundles.critical.file}\n`);
  }

  // Route bundles
  const routeCount = Object.keys(bundles.routes).length;
  if (routeCount > 0) {
    Print.info(`📦 Route Bundles (${routeCount}):`);

    for (const [key, bundle] of Object.entries(bundles.routes)) {
      console.log(`   ${key}:`);
      const routeDisplay = Array.isArray(bundle.path) ? `${bundle.path.length} routes` : (bundle.path || key);
      console.log(`     Route: ${routeDisplay}`);
      console.log(`     Components: ${bundle.components.length}`);
      console.log(`     Size: ${(bundle.size / 1024).toFixed(1)} KB`);
      console.log(`     File: ${bundle.file}`);
    }
    Print.newLine();
  }

  // Global statistics
  Print.info('📊 Statistics:');
  console.log(`   Strategy: ${config.strategy}`);
  console.log(`   Total components: ${config.stats.totalComponents}`);
  console.log(`   Shared components: ${config.stats.sharedComponents}`);
  console.log(`   Generated files: ${files.length}`);

  // Calculate estimated improvement
  const beforeRequests = config.stats.totalComponents;
  const afterRequests = files.length;
  const improvement = Math.round((1 - afterRequests / beforeRequests) * 100);

  console.log(`   Request reduction: ${improvement}% (${beforeRequests} → ${afterRequests})`);
}

/**
 * Subcommand: Clean bundles
 */
export async function cleanBundles() {
  const srcPath = getSrcPath(import.meta.url);

  try {
    Print.title('🧹 Cleaning bundles...');

    const files = await fs.readdir(srcPath);
    const bundleFiles = files.filter(f => f.startsWith('slice-bundle.'));

    if (bundleFiles.length === 0) {
      Print.warning('No bundles found to clean');
      return;
    }

    for (const file of bundleFiles) {
      await fs.remove(path.join(srcPath, file));
      console.log(`   ✓ Deleted: ${file}`);
    }

    // Remove config
    const configPath = getSrcPath(import.meta.url, 'bundle.config.json');
    if (await fs.pathExists(configPath)) {
      await fs.remove(configPath);
      console.log(`   ✓ Deleted: bundle.config.json`);
    }

    Print.newLine();
    Print.success(`${bundleFiles.length} files deleted`);

  } catch (error) {
    Print.error('Error cleaning bundles:', error.message);
    process.exit(1);
  }
}

/**
 * Subcommand: Bundle information
 */
export async function bundleInfo() {
  const configPath = getSrcPath(import.meta.url, 'bundle.config.json');

  try {
    if (!await fs.pathExists(configPath)) {
      Print.warning('Bundle configuration not found');
      Print.info('Run "slice bundle" to generate bundles');
      return;
    }

    const config = await fs.readJson(configPath);

    Print.title('📦 Bundle Information');
    Print.newLine();

    Print.info('Configuration:');
    console.log(`   Version: ${config.version}`);
    console.log(`   Strategy: ${config.strategy}`);
    console.log(`   Generated: ${new Date(config.generated).toLocaleString()}`);
    Print.newLine();

    Print.info('Statistics:');
    console.log(`   Total components: ${config.stats.totalComponents}`);
    console.log(`   Total routes: ${config.stats.totalRoutes}`);
    console.log(`   Shared components: ${config.stats.sharedComponents} (${config.stats.sharedPercentage}%)`);
    console.log(`   Total size: ${(config.stats.totalSize / 1024).toFixed(1)} KB`);
    Print.newLine();

    Print.info('Bundles:');

    // Critical
    if (config.bundles.critical) {
      console.log(`   Critical: ${config.bundles.critical.components.length} components, ${(config.bundles.critical.size / 1024).toFixed(1)} KB`);
    }

    // Routes
    const routeCount = Object.keys(config.bundles.routes).length;
    console.log(`   Routes: ${routeCount} bundles`);

    for (const [key, bundle] of Object.entries(config.bundles.routes)) {
      console.log(`     ${key}: ${bundle.components.length} components, ${(bundle.size / 1024).toFixed(1)} KB`);
    }

  } catch (error) {
    Print.error('Error reading information:', error.message);
    process.exit(1);
  }
}
