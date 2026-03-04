// cli/utils/bundling/BundleGenerator.js
import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import { minify as terserMinify } from 'terser';
import { getSrcPath, getComponentsJsPath, getDistPath } from '../PathHelper.js';

export default class BundleGenerator {
  constructor(moduleUrl, analysisData, options = {}) {
    this.moduleUrl = moduleUrl;
    this.analysisData = analysisData;
    this.srcPath = getSrcPath(moduleUrl);
    this.distPath = getDistPath(moduleUrl);
    this.output = options.output || 'src';
    this.bundlesPath = this.output === 'dist'
      ? path.join(this.distPath, 'bundles')
      : path.join(this.srcPath, 'bundles');
    this.componentsPath = path.dirname(getComponentsJsPath(moduleUrl));
    this.options = {
      minify: !!options.minify,
      obfuscate: !!options.obfuscate
    };

    // Configuration
    this.config = {
      maxCriticalSize: 50 * 1024, // 50KB
      maxCriticalComponents: 15,
      minSharedUsage: 3, // Minimum routes to be considered "shared"
      strategy: 'hybrid' // 'global', 'hybrid', 'per-route'
    };

    this.bundles = {
      critical: {
        components: [],
        size: 0,
        file: 'slice-bundle.critical.js'
      },
      routes: {}
    };
  }

  /**
   * Computes deterministic integrity hash for bundle metadata.
   * @param {Array} components
   * @param {string} type
   * @param {string|null} routePath
   * @param {string} bundleKey
   * @param {string} fileName
   * @returns {string}
   */
  computeBundleIntegrity(components, type, routePath, bundleKey, fileName) {
    const metadata = {
      version: '2.0.0',
      type,
      route: routePath,
      bundleKey,
      file: fileName,
      generated: 'static',
      totalSize: components.reduce((sum, c) => sum + c.size, 0),
      componentCount: components.length,
      strategy: this.config.strategy
    };

    const payload = {
      metadata,
      components: components.reduce((acc, comp) => {
        acc[comp.name] = {
          name: comp.name,
          category: comp.category,
          categoryType: comp.categoryType,
          componentDependencies: Array.from(comp.dependencies)
        };
        return acc;
      }, {})
    };

    return `sha256:${crypto.createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex')}`;
  }

  /**
   * Generates all bundles
   */
  async generate() {
    console.log('🔨 Generating bundles...');

    // 0. Create bundles directory
    await fs.ensureDir(this.bundlesPath);
    if (this.output === 'dist') {
      await fs.ensureDir(this.distPath);
    }

    // 1. Determine optimal strategy
    this.determineStrategy();

    // 2. Identify critical components
    this.identifyCriticalComponents();

    // 3. Assign components to routes
    this.assignRouteComponents();

    // 4. Generate bundle files
    const files = await this.generateBundleFiles();

    // 5. Generate framework bundle (structural)
    const frameworkComponents = this.collectFrameworkComponents();
    let frameworkBundle = null;
    if (frameworkComponents.length > 0) {
      frameworkBundle = await this.createFrameworkBundle(frameworkComponents);
      files.push(frameworkBundle);
    }

    // 6. Generate configuration
    const config = this.generateBundleConfig(frameworkBundle);

    console.log('✅ Bundles generated successfully');

    return {
      bundles: this.bundles,
      config,
      files
    };
  }

  /**
   * Determines the optimal bundling strategy
   */
  determineStrategy() {
    const { metrics } = this.analysisData;
    const { totalComponents, sharedPercentage } = metrics;

    // Strategy based on size and usage pattern
    if (totalComponents < 20 || sharedPercentage > 60) {
      this.config.strategy = 'global';
      console.log('📦 Strategy: Global Bundle (small project or highly shared)');
    } else if (totalComponents < 100) {
      this.config.strategy = 'hybrid';
      console.log('📦 Strategy: Hybrid (critical + grouped routes)');
    } else {
      this.config.strategy = 'per-route';
      console.log('📦 Strategy: Per Route (large project)');
    }
  }

  /**
   * Identifies critical components for the initial bundle
   */
  identifyCriticalComponents() {
    const { components } = this.analysisData;

    // Filter critical candidates
    const candidates = components
      .filter(comp => {
        // Shared components (used in 3+ routes)
        const isShared = comp.routes.size >= this.config.minSharedUsage;

        // Structural components (Navbar, Footer, etc.)
        const isStructural = comp.categoryType === 'Structural' ||
                            ['Navbar', 'Footer', 'Layout'].includes(comp.name);

        // Small and highly used components (only if used in 3+ routes)
        const isSmallAndUseful = comp.size < 2000 && comp.routes.size >= 3;

        return isShared || isStructural || isSmallAndUseful;
      })
      .sort((a, b) => {
        // Prioritize by: (usage * 10) - size
        const priorityA = (a.routes.size * 10) - (a.size / 1000);
        const priorityB = (b.routes.size * 10) - (b.size / 1000);
        return priorityB - priorityA;
      });

    const loadingComponent = components.find((comp) => comp.name === 'Loading');
    if (loadingComponent && !candidates.includes(loadingComponent)) {
      candidates.unshift(loadingComponent);
    }

    // Fill critical bundle up to limit
    for (const comp of candidates) {
      const dependencies = this.getComponentDependencies(comp);
      const totalSize = comp.size + dependencies.reduce((sum, dep) => sum + dep.size, 0);
      const totalCount = 1 + dependencies.length;

      const wouldExceedSize = this.bundles.critical.size + totalSize > this.config.maxCriticalSize;
      const wouldExceedCount = this.bundles.critical.components.length + totalCount > this.config.maxCriticalComponents;

      if ((wouldExceedSize || wouldExceedCount) && comp.name !== 'Loading') continue;

      // Add component and its dependencies
      if (!this.bundles.critical.components.find(c => c.name === comp.name)) {
        this.bundles.critical.components.push(comp);
        this.bundles.critical.size += comp.size;
      }

      for (const dep of dependencies) {
        if (!this.bundles.critical.components.find(c => c.name === dep.name)) {
          this.bundles.critical.components.push(dep);
          this.bundles.critical.size += dep.size;
        }
      }
    }

    console.log(`✓ Critical bundle: ${this.bundles.critical.components.length} components, ${(this.bundles.critical.size / 1024).toFixed(1)} KB`);
  }

