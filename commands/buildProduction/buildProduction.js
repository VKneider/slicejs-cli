// commands/buildProduction/buildProduction.js - CLEAN VERSION

import fs from 'fs-extra';
import path from 'path';
import { minify as terserMinify } from 'terser';
import { minify } from 'html-minifier-terser';
import CleanCSS from 'clean-css';
import Print from '../Print.js';
import { getSrcPath, getDistPath, getConfigPath, getProjectRoot } from '../utils/PathHelper.js';
import { resolvePackageManager, runScriptCommand } from '../utils/PackageManager.js';

/**
 * Loads configuration from sliceConfig.json
 */
const loadConfig = () => {
  try {
    const configPath = getConfigPath(import.meta.url);
    const rawData = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(rawData);
  } catch (error) {
    Print.error(`Loading configuration: ${error.message}`);
    return null;
  }
};

/**
 * Checks necessary build dependencies
 */
async function checkBuildDependencies() {
  const srcDir = getSrcPath(import.meta.url);
  
  if (!await fs.pathExists(srcDir)) {
    Print.error('Source directory (/src) not found');
    Print.info('Run "slice init" to initialize your project');
    return false;
  }
  
  try {
    await import('terser');
    await import('clean-css');
    await import('html-minifier-terser');
    Print.success('Build dependencies available');
    return true;
  } catch (error) {
    Print.warning('Some build dependencies missing - using fallback copy mode');
    return true;
  }
}

/**
 * Verifies that critical Slice.js files exist
 */
async function verifySliceFiles(srcDir) {
  Print.info('Verifying Slice.js critical files...');
  
  const criticalFiles = [
    'sliceConfig.json',
    'Components/components.js',
    'App/index.js'
  ];
  
  for (const file of criticalFiles) {
    const filePath = path.join(srcDir, file);
    if (!await fs.pathExists(filePath)) {
      throw new Error(`Critical Slice.js file missing: ${file}`);
    }
  }
  
  Print.success('All critical Slice.js files verified');
}

/**
 * Verifies build integrity for Slice.js
 */
async function verifyBuildIntegrity(distDir) {
  Print.info('Verifying build integrity for Slice.js...');
  
  const criticalBuiltFiles = [
    'sliceConfig.json',
    'Components/components.js',
    'App/index.js'
  ];
  
  for (const file of criticalBuiltFiles) {
    const filePath = path.join(distDir, file);
    if (!await fs.pathExists(filePath)) {
      throw new Error(`Critical built file missing: ${file}`);
    }
    
    if (file === 'Components/components.js') {
      const content = await fs.readFile(filePath, 'utf8');
      if (!content.includes('const components') || !content.includes('export default')) {
        throw new Error('components.js structure corrupted during build');
      }
    }
  }
  
  Print.success('Build integrity verified - all Slice.js components preserved');
}

/**
 * Copies sliceConfig.json to the dist directory
 */
async function copySliceConfig() {
  const srcConfig = getConfigPath(import.meta.url);
  const distConfig = getDistPath(import.meta.url, 'sliceConfig.json');
  
  if (await fs.pathExists(srcConfig)) {
    await fs.copy(srcConfig, distConfig);
    Print.info('sliceConfig.json copied to dist');
  }
}

/**
 * Processes a complete directory
 */
async function processDirectory(srcPath, distPath, baseSrcPath, options) {
  const items = await fs.readdir(srcPath);
  
  for (const item of items) {
    const srcItemPath = path.join(srcPath, item);
    const distItemPath = path.join(distPath, item);
    const stat = await fs.stat(srcItemPath);
    
    if (stat.isDirectory()) {
      await fs.ensureDir(distItemPath);
      await processDirectory(srcItemPath, distItemPath, baseSrcPath, options);
    } else {
      await processFile(srcItemPath, distItemPath, options);
    }
  }
}

/**
 * Processes an individual file
 */
async function processFile(srcFilePath, distFilePath, options) {
  const ext = path.extname(srcFilePath).toLowerCase();
  const fileName = path.basename(srcFilePath);
  const isBundleConfig = fileName === 'bundle.config.json' || fileName === 'bundle.config.js';
  const isBundleFolder = srcFilePath.includes(`${path.sep}bundles${path.sep}`);

  if (isBundleConfig && isBundleFolder) {
    const renamed = fileName.replace('bundle.config', 'bundle.build.config');
    distFilePath = path.join(path.dirname(distFilePath), renamed);
  }

  try {
    if (fileName === 'components.js') {
      if (options?.minify === false) {
        await fs.copy(srcFilePath, distFilePath);
        const stat = await fs.stat(srcFilePath);
        const sizeKB = (stat.size / 1024).toFixed(1);
        Print.info(`📄 Copied: ${fileName} (${sizeKB} KB)`);
      } else {
        await processComponentsFile(srcFilePath, distFilePath);
      }
    } else if (ext === '.js') {
      if (options?.minify === false) {
        await fs.copy(srcFilePath, distFilePath);
        const stat = await fs.stat(srcFilePath);
        const sizeKB = (stat.size / 1024).toFixed(1);
        Print.info(`📄 Copied: ${fileName} (${sizeKB} KB)`);
      } else {
        await minifyJavaScript(srcFilePath, distFilePath);
      }
    } else if (ext === '.css') {
      if (options?.minify === false) {
        await fs.copy(srcFilePath, distFilePath);
        const stat = await fs.stat(srcFilePath);
        const sizeKB = (stat.size / 1024).toFixed(1);
        Print.info(`📄 Copied: ${fileName} (${sizeKB} KB)`);
      } else {
        await minifyCSS(srcFilePath, distFilePath);
      }
    } else if (ext === '.html') {
      if (options?.minify === false) {
        await fs.copy(srcFilePath, distFilePath);
        const stat = await fs.stat(srcFilePath);
        const sizeKB = (stat.size / 1024).toFixed(1);
        Print.info(`📄 Copied: ${fileName} (${sizeKB} KB)`);
      } else {
        await minifyHTML(srcFilePath, distFilePath);
      }
    } else if (fileName === 'sliceConfig.json') {
      await fs.copy(srcFilePath, distFilePath);
      Print.info(`📄 Preserved: ${fileName} (configuration file)`);
    } else {
      await fs.copy(srcFilePath, distFilePath);
      const stat = await fs.stat(srcFilePath);
      const sizeKB = (stat.size / 1024).toFixed(1);
      Print.info(`📄 Copied: ${fileName} (${sizeKB} KB)`);
    }
  } catch (error) {
    Print.error(`Processing ${fileName}: ${error.message}`);
    await fs.copy(srcFilePath, distFilePath);
  }
}

/**
 * Processes the components.js file in a special way
 */
async function processComponentsFile(srcPath, distPath) {
  const content = await fs.readFile(srcPath, 'utf8');
  const originalSize = Buffer.byteLength(content, 'utf8');
  
  const result = await terserMinify(content, {
    compress: false,
    mangle: false,
    format: {
      comments: false,
      beautify: false,
      indent_level: 0
    }
  });

  if (result.error) {
    throw new Error(`Terser error in components.js: ${result.error}`);
  }

  await fs.writeFile(distPath, result.code, 'utf8');
  
  const minifiedSize = Buffer.byteLength(result.code, 'utf8');
  const savings = Math.round(((originalSize - minifiedSize) / originalSize) * 100);
  
  Print.minificationResult(`${path.basename(srcPath)} (preserved structure)`, originalSize, minifiedSize, savings);
}

/**
 * Minifies JavaScript files preserving Slice.js architecture
 */
async function minifyJavaScript(srcPath, distPath) {
  const content = await fs.readFile(srcPath, 'utf8');
  const originalSize = Buffer.byteLength(content, 'utf8');
  
  const result = await terserMinify(content, {
    compress: {
      drop_console: false,
      drop_debugger: true,
      pure_funcs: [],
      passes: 1,
      unused: false,
      side_effects: false,
      reduce_vars: false,
      collapse_vars: false
    },
    mangle: {
      reserved: [
        // Core Slice
        'slice', 'Slice', 'SliceJS', 'window', 'document',
        // Main classes
        'Controller', 'StylesManager', 'Router', 'Logger', 'Debugger',
        // Slice methods
        'getClass', 'isProduction', 'getComponent', 'build', 'setTheme', 'attachTemplate',
        // Controller
        'componentCategories', 'templates', 'classes', 'requestedStyles', 'activeComponents',
        'registerComponent', 'registerComponentsRecursively', 'loadTemplateToComponent',
        'fetchText', 'setComponentProps', 'verifyComponentIds', 'destroyComponent',
        // StylesManager
        'componentStyles', 'themeManager', 'init', 'appendComponentStyles', 'registerComponentStyles',
        // Router
        'routes', 'pathToRouteMap', 'activeRoute', 'navigate', 'matchRoute', 'handleRoute',
        'onRouteChange', 'loadInitialRoute', 'renderRoutesComponentsInPage',
        // Propiedades de componentes
        'sliceId', 'sliceType', 'sliceConfig', 'debuggerProps', 'parentComponent',
        'value', 'customColor', 'icon', 'layout', 'view', 'items', 'columns', 'rows',
        'onClickCallback', 'props',
        // Custom Elements
        'customElements', 'define', 'HTMLElement',
        // Critical DOM APIs
        'addEventListener', 'removeEventListener', 'querySelector', 'querySelectorAll',
        'appendChild', 'removeChild', 'innerHTML', 'textContent', 'style', 'classList',
        // Lifecycle
        'beforeMount', 'afterMount', 'beforeDestroy', 'afterDestroy',
        'mount', 'unmount', 'destroy', 'update', 'start', 'stop',
        // Browser APIs
        'fetch', 'setTimeout', 'clearTimeout', 'localStorage', 'history', 'pushState',
        // Exports/Imports
        'default', 'export', 'import', 'from', 'await', 'async',
        // Nombres de componentes
        'Button', 'Grid', 'Layout', 'HomePage', 'NotFound', 'Loading', 'TreeView', 'Link',
        'FetchManager'
      ],
      properties: {
        regex: /^(slice|_|\$|on[A-Z]|get|set|has|is)/
      }
    },
    format: {
      comments: false,
      beautify: false
    },
    keep_fnames: true,
    keep_classnames: true
  });

  if (result.error) {
    throw new Error(`Terser error: ${result.error}`);
  }

  await fs.writeFile(distPath, result.code, 'utf8');
  
  const minifiedSize = Buffer.byteLength(result.code, 'utf8');
  const savings = Math.round(((originalSize - minifiedSize) / originalSize) * 100);
  
  Print.minificationResult(path.basename(srcPath), originalSize, minifiedSize, savings);
}