  /**
   * Assigns remaining components to route bundles
   */
  assignRouteComponents() {
    const criticalNames = new Set(this.bundles.critical.components.map(c => c.name));

    if (this.config.strategy === 'hybrid') {
      this.assignHybridBundles(criticalNames);
    } else {
      this.assignPerRouteBundles(criticalNames);
    }
  }

  /**
   * Assigns components to per-route bundles
   */
  assignPerRouteBundles(criticalNames) {
    for (const route of this.analysisData.routes) {
      const routePath = route.path;
      // Get all route dependencies
      const routeComponents = this.getRouteComponents(route.component);

      // Include dependencies for all route components
      const allComponents = new Set();
      for (const comp of routeComponents) {
        allComponents.add(comp);
        const dependencies = this.getComponentDependencies(comp);
        for (const dep of dependencies) {
          allComponents.add(dep);
        }
      }

      // Filter those already in critical
      const uniqueComponents = Array.from(allComponents).filter(comp =>
        !criticalNames.has(comp.name)
      );

      if (uniqueComponents.length === 0) continue;

      const routeKey = this.routeToFileName(routePath);
      const totalSize = uniqueComponents.reduce((sum, c) => sum + c.size, 0);

      this.bundles.routes[routeKey] = {
        path: routePath,
        components: uniqueComponents,
        size: totalSize,
        file: `slice-bundle.${routeKey}.js`
      };

      console.log(`✓ Bundle ${routeKey}: ${uniqueComponents.length} components, ${(totalSize / 1024).toFixed(1)} KB`);
    }
  }

  /**
   * Gets all component dependencies transitively
   */
  getComponentDependencies(component, visited = new Set()) {
    if (visited.has(component.name)) return [];
    visited.add(component.name);

    const dependencies = [];

    // Add direct dependencies
    for (const depName of component.dependencies) {
      const depComp = this.analysisData.components.find(c => c.name === depName);
      if (depComp && !visited.has(depName)) {
        dependencies.push(depComp);
        // Add transitive dependencies
        dependencies.push(...this.getComponentDependencies(depComp, visited));
      }
    }

    return dependencies;
  }

  /**
   * Assigns components to hybrid bundles (grouped by category)
   */
  assignHybridBundles(criticalNames) {
    const routeGroups = new Map();

    // First, handle MultiRoute groups
    if (this.analysisData.routeGroups) {
      for (const [groupKey, groupData] of this.analysisData.routeGroups) {
        if (groupData.type === 'multiroute') {
          // Create a bundle for this MultiRoute group
          const allComponents = new Set();

          // Add the main component (MultiRoute handler)
          const mainComponent = this.analysisData.components.find(c => c.name === groupData.component);
          if (mainComponent) {
            allComponents.add(mainComponent);

            // Add all components used by this MultiRoute
            const routeComponents = this.getRouteComponents(mainComponent.name);
            for (const comp of routeComponents) {
              allComponents.add(comp);
              // Add transitive dependencies
              const dependencies = this.getComponentDependencies(comp);
              for (const dep of dependencies) {
                allComponents.add(dep);
              }
            }
          }

          // Filter those already in critical
          const uniqueComponents = Array.from(allComponents).filter(comp =>
            !criticalNames.has(comp.name)
          );

          if (uniqueComponents.length > 0) {
            const totalSize = uniqueComponents.reduce((sum, c) => sum + c.size, 0);

            this.bundles.routes[groupKey] = {
              paths: groupData.routes,
              components: uniqueComponents,
              size: totalSize,
              file: `slice-bundle.${this.routeToFileName(groupKey)}.js`
            };

            console.log(`✓ Bundle ${groupKey}: ${uniqueComponents.length} components, ${(totalSize / 1024).toFixed(1)} KB (${groupData.routes.length} routes)`);
          }
        }
      }
    }

    // Group remaining routes by category (skip those already handled by MultiRoute)
    for (const route of this.analysisData.routes) {
      // Check if this route is already handled by a MultiRoute group
      const isHandledByMultiRoute = this.analysisData.routeGroups &&
        Array.from(this.analysisData.routeGroups.values()).some(group =>
          group.type === 'multiroute' && group.routes.includes(route.path)
        );

      if (!isHandledByMultiRoute) {
        const category = this.categorizeRoute(route.path);
        if (!routeGroups.has(category)) {
          routeGroups.set(category, []);
        }
        routeGroups.get(category).push(route);
      }
    }

    // Create bundles for each group
    for (const [category, routes] of routeGroups) {
      const allComponents = new Set();

      // Collect all unique components for this category (including dependencies)
      for (const route of routes) {
        const routeComponents = this.getRouteComponents(route.component);
        for (const comp of routeComponents) {
          allComponents.add(comp);
          // Add transitive dependencies
          const dependencies = this.getComponentDependencies(comp);
          for (const dep of dependencies) {
            allComponents.add(dep);
          }
        }
      }

      // Filter those already in critical
      const uniqueComponents = Array.from(allComponents).filter(comp =>
        !criticalNames.has(comp.name)
      );

      if (uniqueComponents.length === 0) continue;

      const totalSize = uniqueComponents.reduce((sum, c) => sum + c.size, 0);
      const routePaths = routes.map(r => r.path);

      this.bundles.routes[category] = {
        paths: routePaths,
        components: uniqueComponents,
        size: totalSize,
        file: `slice-bundle.${this.routeToFileName(category)}.js`
      };

      console.log(`✓ Bundle ${category}: ${uniqueComponents.length} components, ${(totalSize / 1024).toFixed(1)} KB (${routes.length} routes)`);
    }
  }