/**
 * Minifies CSS files
 */
async function minifyCSS(srcPath, distPath) {
  const content = await fs.readFile(srcPath, 'utf8');
  const originalSize = Buffer.byteLength(content, 'utf8');
  
  const cleanCSS = new CleanCSS({
    level: 2,
    returnPromise: false
  });
  
  const result = cleanCSS.minify(content);
  
  if (result.errors.length > 0) {
    throw new Error(`CleanCSS errors: ${result.errors.join(', ')}`);
  }

  await fs.writeFile(distPath, result.styles, 'utf8');
  
  const minifiedSize = Buffer.byteLength(result.styles, 'utf8');
  const savings = Math.round(((originalSize - minifiedSize) / originalSize) * 100);
  
  Print.minificationResult(path.basename(srcPath), originalSize, minifiedSize, savings);
}

/**
 * Minifies HTML files
 */
async function minifyHTML(srcPath, distPath) {
  const content = await fs.readFile(srcPath, 'utf8');
  const originalSize = Buffer.byteLength(content, 'utf8');
  
  const minified = await minify(content, {
    collapseWhitespace: true,
    removeComments: true,
    removeRedundantAttributes: true,
    removeScriptTypeAttributes: true,
    removeStyleLinkTypeAttributes: true,
    useShortDoctype: true,
    minifyCSS: true,
    minifyJS: {
      mangle: {
        reserved: ['slice', 'Slice', 'SliceJS', 'sliceId', 'sliceConfig']
      }
    },
    ignoreCustomFragments: [
      /slice-[\w-]+="[^"]*"/g
    ]
  });

  await fs.writeFile(distPath, minified, 'utf8');
  
  const minifiedSize = Buffer.byteLength(minified, 'utf8');
  const savings = Math.round(((originalSize - minifiedSize) / originalSize) * 100);
  
  Print.minificationResult(path.basename(srcPath), originalSize, minifiedSize, savings);
}

/**
 * Creates an optimized bundle of the main file
 */
async function createOptimizedBundle() {
  Print.buildProgress('Creating optimized bundle...');
  
  const mainJSPath = getDistPath(import.meta.url, 'App', 'index.js');
  
  if (await fs.pathExists(mainJSPath)) {
    Print.success('Main bundle optimized');
  } else {
    Print.warning('No main JavaScript file found for bundling');
  }
}

/**
 * Generates build statistics
 */
async function generateBuildStats(srcDir, distDir) {
  Print.buildProgress('Generating build statistics...');
  
  const getDirectorySize = async (dirPath) => {
    let totalSize = 0;
    const items = await fs.readdir(dirPath);
    
    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      const stat = await fs.stat(itemPath);
      
      if (stat.isDirectory()) {
        totalSize += await getDirectorySize(itemPath);
      } else {
        totalSize += stat.size;
      }
    }
    
    return totalSize;
  };

  try {
    const srcSize = await getDirectorySize(srcDir);
    const distSize = await getDirectorySize(distDir);
    const savings = Math.round(((srcSize - distSize) / srcSize) * 100);
    
    Print.newLine();
    Print.info(`📊 Build Statistics:`);
    console.log(`   Source: ${(srcSize / 1024).toFixed(1)} KB`);
    console.log(`   Built:  ${(distSize / 1024).toFixed(1)} KB`);
    console.log(`   Saved:  ${savings}% smaller`);
    
  } catch (error) {
    Print.warning('Could not generate build statistics');
  }
}