  /**
   * Categorizes a route path for grouping, considering MultiRoute context
   */
  categorizeRoute(routePath) {
    // Check if this route belongs to a MultiRoute handler
    if (this.analysisData.routeGroups) {
      for (const [groupKey, groupData] of this.analysisData.routeGroups) {
        if (groupData.type === 'multiroute' && groupData.routes.includes(routePath)) {
          return groupKey; // Return the MultiRoute group key
        }
      }
    }

    // Default categorization
    const path = routePath.toLowerCase();

    if (path === '/' || path === '/home') return 'home';
    if (path.includes('docum') || path.includes('documentation')) return 'documentation';
    if (path.includes('component') || path.includes('visual') || path.includes('card') ||
        path.includes('button') || path.includes('input') || path.includes('switch') ||
        path.includes('checkbox') || path.includes('select') || path.includes('details') ||
        path.includes('grid') || path.includes('loading') || path.includes('layout') ||
        path.includes('navbar') || path.includes('treeview') || path.includes('multiroute')) return 'components';
    if (path.includes('theme') || path.includes('slice') || path.includes('config')) return 'configuration';
    if (path.includes('routing') || path.includes('guard')) return 'routing';
    if (path.includes('service') || path.includes('command')) return 'services';
    if (path.includes('structural') || path.includes('lifecycle') || path.includes('static') ||
        path.includes('build')) return 'advanced';
    if (path.includes('playground') || path.includes('creator')) return 'tools';
    if (path.includes('about') || path.includes('404')) return 'misc';

    return 'general';
  }

  /**
   * Gets all components needed for a route
   */
  getRouteComponents(componentName) {
    const result = [];
    const visited = new Set();

    const traverse = (name) => {
      if (visited.has(name)) return;
      visited.add(name);

      const component = this.analysisData.components.find(c => c.name === name);
      if (!component) return;

      result.push(component);

      // Add dependencies recursively
      for (const dep of component.dependencies) {
        traverse(dep);
      }
    };

    traverse(componentName);
    return result;
  }

  /**
   * Generates the physical bundle files
   */
  async generateBundleFiles() {
    const files = [];

    // 1. Critical bundle
    if (this.bundles.critical.components.length > 0) {
      const criticalFile = await this.createBundleFile(
        this.bundles.critical.components,
        'critical',
        null
      );
      const criticalIntegrity = this.computeBundleIntegrity(
        this.bundles.critical.components,
        'critical',
        null,
        'critical',
        criticalFile.file
      );
      this.bundles.critical.integrity = `sha256:${criticalFile.hash}`;
      this.bundles.critical.hash = criticalFile.hash;
      files.push(criticalFile);
    }

    // 2. Route bundles
    for (const [routeKey, bundle] of Object.entries(this.bundles.routes)) {
      const routeIdentifier = Array.isArray(bundle.path || bundle.paths)
        ? routeKey
        : (bundle.path || bundle.paths || routeKey);

      const routeFile = await this.createBundleFile(
        bundle.components,
        'route',
        routeIdentifier
      );
      const routeIntegrity = `sha256:${routeFile.hash}`;
      const matchingBundle = Object.values(this.bundles.routes)
        .find((entry) => entry.file === routeFile.file);
      if (matchingBundle) {
        matchingBundle.hash = routeFile.hash;
        matchingBundle.integrity = routeIntegrity;
      }
      files.push(routeFile);
    }

    return files;
  }

  /**
   * Creates a bundle file
   */
  async createBundleFile(components, type, routePath) {
    const routeKey = routePath ? this.routeToFileName(routePath) : 'critical';
    const fileName = `slice-bundle.${routeKey}.js`;
    const filePath = path.join(this.bundlesPath, fileName);

    const bundleContent = await this.generateBundleContent(
      components,
      type,
      routePath,
      routeKey,
      fileName
    );

    const finalContent = await this.applyBundleTransforms(bundleContent, fileName);

    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, finalContent, 'utf-8');

    const hash = crypto.createHash('sha256').update(finalContent).digest('hex');

    return {
      name: routeKey,
      file: fileName,
      path: filePath,
      size: Buffer.byteLength(bundleContent, 'utf-8'),
      hash,
      componentCount: components.length
    };
  }

  async applyBundleTransforms(bundleContent, fileName) {
    if (!this.options.minify && !this.options.obfuscate) {
      return bundleContent;
    }

    const options = {
      parse: {
        ecma: 2022
      },
      ecma: 2022,
      compress: this.options.minify ? {
        drop_console: false,
        drop_debugger: true,
        passes: 1
      } : false,
      mangle: this.options.obfuscate ? {
        properties: false
      } : false,
      keep_fnames: true,
      keep_classnames: true,
      format: {
        comments: false,
        ecma: 2022
      }
    };

    let result;
    try {
      result = await terserMinify(bundleContent, options);
    } catch (error) {
      const tmpDir = path.resolve(process.cwd(), '.tmp');
      const safeName = fileName.replace(/[^a-zA-Z0-9_.-]/g, '_');
      const tmpPath = path.join(tmpDir, `terser-fail-${safeName}`);
      try {
        await fs.ensureDir(tmpDir);
        await fs.writeFile(tmpPath, bundleContent, 'utf-8');
      } catch (writeError) {
        console.warn(`Warning: Failed to write ${tmpPath}:`, writeError.message);
      }
      const message = error?.message ? `${error.message}.` : 'Unknown Terser error.';
      throw new Error(`Terser failed for ${fileName}: ${message} Saved bundle to ${tmpPath}`);
    }

    if (result.error) {
      const tmpDir = path.resolve(process.cwd(), '.tmp');
      const safeName = fileName.replace(/[^a-zA-Z0-9_.-]/g, '_');
      const tmpPath = path.join(tmpDir, `terser-fail-${safeName}`);
      try {
        await fs.ensureDir(tmpDir);
        await fs.writeFile(tmpPath, bundleContent, 'utf-8');
      } catch (writeError) {
        console.warn(`Warning: Failed to write ${tmpPath}:`, writeError.message);
      }
      throw new Error(`Terser failed for ${fileName}: ${result.error.message}. Saved bundle to ${tmpPath}`);
    }

    return result.code || bundleContent;
  }


  /**
   * Analyzes dependencies of a JavaScript file using simple regex
   */
  analyzeDependencies(jsContent, componentPath) {
    const dependencies = [];

    const resolveImportPath = (importPath) => {
      const resolvedPath = path.resolve(componentPath, importPath);
      let finalPath = resolvedPath;
      const ext = path.extname(resolvedPath);
      if (!ext) {
        const extensions = ['.js', '.json', '.mjs'];
        for (const extension of extensions) {
          if (fs.existsSync(resolvedPath + extension)) {
            finalPath = resolvedPath + extension;
            break;
          }
        }
      }

      return fs.existsSync(finalPath) ? finalPath : null;
    };

    try {
      const ast = parse(jsContent, {
        sourceType: 'module',
        plugins: ['jsx']
      });

      traverse.default(ast, {
        ImportDeclaration(pathNode) {
          const importPath = pathNode.node.source.value;
          if (!importPath.startsWith('./') && !importPath.startsWith('../')) {
            return;
          }

          const resolvedPath = resolveImportPath(importPath);
          if (!resolvedPath) {
            return;
          }

          const bindings = pathNode.node.specifiers.map(spec => {
            if (spec.type === 'ImportDefaultSpecifier') {
              return {
                type: 'default',
                importedName: 'default',
                localName: spec.local.name
              };
            }

            if (spec.type === 'ImportSpecifier') {
              return {
                type: 'named',
                importedName: spec.imported.name,
                localName: spec.local.name
              };
            }

            if (spec.type === 'ImportNamespaceSpecifier') {
              return {
                type: 'namespace',
                localName: spec.local.name
              };
            }

            return null;
          }).filter(Boolean);

          dependencies.push({
            path: resolvedPath,
            bindings
          });
        }
      });
    } catch (error) {
      console.warn(`Warning: Could not analyze dependencies for ${componentPath}:`, error.message);
    }

    return dependencies;
  }

  /**
   * Generates the content of a bundle
   */
  async generateBundleContent(components, type, routePath, bundleKey, fileName) {
    const componentsData = {};

    for (const comp of components) {
      const fileBaseName = comp.fileName || comp.name;
      const jsPath = path.join(comp.path, `${fileBaseName}.js`);
      const jsContent = await fs.readFile(jsPath, 'utf-8');

      const dependencyContents = await this.buildDependencyContents(jsContent, comp.path);

      let htmlContent = null;
      let cssContent = null;

      const htmlPath = path.join(comp.path, `${fileBaseName}.html`);
      const cssPath = path.join(comp.path, `${fileBaseName}.css`);

      if (await fs.pathExists(htmlPath)) {
        htmlContent = await fs.readFile(htmlPath, 'utf-8');
      }

      if (await fs.pathExists(cssPath)) {
        cssContent = await fs.readFile(cssPath, 'utf-8');
      }

      const componentKey = comp.isFramework ? `Framework/Structural/${comp.name}` : comp.name;
      componentsData[componentKey] = {
        name: comp.name,
        category: comp.category,
        categoryType: comp.categoryType,
        isFramework: !!comp.isFramework,
        js: this.cleanJavaScript(jsContent, comp.name),
        externalDependencies: dependencyContents, // Files imported with import statements
        componentDependencies: Array.from(comp.dependencies), // Other components this one depends on
        html: htmlContent,
        css: cssContent,
        size: comp.size
      };
    }

    const metadata = {
      version: '2.0.0',
      type,
      route: routePath,
      bundleKey,
      file: fileName,
      generated: new Date().toISOString(),
      totalSize: components.reduce((sum, c) => sum + c.size, 0),
      componentCount: components.length,
      strategy: this.config.strategy,
      minified: this.options.minify,
      obfuscated: this.options.obfuscate
    };

    return this.formatBundleFile(componentsData, metadata);
  }

  async buildDependencyContents(jsContent, componentPath) {
    const dependencies = this.analyzeDependencies(jsContent, componentPath);
    const dependencyContents = {};

    for (const dep of dependencies) {
      const depPath = dep.path;
      try {
        const depContent = await fs.readFile(depPath, 'utf-8');
        const depName = path
          .relative(this.srcPath, depPath)
          .replace(/\\/g, '/');
        dependencyContents[depName] = {
          content: depContent,
          bindings: dep.bindings || []
        };
      } catch (error) {
        console.warn(`Warning: Could not read dependency ${depPath}:`, error.message);
      }
    }

    return dependencyContents;
  }

  /**
   * Cleans JavaScript code by removing imports/exports and ensuring class is available globally
   */
  cleanJavaScript(code, componentName) {
    // Remove export default
    code = code.replace(/export\s+default\s+/g, '');

    // Remove imports (components will already be available)
    code = code.replace(/import\s+.*?from\s+['"].*?['"];?\s*/g, '');

    // Guard customElements.define to avoid duplicate registrations
    code = code.replace(
      /customElements\.define\(([^)]+)\);?/g,
      (match, args) => {
        const firstArg = args.split(',')[0]?.trim() || '';
        if (!/^['"][^'"]+['"]$/.test(firstArg)) {
          return match;
        }
        return `if (!customElements.get(${firstArg})) { customElements.define(${args}); }`;
      }
    );

    // Make sure the class is available globally for bundle evaluation
    // Preserve original customElements.define if it exists
    if (code.includes('customElements.define')) {
      // Add global assignment before guarded or direct customElements.define
      const globalAssignment = `window.${componentName} = ${componentName};\n`;
      const guardedDefineRegex = /if\s*\(\s*!\s*customElements\.get\([^)]*\)\s*\)\s*\{\s*customElements\.define\([^;]+\);?\s*\}\s*$/;
      const directDefineRegex = /customElements\.define\([^;]+\);?\s*$/;
      if (guardedDefineRegex.test(code)) {
        code = code.replace(guardedDefineRegex, `${globalAssignment}$&`);
      } else {
        code = code.replace(directDefineRegex, `${globalAssignment}$&`);
      }
    } else {
      // If no customElements.define found, just assign to global
      code += `\nwindow.${componentName} = ${componentName};`;
    }

    // Add return statement for bundle evaluation compatibility
    code += `\nreturn ${componentName};`;

    return code;
  }

  /**
   * Formats the bundle file
   */
  formatBundleFile(componentsData, metadata) {
    const integrityPayload = {
      metadata: {
        ...metadata,
        generated: 'static'
      },
      components: Object.fromEntries(
        Object.entries(componentsData).map(([name, data]) => [
          name,
          {
            name: data.name,
            category: data.category,
            categoryType: data.categoryType,
            componentDependencies: data.componentDependencies
          }
        ])
      )
    };
    const integrity = `sha256:${crypto
      .createHash('sha256')
      .update(JSON.stringify(integrityPayload))
      .digest('hex')}`;

    const dependencyBlock = this.buildDependencyModuleBlock(componentsData);
    const componentBlock = this.buildComponentBundleBlock(componentsData);

    return `/**
 * Slice.js Bundle
 * Type: ${metadata.type}
 * Generated: ${metadata.generated}
 * Strategy: ${metadata.strategy}
 * Components: ${metadata.componentCount}
 * Total Size: ${(metadata.totalSize / 1024).toFixed(1)} KB
 */

${dependencyBlock}
${componentBlock}

export const SLICE_BUNDLE = {
  metadata: ${JSON.stringify({ ...metadata, integrity }, null, 2)},
  components: SLICE_BUNDLE_COMPONENTS
};

// Auto-registration of components
if (window.slice && window.slice.controller) {
  slice.controller.registerBundle(SLICE_BUNDLE);
}
`;
  }

  buildDependencyModuleBlock(componentsData) {
    const dependencyModules = this.collectDependencyModules(componentsData);
    if (dependencyModules.length === 0) {
      return 'const SLICE_BUNDLE_DEPENDENCIES = {};';
    }

    const lines = ['const SLICE_BUNDLE_DEPENDENCIES = {};'];
    dependencyModules.forEach((module, index) => {
      const exportVar = `__sliceDepExports${index}`;
      const content = this.transformDependencyContent(module.content, exportVar, module.name);
      lines.push(`// Dependency: ${module.name}`);
      lines.push(`const ${exportVar} = {};`);
      lines.push(content.trim());
      lines.push(`SLICE_BUNDLE_DEPENDENCIES[${JSON.stringify(module.name)}] = ${exportVar};`);
    });

    return `${lines.join('\n')}`;
  }

  collectDependencyModules(componentsData) {
    const modules = new Map();
    Object.values(componentsData).forEach((component) => {
      Object.entries(component.externalDependencies || {}).forEach(([name, entry]) => {
        if (modules.has(name)) return;
        const content = typeof entry === 'string' ? entry : entry.content;
        modules.set(name, { name, content });
      });
    });
    return Array.from(modules.values());
  }

  transformDependencyContent(content, exportVar, moduleName) {
    const baseName = moduleName.split('/').pop().replace(/\.[^.]+$/, '');
    const dataName = baseName ? `${baseName}Data` : null;
    const exportPrefix = dataName ? `${exportVar}.${dataName} = ` : `${exportVar}.default = `;

    return content
      .replace(/export\s+const\s+(\w+)\s*=\s*/g, `${exportVar}.$1 = `)
      .replace(/export\s+let\s+(\w+)\s*=\s*/g, `${exportVar}.$1 = `)
      .replace(/export\s+var\s+(\w+)\s*=\s*/g, `${exportVar}.$1 = `)
      .replace(/export\s+function\s+(\w+)/g, `${exportVar}.$1 = function`)
      .replace(/export\s+default\s+/g, exportPrefix)
      .replace(/export\s*{\s*([^}]+)\s*}/g, (match, exportsStr) => {
        return exportsStr
          .split(',')
          .map((exp) => {
            const cleanExp = exp.trim();
            const varName = cleanExp.split(' as ')[0].trim();
            return `${exportVar}.${varName} = ${varName};`;
          })
          .join('\n');
      })
      .replace(/^\s*export\s+/gm, '');
  }

  buildComponentBundleBlock(componentsData) {
    const componentEntries = [];
    const componentDefs = [];
    const frameworkEntries = [];

    Object.entries(componentsData).forEach(([name, data]) => {
      const classVar = this.toSafeIdentifier(name);
      const bindings = this.buildDependencyBindings(data.externalDependencies || {});

      componentDefs.push(`const ${classVar} = (() => {\n${bindings}\n${data.js}\nreturn ${name};\n})();`);

      if (data.isFramework) {
        frameworkEntries.push(`${JSON.stringify(data.name)}: ${classVar}`);
      }

      componentEntries.push(
        `${JSON.stringify(name)}: {\n` +
          `  name: ${JSON.stringify(data.name)},\n` +
          `  category: ${JSON.stringify(data.category)},\n` +
          `  categoryType: ${JSON.stringify(data.categoryType)},\n` +
          `  componentDependencies: ${JSON.stringify(data.componentDependencies)},\n` +
          `  html: ${JSON.stringify(data.html)},\n` +
          `  css: ${JSON.stringify(data.css)},\n` +
          `  size: ${JSON.stringify(data.size)},\n` +
          `  class: ${classVar}\n` +
        `}`
      );
    });

    const frameworkBlock = frameworkEntries.length > 0
      ? `const SLICE_FRAMEWORK_CLASSES = {\n${frameworkEntries.join(',\n')}\n};\nwindow.SLICE_FRAMEWORK_CLASSES = SLICE_FRAMEWORK_CLASSES;`
      : '';

    return `${componentDefs.join('\n\n')}\n\nconst SLICE_BUNDLE_COMPONENTS = {\n${componentEntries.join(',\n')}\n};\n${frameworkBlock}`;
  }

  buildDependencyBindings(externalDependencies) {
    const lines = [];
    Object.entries(externalDependencies).forEach(([name, entry]) => {
      const bindings = typeof entry === 'string' ? [] : entry.bindings || [];
      const depVar = `SLICE_BUNDLE_DEPENDENCIES[${JSON.stringify(name)}]`;
      const baseName = name.split('/').pop().replace(/\.[^.]+$/, '');
      const dataName = baseName ? `${baseName}Data` : null;

      bindings.forEach((binding) => {
        if (!binding?.localName) return;
        if (binding.type === 'default') {
          const fallback = dataName ? `${depVar}.${dataName}` : `${depVar}.default`;
          lines.push(`const ${binding.localName} = ${depVar}.default !== undefined ? ${depVar}.default : ${fallback};`);
        }
        if (binding.type === 'named') {
          lines.push(`const ${binding.localName} = ${depVar}.${binding.importedName};`);
        }
        if (binding.type === 'namespace') {
          lines.push(`const ${binding.localName} = ${depVar};`);
        }
      });
    });

    return lines.join('\n');
  }

  toSafeIdentifier(name) {
    const cleaned = name.replace(/[^a-zA-Z0-9_]/g, '_');
    if (/^\d/.test(cleaned)) {
      return `SliceComponent_${cleaned}`;
    }
    return `SliceComponent_${cleaned}`;
  }

  /**
   * Generates the bundle configuration
   */
  generateBundleConfig(frameworkBundle = null) {
    const config = {
      version: '2.0.0',
      strategy: this.config.strategy,
      minified: this.options.minify,
      obfuscated: this.options.obfuscate,
      production: true,
      generated: new Date().toISOString(),

      stats: {
        totalComponents: this.analysisData.metrics.totalComponents,
        totalRoutes: this.analysisData.metrics.totalRoutes,
        sharedComponents: this.bundles.critical.components.length,
        sharedPercentage: this.analysisData.metrics.sharedPercentage,
        totalSize: this.analysisData.metrics.totalSize,
        criticalSize: this.bundles.critical.size
      },

      bundles: {
        framework: {
          file: 'slice-bundle.framework.js',
          size: 0,
          hash: null,
          integrity: null,
          components: []
        },
        critical: {
          file: this.bundles.critical.file,
          size: this.bundles.critical.size,
          hash: this.bundles.critical.hash || null,
          integrity: this.bundles.critical.integrity || null,
          components: this.bundles.critical.components.map(c => c.name)
        },
        routes: {}
      },
      routeBundles: {}
    };

    for (const [key, bundle] of Object.entries(this.bundles.routes)) {
      const routeIdentifier = Array.isArray(bundle.path || bundle.paths)
        ? key
        : (bundle.path || bundle.paths || key);

      config.bundles.routes[key] = {
        path: bundle.path || bundle.paths || key, // Support both single path and array of paths, fallback to key
        file: `slice-bundle.${this.routeToFileName(routeIdentifier)}.js`,
        size: bundle.size,
        hash: bundle.hash || null,
        integrity: bundle.integrity || null,
        components: bundle.components.map(c => c.name),
        dependencies: ['critical']
      };

      const paths = Array.isArray(config.bundles.routes[key].path)
        ? config.bundles.routes[key].path
        : [config.bundles.routes[key].path];

      for (const routePath of paths) {
        if (!config.routeBundles[routePath]) {
          config.routeBundles[routePath] = ['critical'];
        }
        if (!config.routeBundles[routePath].includes(key)) {
          config.routeBundles[routePath].push(key);
        }
      }
    }

    if (frameworkBundle) {
      config.bundles.framework = {
        file: frameworkBundle.file,
        size: frameworkBundle.size,
        hash: frameworkBundle.hash,
        integrity: frameworkBundle.integrity,
        components: frameworkBundle.components || []
      };
    }

    return config;
  }

  collectFrameworkComponents() {
    return this.analysisData.components.filter((comp) => comp.isFramework);
  }

  async createFrameworkBundle(components) {
    const fileName = 'slice-bundle.framework.js';
    const filePath = path.join(this.bundlesPath, fileName);
    return this.generateFrameworkBundleFile(components, fileName, filePath);
  }

  async generateFrameworkBundleFile(components, fileName, filePath) {
    const componentsData = {};
    const componentsMap = await this.loadComponentsMap();
    const metadata = {
      version: '2.0.0',
      type: 'framework',
      route: null,
      bundleKey: 'framework',
      file: fileName,
      generated: new Date().toISOString(),
      totalSize: components.reduce((sum, c) => sum + c.size, 0),
      componentCount: components.length,
      strategy: this.config.strategy,
      minified: this.options.minify,
      obfuscated: this.options.obfuscate
    };

    components.forEach((comp) => {
      const componentKey = `Framework/Structural/${comp.name}`;
      const fileBaseName = comp.fileName || comp.name;
      const jsPath = path.join(comp.path, `${fileBaseName}.js`);
      const jsContent = fs.readFileSync(jsPath, 'utf-8');
      const dependencyContents = this.buildDependencyContentsSync(jsContent, comp.path);
      componentsData[componentKey] = {
        name: comp.name,
        category: comp.category,
        categoryType: comp.categoryType,
        isFramework: true,
        js: this.cleanJavaScript(jsContent, comp.name),
        externalDependencies: dependencyContents,
        componentDependencies: Array.from(comp.dependencies),
        html: fs.existsSync(path.join(comp.path, `${fileBaseName}.html`))
          ? fs.readFileSync(path.join(comp.path, `${fileBaseName}.html`), 'utf-8')
          : null,
        css: fs.existsSync(path.join(comp.path, `${fileBaseName}.css`))
          ? fs.readFileSync(path.join(comp.path, `${fileBaseName}.css`), 'utf-8')
          : null,
        size: comp.size
      };
    });

    const prelude = `const components = ${JSON.stringify(componentsMap)};`;
    const bundleContent = `${prelude}\n${this.formatBundleFile(componentsData, metadata)}`;
    const finalContent = await this.applyBundleTransforms(bundleContent, fileName);
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, finalContent, 'utf-8');

    const hash = crypto.createHash('sha256').update(finalContent).digest('hex');
    const integrity = `sha256:${hash}`;

    return {
      name: 'framework',
      file: fileName,
      size: Buffer.byteLength(bundleContent, 'utf-8'),
      hash,
      integrity,
      componentCount: components.length,
      components: components.map((comp) => `Framework/Structural/${comp.name}`)
    };
  }

  buildDependencyContentsSync(jsContent, componentPath) {
    const dependencies = this.analyzeDependencies(jsContent, componentPath);
    const dependencyContents = {};

    for (const dep of dependencies) {
      const depPath = dep.path;
      try {
        const depContent = fs.readFileSync(depPath, 'utf-8');
        const depName = path
          .relative(this.srcPath, depPath)
          .replace(/\\/g, '/');
        dependencyContents[depName] = {
          content: depContent,
          bindings: dep.bindings || []
        };
      } catch (error) {
        console.warn(`Warning: Could not read dependency ${depPath}:`, error.message);
      }
    }

    return dependencyContents;
  }

  stripImports(code) {
    return code.replace(/import\s+.*?from\s+['"].*?['"];?\s*/g, '');
  }

  async loadComponentsMap() {
    const componentsConfigPath = path.join(this.componentsPath, 'components.js');
    if (!await fs.pathExists(componentsConfigPath)) {
      return {};
    }

    const content = await fs.readFile(componentsConfigPath, 'utf-8');
    return this.parseComponentsConfig(content);
  }

  parseComponentsConfig(content) {
    try {
      const ast = parse(content, {
        sourceType: 'module',
        plugins: ['jsx']
      });

      let componentsNode = null;

      traverse.default(ast, {
        VariableDeclarator(path) {
          if (path.node.id?.type === 'Identifier' && path.node.id.name === 'components') {
            componentsNode = path.node.init;
            path.stop();
          }
        }
      });

      if (!componentsNode || componentsNode.type !== 'ObjectExpression') {
        throw new Error('components object not found');
      }

      const config = {};
      for (const prop of componentsNode.properties) {
        if (prop.type !== 'ObjectProperty') continue;

        const key = this.extractStringValue(prop.key);
        const value = this.extractStringValue(prop.value);

        if (!key || !value) {
          throw new Error('Invalid components entry');
        }

        config[key] = value;
      }

      return config;
    } catch (error) {
      console.warn(`Could not parse components.js: ${error.message}`);
      return {};
    }
  }

  extractStringValue(node) {
    if (!node) return null;

    if (node.type === 'StringLiteral') {
      return node.value;
    }

    if (node.type === 'Identifier') {
      return node.name;
    }

    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
      return node.quasis.map((q) => q.value.cooked).join('');
    }

    return null;
  }

  /**
   * Converts a route to filename
   */
  routeToFileName(routePath) {
    if (routePath === '/') return 'home';
    return routePath
      .replace(/^\//, '')
      .replace(/\//g, '-')
      .replace(/[^a-zA-Z0-9-]/g, '')
      .toLowerCase();
  }

  /**
   * Saves the configuration to file
   */
  async saveBundleConfig(config) {
    // Ensure bundles directory exists
    await fs.ensureDir(this.bundlesPath);

    // Save JSON config
    const configPath = path.join(this.bundlesPath, 'bundle.config.json');
    await fs.writeJson(configPath, config, { spaces: 2 });

    // Generate JavaScript module for direct import
    const jsConfigPath = path.join(this.bundlesPath, 'bundle.config.js');
    const jsConfig = this.generateBundleConfigJS(config);
    await fs.writeFile(jsConfigPath, jsConfig, 'utf-8');

    console.log(`✓ Configuration saved to ${configPath}`);
    console.log(`✓ JavaScript config generated: ${jsConfigPath}`);
  }

  /**
   * Creates a default bundle config file if none exists
   */
  async createDefaultBundleConfig() {
    const defaultConfigPath = path.join(this.srcPath, 'bundles', 'bundle.config.js');

    // Only create if it doesn't exist
    if (await fs.pathExists(defaultConfigPath)) {
      return;
    }

    await fs.ensureDir(path.dirname(defaultConfigPath));

    const defaultConfig = `/**
 * Slice.js Bundle Configuration
 * Default empty configuration - no bundles available
 * Run 'slice build' to generate optimized bundles
 */

// No bundles available - using individual component loading
export const SLICE_BUNDLE_CONFIG = null;

// No auto-initialization needed for default config
`;

    await fs.writeFile(defaultConfigPath, defaultConfig, 'utf-8');
    console.log(`✓ Default bundle config created: ${defaultConfigPath}`);
  }

  /**
   * Generates JavaScript module for direct import
   */
  generateBundleConfigJS(config) {
    return `/**
 * Slice.js Bundle Configuration
 * Generated: ${new Date().toISOString()}
 * Strategy: ${config.strategy}
 */

// Direct bundle configuration (no fetch required)
export const SLICE_BUNDLE_CONFIG = ${JSON.stringify(config, null, 2)};

// Auto-initialization if slice is available
if (typeof window !== 'undefined' && window.slice && window.slice.controller) {
  window.slice.controller.bundleConfig = SLICE_BUNDLE_CONFIG;

  // Load critical bundle automatically
  if (SLICE_BUNDLE_CONFIG.bundles.critical && !window.slice.controller.criticalBundleLoaded) {
    (async () => {
      const bundlePath = "/bundles/" + SLICE_BUNDLE_CONFIG.bundles.critical.file;
      const integrity = SLICE_BUNDLE_CONFIG.bundles.critical.integrity;

      if (typeof window.slice.controller.verifyBundleIntegrity === 'function') {
        const ok = await window.slice.controller.verifyBundleIntegrity(bundlePath, integrity);
        if (!ok) {
          console.warn('Failed to load critical bundle: integrity check failed');
          return;
        }
      }

      import('./slice-bundle.critical.js').catch(err =>
        console.warn('Failed to load critical bundle:', err)
      );
      window.slice.controller.criticalBundleLoaded = true;
    })();
  }
}
`;
  }
}