/**
 * Analyzes the build without building
 */
async function analyzeBuild() {
  const distDir = getDistPath(import.meta.url);
  
  if (!await fs.pathExists(distDir)) {
    Print.error('No build found to analyze. Run "slice build" first.');
    return;
  }
  
  Print.info('Analyzing production build...');
  await generateBuildStats(
    getSrcPath(import.meta.url),
    distDir
  );
}

/**
 * MAIN BUILD FUNCTION
 */
export default async function buildProduction(options = {}) {
  const startTime = Date.now();
  const packageManager = resolvePackageManager(getProjectRoot(import.meta.url)).name;
  
  try {
    Print.title('🔨 Building Slice.js project for production...');
    Print.newLine();
    
    const srcDir = getSrcPath(import.meta.url);
    const distDir = getDistPath(import.meta.url);
    
    if (!await fs.pathExists(srcDir)) {
      throw new Error('Source directory not found. Run "slice init" first.');
    }

    await verifySliceFiles(srcDir);

    // Clean dist directory
    if (await fs.pathExists(distDir)) {
      if (!options.skipClean) {
        Print.info('Cleaning previous build...');
        await fs.remove(distDir);
        Print.success('Previous build cleaned');
      }
    }
    
    await fs.ensureDir(distDir);
    await copySliceConfig();

    // Process files
    Print.info('Processing and optimizing source files for Slice.js...');
    await processDirectory(srcDir, distDir, srcDir, options);
    Print.success('All source files processed and optimized');

    await verifyBuildIntegrity(distDir);
    await createOptimizedBundle();
    await generateBuildStats(srcDir, distDir);

    const buildTime = ((Date.now() - startTime) / 1000).toFixed(1);
    
    Print.newLine();
    Print.success(`✨ Slice.js production build completed in ${buildTime}s`);
    Print.info('Your optimized project is ready in the /dist directory');
    Print.newLine();
    Print.info('Next steps:');
    console.log(`  • Use "${runScriptCommand(packageManager, 'start')}" to test the production build`);
    console.log('  • All Slice.js components and architecture preserved');
    
    return true;

  } catch (error) {
    Print.error(`Build failed: ${error.message}`);
    return false;
  }
}

/**
 * Preview server for testing the production build
 */
export async function serveProductionBuild(port) {
  try {
    const packageManager = resolvePackageManager(getProjectRoot(import.meta.url)).name;
    const config = loadConfig();
    const defaultPort = config?.server?.port || 3001;
    const finalPort = port || defaultPort;
    
    const distDir = getDistPath(import.meta.url);
    
    if (!await fs.pathExists(distDir)) {
      throw new Error('No production build found. Run "slice build" first.');
    }

    Print.info(`Starting production preview server on port ${finalPort}...`);
    
    const express = await import('express');
    const app = express.default();
    
    app.use(express.default.static(distDir));
    
    app.get('*', (req, res) => {
      const indexPath = path.join(distDir, 'App/index.html');
      const fallbackPath = path.join(distDir, 'index.html');
      
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else if (fs.existsSync(fallbackPath)) {
        res.sendFile(fallbackPath);
      } else {
        res.status(404).send('Production build index.html not found');
      }
    });
    
    app.listen(finalPort, () => {
      Print.success(`Production preview server running at http://localhost:${finalPort}`);
      Print.info('Press Ctrl+C to stop the server');
      Print.info('This server previews your production build from /dist');
      Print.warning(`This is a preview server - use "${runScriptCommand(packageManager, 'start')}" for the full production server`);
    });
    
  } catch (error) {
    Print.error(`Error starting production preview server: ${error.message}`);
    throw error;
  }
}

/**
 * Build command with options
 */
export async function buildCommand(options = {}) {
  const config = loadConfig();
  const defaultPort = config?.server?.port || 3001;
  
  if (!await checkBuildDependencies()) {
    return false;
  }

  if (options.serve) {
    await serveProductionBuild(options.port || defaultPort);
    return true;
  }

  if (options.analyze) {
    await analyzeBuild();
    return true;
  }

  const success = await buildProduction(options);
  
  if (success && options.preview) {
    Print.newLine();
    Print.info('✨ Build completed successfully!');
    Print.info(`Starting preview server on port ${options.port || defaultPort}...`);
    await serveProductionBuild(options.port || defaultPort);
  }
  
  return success;
}
