// cli/utils/bundling/BundleGenerator.js
import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import { minify as terserMinify } from 'terser';
import { getSrcPath, getComponentsJsPath, getDistPath, getConfigPath } from '../PathHelper.js';

export default class BundleGenerator {
  constructor(moduleUrl, analysisData, options = {}) {
    this.moduleUrl = moduleUrl;
    this.analysisData = analysisData || { components: [], routes: [], metrics: {} };
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
    this.format = 'v2';
    this.sliceConfig = this.resolveSliceConfig();
    this.loadingPolicy = this.resolveLoadingPolicy();

    // Configuration
    this.config = {
      maxCriticalSize: 50 * 1024, // 50KB
      maxCriticalComponents: 15,
      minSharedUsage: 3, // Minimum routes to be considered "shared"
      minVendorSharedUsage: 2,
      minVendorSharedTransformedSize: 2 * 1024,
      maxRouteBundleSize: 120 * 1024,
      maxRouteRequests: 12,
      strategy: 'hybrid' // 'global', 'hybrid', 'per-route'
    };

    this.vendorShared = {
      file: 'slice-bundle.vendor-shared.js',
      dependencyModules: new Map(),
      dependencyUsage: new Map(),
      sharedDependencySet: new Set(),
      bundleKeysUsingSharedDependencies: new Set(),
      bundle: null
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

  resolveSliceConfig() {
    if (this.analysisData?.sliceConfig && typeof this.analysisData.sliceConfig === 'object') {
      return this.analysisData.sliceConfig;
    }

    try {
      const configPath = getConfigPath(this.moduleUrl);
      if (fs.existsSync(configPath)) {
        return fs.readJsonSync(configPath);
      }
    } catch (error) {
      console.warn('Warning: Could not read sliceConfig.json for loading policy:', error.message);
    }

    return {};
  }

  resolveLoadingPolicy() {
    return this.sliceConfig?.loading?.enabled ? 'enabled' : 'disabled';
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
        if (!this.isComponentAllowedByLoadingPolicy(comp)) return false;
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

    const loadingComponent = components.find((comp) => comp.name === 'Loading' && this.isComponentAllowedByLoadingPolicy(comp));
    if (this.loadingPolicy === 'enabled' && loadingComponent && !candidates.includes(loadingComponent)) {
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

    if (this.loadingPolicy === 'disabled') {
      this.bundles.critical.components = this.bundles.critical.components.filter((comp) => comp.name !== 'Loading');
      this.bundles.critical.size = this.bundles.critical.components.reduce((sum, comp) => sum + comp.size, 0);
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

    this.extractSharedComponents(criticalNames);
    this.rebalanceBundlesByBudget(this.bundles.routes, {
      maxBundleSize: this.config.maxRouteBundleSize,
      maxRequests: this.config.maxRouteRequests
    });
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
        !criticalNames.has(comp.name) && this.isComponentAllowedByLoadingPolicy(comp)
      );

      if (uniqueComponents.length === 0) continue;

      const routeKey = this.routeToFileName(routePath);
      const totalSize = uniqueComponents.reduce((sum, c) => sum + c.size, 0);

      this.bundles.routes[routeKey] = {
        path: routePath,
        components: this.sortComponentsByName(uniqueComponents),
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
            !criticalNames.has(comp.name) && this.isComponentAllowedByLoadingPolicy(comp)
          );

          if (uniqueComponents.length > 0) {
            const totalSize = uniqueComponents.reduce((sum, c) => sum + c.size, 0);

            this.bundles.routes[groupKey] = {
              paths: groupData.routes,
              components: this.sortComponentsByName(uniqueComponents),
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
        !criticalNames.has(comp.name) && this.isComponentAllowedByLoadingPolicy(comp)
      );

      if (uniqueComponents.length === 0) continue;

      const totalSize = uniqueComponents.reduce((sum, c) => sum + c.size, 0);
      const routePaths = routes.map(r => r.path);

      this.bundles.routes[category] = {
        paths: routePaths,
        components: this.sortComponentsByName(uniqueComponents),
        size: totalSize,
        file: `slice-bundle.${this.routeToFileName(category)}.js`
      };

      console.log(`✓ Bundle ${category}: ${uniqueComponents.length} components, ${(totalSize / 1024).toFixed(1)} KB (${routes.length} routes)`);
    }
  }

  isComponentAllowedByLoadingPolicy(component) {
    if (!component) return false;
    if (this.loadingPolicy === 'disabled' && component.name === 'Loading') {
      return false;
    }
    return true;
  }

  sortComponentsByName(components) {
    return [...components].sort((a, b) => a.name.localeCompare(b.name));
  }

  dedupeComponentsByName(components = []) {
    const byName = new Map();
    for (const component of components) {
      if (!component?.name) continue;
      if (!byName.has(component.name)) {
        byName.set(component.name, component);
      }
    }
    return this.sortComponentsByName(Array.from(byName.values()));
  }

  getBundlePaths(bundle = {}) {
    const raw = Array.isArray(bundle.paths)
      ? bundle.paths
      : Array.isArray(bundle.path)
        ? bundle.path
        : bundle.path
          ? [bundle.path]
          : [];

    return Array.from(new Set(raw.filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }

  setBundlePaths(bundle, paths = []) {
    const mergedPaths = Array.from(new Set((paths || []).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    if (mergedPaths.length === 0) {
      delete bundle.path;
      delete bundle.paths;
      return;
    }
    if (mergedPaths.length === 1) {
      bundle.path = mergedPaths[0];
      delete bundle.paths;
      return;
    }
    bundle.paths = mergedPaths;
    delete bundle.path;
  }

  mergeBundleDependencies(...dependencyLists) {
    const merged = [];
    const append = (dep) => {
      if (!dep || merged.includes(dep)) return;
      if (dep === 'critical') {
        merged.unshift(dep);
        return;
      }
      merged.push(dep);
    };

    dependencyLists
      .flat()
      .forEach(append);

    if (!merged.includes('critical')) {
      merged.unshift('critical');
    }

    const rest = merged
      .filter((dep) => dep !== 'critical')
      .sort((a, b) => a.localeCompare(b));
    return ['critical', ...rest];
  }

  extractSharedComponents(criticalNames) {
    const usage = new Map();

    for (const bundle of Object.values(this.bundles.routes)) {
      const seenInBundle = new Set();
      for (const component of this.dedupeComponentsByName(bundle.components || [])) {
        if (criticalNames.has(component.name)) continue;
        if (!this.isComponentAllowedByLoadingPolicy(component)) continue;
        if (seenInBundle.has(component.name)) continue;
        seenInBundle.add(component.name);
        if (!usage.has(component.name)) {
          usage.set(component.name, { component, count: 0 });
        }
        usage.get(component.name).count += 1;
      }
    }

    const sharedComponents = Array.from(usage.values())
      .filter((entry) => entry.count >= this.config.minSharedUsage)
      .map((entry) => entry.component);

    if (sharedComponents.length === 0) {
      return;
    }

    const sharedSet = new Set(sharedComponents.map((component) => component.name));
    const orderedShared = this.sortComponentsByName(sharedComponents);

    for (const bundle of Object.values(this.bundles.routes)) {
      const original = this.dedupeComponentsByName(bundle.components || []);
      const filtered = original.filter((component) => !sharedSet.has(component.name));
      const removedShared = original.length - filtered.length;
      bundle.components = this.sortComponentsByName(filtered);
      bundle.size = bundle.components.reduce((sum, component) => sum + component.size, 0);
      if (removedShared > 0) {
        bundle.dependencies = this.mergeBundleDependencies(bundle.dependencies || [], ['shared-core']);
      }
    }

    this.bundles.routes['shared-core'] = {
      paths: [],
      components: orderedShared,
      size: orderedShared.reduce((sum, component) => sum + component.size, 0),
      file: `slice-bundle.${this.routeToFileName('shared-core')}.js`
    };

    for (const [key, bundle] of Object.entries(this.bundles.routes)) {
      if (key === 'shared-core') continue;
      if ((bundle.components || []).length === 0) {
        delete this.bundles.routes[key];
      }
    }
  }

  rebalanceBundlesByBudget(bundles, limits = {}) {
    const maxBundleSize = limits.maxBundleSize || this.config.maxRouteBundleSize;
    const maxRequests = limits.maxRequests || this.config.maxRouteRequests;
    const orderedEntries = Object.entries(bundles)
      .sort(([a], [b]) => a.localeCompare(b));
    const rebalanced = {};

    for (const [key, bundle] of orderedEntries) {
      const sortedComponents = this.dedupeComponentsByName(bundle.components || []);
      const totalSize = sortedComponents.reduce((sum, component) => sum + component.size, 0);
      if (totalSize <= maxBundleSize || sortedComponents.length <= 1) {
        rebalanced[key] = {
          ...bundle,
          components: sortedComponents,
          size: totalSize,
          file: `slice-bundle.${this.routeToFileName(key)}.js`
        };
        continue;
      }

      let partIndex = 1;
      let currentChunk = [];
      let currentSize = 0;

      for (const component of sortedComponents) {
        const nextSize = currentSize + component.size;
        const shouldFlush = currentChunk.length > 0 && nextSize > maxBundleSize;

        if (shouldFlush) {
          const partKey = `${key}--p${partIndex}`;
          rebalanced[partKey] = {
            ...bundle,
            components: currentChunk,
            size: currentSize,
            file: `slice-bundle.${this.routeToFileName(partKey)}.js`
          };
          partIndex += 1;
          currentChunk = [];
          currentSize = 0;
        }

        currentChunk.push(component);
        currentSize += component.size;
      }

      if (currentChunk.length > 0) {
        const partKey = `${key}--p${partIndex}`;
        rebalanced[partKey] = {
          ...bundle,
          components: currentChunk,
          size: currentSize,
          file: `slice-bundle.${this.routeToFileName(partKey)}.js`
        };
      }
    }

    const keys = Object.keys(rebalanced).sort((a, b) => a.localeCompare(b));
    while (keys.length > maxRequests) {
      const lastKey = keys.pop();
      const targetKey = keys[keys.length - 1];
      if (!lastKey || !targetKey) break;
      const mergedComponents = this.dedupeComponentsByName([
        ...(rebalanced[targetKey].components || []),
        ...(rebalanced[lastKey].components || [])
      ]);
      const mergedPaths = [
        ...this.getBundlePaths(rebalanced[targetKey]),
        ...this.getBundlePaths(rebalanced[lastKey])
      ];
      const mergedDependencies = this.mergeBundleDependencies(
        rebalanced[targetKey].dependencies || [],
        rebalanced[lastKey].dependencies || []
      );

      rebalanced[targetKey].components = mergedComponents;
      rebalanced[targetKey].size = mergedComponents.reduce((sum, component) => sum + component.size, 0);
      rebalanced[targetKey].dependencies = mergedDependencies;
      this.setBundlePaths(rebalanced[targetKey], mergedPaths);
      delete rebalanced[lastKey];
    }

    Object.keys(bundles).forEach((key) => delete bundles[key]);
    for (const [key, bundle] of Object.entries(rebalanced).sort(([a], [b]) => a.localeCompare(b))) {
      bundles[key] = bundle;
    }

    return bundles;
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

    await this.prepareVendorSharedDependencies();

    if (this.vendorShared.sharedDependencySet.size > 0) {
      const vendorSharedFile = await this.createVendorSharedDependencyBundleFile(this.vendorShared.sharedDependencySet);
      this.vendorShared.bundle = vendorSharedFile;
      files.push(vendorSharedFile);
    }

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

  async prepareVendorSharedDependencies() {
    const routeDependencyIndex = await this.collectRouteExternalDependencyIndex();
    const usageIndex = this.indexExternalDependencyUsage(routeDependencyIndex);
    const sharedDependencySet = this.computeSharedDependencySet(usageIndex);

    this.vendorShared.dependencyUsage = usageIndex;
    this.vendorShared.sharedDependencySet = sharedDependencySet;
    this.vendorShared.bundleKeysUsingSharedDependencies = new Set();

    if (sharedDependencySet.size === 0) {
      return;
    }

    for (const dependencyName of sharedDependencySet) {
      const usageEntry = usageIndex.get(dependencyName);
      for (const bundleKey of usageEntry?.bundleKeys || []) {
        this.vendorShared.bundleKeysUsingSharedDependencies.add(bundleKey);
      }
    }

    for (const bundleKey of this.vendorShared.bundleKeysUsingSharedDependencies) {
      const bundle = this.bundles.routes[bundleKey];
      if (!bundle) continue;
      bundle.dependencies = this.mergeBundleDependencies(bundle.dependencies || [], ['vendor-shared']);
    }
  }

  async collectRouteExternalDependencyIndex() {
    const routeDependencyIndex = {};

    for (const [bundleKey, bundle] of Object.entries(this.bundles.routes)) {
      routeDependencyIndex[bundleKey] = {};
      const uniqueComponents = this.dedupeComponentsByName(bundle.components || []);

      for (const comp of uniqueComponents) {
        const fileBaseName = comp.fileName || comp.name;
        const jsPath = path.join(comp.path, `${fileBaseName}.js`);
        if (!await fs.pathExists(jsPath)) continue;
        const jsContent = await fs.readFile(jsPath, 'utf-8');
        const dependencies = await this.buildDependencyContents(jsContent, comp.path);
        for (const [depName, depEntry] of Object.entries(dependencies || {})) {
          if (!routeDependencyIndex[bundleKey][depName]) {
            routeDependencyIndex[bundleKey][depName] = depEntry;
          }
          if (!this.vendorShared.dependencyModules.has(depName)) {
            this.vendorShared.dependencyModules.set(depName, {
              name: depName,
              content: depEntry?.content || ''
            });
          }
        }
      }
    }

    return routeDependencyIndex;
  }

  indexExternalDependencyUsage(routeDependencyIndex = {}) {
    const usage = new Map();

    for (const [bundleKey, dependencies] of Object.entries(routeDependencyIndex || {})) {
      for (const [dependencyName, dependencyEntry] of Object.entries(dependencies || {})) {
        if (!usage.has(dependencyName)) {
          usage.set(dependencyName, {
            name: dependencyName,
            bundleKeys: new Set(),
            bundleCount: 0,
            content: dependencyEntry?.content || ''
          });
        }
        const entry = usage.get(dependencyName);
        entry.bundleKeys.add(bundleKey);
        entry.bundleCount = entry.bundleKeys.size;
      }
    }

    return usage;
  }

  computeSharedDependencySet(usageIndex = new Map()) {
    const shared = new Set();

    for (const [dependencyName, entry] of usageIndex.entries()) {
      if ((entry?.bundleCount || 0) < this.config.minVendorSharedUsage) continue;
      const transformedContent = this.transformDependencyContent(
        entry?.content || '',
        '__sliceVendorSharedProbe',
        dependencyName
      );
      const transformedSize = Buffer.byteLength(transformedContent, 'utf-8');
      if (transformedSize < this.config.minVendorSharedTransformedSize) continue;
      shared.add(dependencyName);
    }

    return shared;
  }

  generateVendorSharedDependencyBundleContent(sharedDependencySet = new Set()) {
    const selectedModules = Array.from(sharedDependencySet)
      .sort((a, b) => a.localeCompare(b))
      .map((dependencyName) => {
        const fromUsage = this.vendorShared.dependencyUsage.get(dependencyName)?.content;
        const fromCollected = this.vendorShared.dependencyModules.get(dependencyName)?.content;
        const content = fromUsage || fromCollected || '';
        return { name: dependencyName, content };
      })
      .filter((entry) => !!entry.content);

    const dependencyModuleBlock = this.buildV2DependencyModuleBlockFromModules(selectedModules);
    const metadata = {
      version: '2',
      bundleKey: 'vendor-shared',
      type: 'vendor-shared',
      routes: [],
      componentCount: 0,
      dependencyCount: selectedModules.length
    };

    return `export const SLICE_BUNDLE_META = ${JSON.stringify(metadata, null, 2)};\n\n${dependencyModuleBlock}\n\nexport async function registerAll() {\n  return SLICE_BUNDLE_DEPENDENCIES;\n}\n`;
  }

  async createVendorSharedDependencyBundleFile(sharedDependencySet) {
    const fileName = this.vendorShared.file;
    const filePath = path.join(this.bundlesPath, fileName);
    const bundleContent = this.generateVendorSharedDependencyBundleContent(sharedDependencySet);
    const finalContent = await this.applyBundleTransforms(bundleContent, fileName);
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, finalContent, 'utf-8');

    const hash = crypto.createHash('sha256').update(finalContent).digest('hex');

    return {
      name: 'vendor-shared',
      file: fileName,
      path: filePath,
      size: Buffer.byteLength(bundleContent, 'utf-8'),
      hash,
      integrity: `sha256:${hash}`,
      componentCount: 0
    };
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
    const bundleComponents = [];
    const uniqueComponents = this.dedupeComponentsByName(components || []);

    for (const comp of uniqueComponents) {
      const fileBaseName = comp.fileName || comp.name;
      const jsPath = path.join(comp.path, `${fileBaseName}.js`);
      const jsContent = await fs.readFile(jsPath, 'utf-8');

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

      const cleanedJavaScript = this.cleanJavaScript(jsContent, comp.name, jsPath);

      bundleComponents.push({
        name: comp.name,
        category: comp.category,
        categoryType: comp.categoryType,
        js: cleanedJavaScript.code,
        hoistedImports: cleanedJavaScript.hoistedImports,
        html: htmlContent,
        css: cssContent,
        externalDependencies: await this.buildDependencyContents(jsContent, comp.path),
        size: comp.size
      });
    }

    return this.generateBundleFileContent(fileName, type, this.sortComponentsByName(bundleComponents), routePath);
  }

  classFactoryName(componentName) {
    return `SLICE_CLASS_FACTORY_${this.toSafeIdentifier(componentName)}`;
  }

  indentCodeBlock(code, spaces = 2) {
    const indentation = ' '.repeat(spaces);
    return String(code)
      .split('\n')
      .map((line) => `${indentation}${line}`)
      .join('\n');
  }

  generateBundleFileContent(fileName, type, components, routePath = null) {
    const uniqueComponents = this.dedupeComponentsByName(components || []);
    const bundleKey = type === 'critical'
      ? 'critical'
      : type === 'framework'
        ? 'framework'
        : this.routeToFileName(routePath || fileName.replace('slice-bundle.', '').replace('.js', ''));

    const dependencyModules = this.collectDependencyModulesFromComponents(uniqueComponents);
    const isRouteBundle = type === 'route';
    const dependencyModuleBlock = this.buildV2DependencyModuleBlock(uniqueComponents, {
      includeSharedResolver: isRouteBundle,
      omittedDependencies: isRouteBundle ? this.vendorShared.sharedDependencySet : null
    });
    const rawHoistedImports = uniqueComponents
      .flatMap((component) => component.hoistedImports || [])
      .map((statement) => String(statement).trim())
      .filter(Boolean);
    const reservedIdentifiers = new Set([
      'SLICE_BUNDLE_META',
      'SLICE_BUNDLE_DEPENDENCIES',
      ...uniqueComponents.map((component) => this.classFactoryName(component.name)),
      ...uniqueComponents.map((component) => `__templateElement_${this.toSafeIdentifier(component.name)}`),
      ...this.getDependencyExportVariableNames(dependencyModules)
    ]);
    this.validateHoistedImportCollisions(rawHoistedImports, reservedIdentifiers);
    const hoistedImports = Array.from(new Set(rawHoistedImports));
    const hoistedImportBlock = hoistedImports.join('\n');

    const classFactoryDefinitions = uniqueComponents
      .map((component) => {
        const factoryName = this.classFactoryName(component.name);
        const dependencyBindings = this.buildDependencyBindings(component.externalDependencies || {}, {
          preferShared: isRouteBundle
        });
        const body = component.js && component.js.trim()
          ? component.js
          : `return window.${component.name};`;
        const bodyWithBindings = dependencyBindings
          ? `${dependencyBindings}\n${body}`
          : body;
        return `const ${factoryName} = () => {\n${this.indentCodeBlock(bodyWithBindings, 2)}\n};`;
      })
      .join('\n\n');

    const templateDeclarations = uniqueComponents
      .map((component) => {
        const templateVarName = `__templateElement_${this.toSafeIdentifier(component.name)}`;
        return `const ${templateVarName} = document.createElement('template');\n${templateVarName}.innerHTML = ${JSON.stringify(component.html || '')};`;
      })
      .join('\n');

    const classRegistrations = uniqueComponents
      .map((component) => {
        const componentName = JSON.stringify(component.name);
        return `  if (!controller.classes.has(${componentName})) {\n    controller.classes.set(${componentName}, ${this.classFactoryName(component.name)}());\n  }`;
      })
      .join('\n');

    const templateRegistrations = uniqueComponents
      .map((component) => {
        const componentName = JSON.stringify(component.name);
        const templateVarName = `__templateElement_${this.toSafeIdentifier(component.name)}`;
        return `  if (!controller.templates.has(${componentName})) {\n    controller.templates.set(${componentName}, ${templateVarName});\n  }`;
      })
      .join('\n');

    const cssRegistrationInit = uniqueComponents.length
      ? `  if (!stylesManager.__sliceRegisteredComponentStyles) {\n    stylesManager.__sliceRegisteredComponentStyles = new Set();\n  }`
      : '';

    const cssRegistrations = uniqueComponents
      .map((component) => {
        const componentName = JSON.stringify(component.name);
        return `  if (!stylesManager.__sliceRegisteredComponentStyles.has(${componentName})) {\n    stylesManager.registerComponentStyles(${componentName}, ${JSON.stringify(component.css || '')});\n    stylesManager.__sliceRegisteredComponentStyles.add(${componentName});\n  }`;
      })
      .join('\n');

    const categoryRegistrations = uniqueComponents
      .map((component) => {
        const componentName = JSON.stringify(component.name);
        return `  if (!controller.componentCategories.has(${componentName})) {\n    controller.componentCategories.set(${componentName}, ${JSON.stringify(component.category)});\n  }`;
      })
      .join('\n');

    const metadata = {
      version: '2',
      bundleKey,
      type,
      routes: routePath ? [routePath] : [],
      componentCount: uniqueComponents.length
    };

    return `${hoistedImportBlock}${hoistedImportBlock ? '\n\n' : ''}export const SLICE_BUNDLE_META = ${JSON.stringify(metadata, null, 2)};\n\n${dependencyModuleBlock}\n\n${classFactoryDefinitions}\n\n${templateDeclarations}\n\nexport async function registerAll(controller, stylesManager) {\n${classRegistrations}\n${templateRegistrations}\n${cssRegistrationInit}${cssRegistrationInit ? '\n' : ''}${cssRegistrations}\n${categoryRegistrations}\n}\n`;
  }

  buildV2DependencyModuleBlock(components, options = {}) {
    const modules = this.collectDependencyModulesFromComponents(components);
    return this.buildV2DependencyModuleBlockFromModules(modules, options);
  }

  buildV2DependencyModuleBlockFromModules(modules = [], options = {}) {
    const omittedDependencies = options.omittedDependencies instanceof Set
      ? options.omittedDependencies
      : new Set(options.omittedDependencies || []);
    // Emit in topological order so a module is registered before any module
    // that depends on it (its transitive imports resolve at IIFE-eval time).
    const filteredModules = this.sortDependencyModulesTopologically(
      modules.filter((module) => !omittedDependencies.has(module.name))
    );

    const lines = [
      'const SLICE_BUNDLE_DEPENDENCIES = {};',
      ...this.getDefaultExportResolverLines()
    ];
    if (options.includeSharedResolver) {
      lines.push(...this.getBundleDependencyResolverLines());
    }
    filteredModules.forEach((module, index) => {
      const exportVar = `__sliceDepExports${index}`;
      // Evaluate each dependency inside its own IIFE so its private,
      // non-exported top-level bindings stay local and cannot collide with
      // another dependency's (or the bundle's) identifiers. Only the exports
      // object escapes the closure.
      const transformedContent = this.transformDependencyContent(module.content, '__sliceExports', module.name);
      // Bind this module's own (transitive) imports inside its IIFE — they were
      // registered by earlier modules in the topological order.
      const importBindings = this.buildDependencyBindings(
        Object.fromEntries(
          (module.moduleImports || [])
            .filter((mi) => mi.bindings && mi.bindings.length)
            .map((mi) => [mi.depName, { bindings: mi.bindings }])
        ),
        { preferShared: !!options.includeSharedResolver }
      );
      const body = transformedContent.trim();
      lines.push(`const ${exportVar} = (() => {`);
      lines.push('const __sliceExports = {};');
      if (importBindings) lines.push(importBindings);
      if (body) lines.push(body);
      lines.push('return __sliceExports;');
      lines.push('})();');
      lines.push(`SLICE_BUNDLE_DEPENDENCIES[${JSON.stringify(module.name)}] = ${exportVar};`);
    });

    return lines.join('\n');
  }

  sortDependencyModulesTopologically(modules = []) {
    const byName = new Map(modules.map((module) => [module.name, module]));
    const visited = new Set();
    const ordered = [];
    const visit = (module, stack) => {
      if (visited.has(module.name) || stack.has(module.name)) return;
      stack.add(module.name);
      for (const imp of module.moduleImports || []) {
        const dependency = byName.get(imp.depName);
        if (dependency) visit(dependency, stack);
      }
      stack.delete(module.name);
      visited.add(module.name);
      ordered.push(module);
    };
    for (const module of modules) visit(module, new Set());
    return ordered;
  }

  async buildDependencyContents(jsContent, componentPath) {
    const dependencyContents = {};
    const visited = new Set();

    // Recursively resolve the relative-import graph rooted at `content`, so a
    // dependency module's OWN (transitive) imports are inlined too. Returns the
    // consumer's direct imports as [{ depName, bindings }].
    const resolveModule = async (content, basePath) => {
      const consumerImports = [];

      for (const dep of this.analyzeDependencies(content, basePath)) {
        const depName = path.relative(this.srcPath, dep.path).replace(/\\/g, '/');
        consumerImports.push({ depName, bindings: dep.bindings || [] });

        if (visited.has(depName)) continue;
        visited.add(depName);

        try {
          const depContent = await fs.readFile(dep.path, 'utf-8');
          // Resolve this module's own transitive imports first.
          const moduleImports = await resolveModule(depContent, path.dirname(dep.path));
          dependencyContents[depName] = { content: depContent, bindings: [], moduleImports };
        } catch (error) {
          console.warn(`Warning: Could not read dependency ${dep.path}:`, error.message);
        }
      }

      return consumerImports;
    };

    const directImports = await resolveModule(jsContent, componentPath);
    // The component's direct imports drive its class-factory bindings.
    for (const { depName, bindings } of directImports) {
      if (dependencyContents[depName]) {
        dependencyContents[depName].bindings = bindings;
      }
    }

    return dependencyContents;
  }

  /**
   * Cleans JavaScript code by removing imports/exports and ensuring class is available globally
   */
  cleanJavaScript(code, componentName, sourceContext = componentName) {
    // Remove export default
    code = code.replace(/export\s+default\s+/g, '');

    // Remove only unsupported imports (relative always removed, allowed absolute kept)
    const stripped = this.stripImports(code, {
      sourceContext,
      collectHoistedImports: true
    });
    const hoistedImports = stripped.hoistedImports || [];
    code = stripped.code;

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

    return {
      code,
      hoistedImports
    };
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

    const dependencyModules = this.collectDependencyModules(componentsData);
    const frameworkComponentKeys = Object.keys(componentsData || {});
    const frameworkClassIdentifiers = frameworkComponentKeys.map((key) => this.toSafeIdentifier(key));
    const frameworkReservedIdentifiers = new Set([
      'SLICE_BUNDLE',
      'SLICE_BUNDLE_COMPONENTS',
      'SLICE_BUNDLE_DEPENDENCIES',
      'SLICE_FRAMEWORK_CLASSES',
      ...frameworkClassIdentifiers,
      ...this.getDependencyExportVariableNames(dependencyModules)
    ]);
    const rawHoistedImports = Object.values(componentsData || {})
      .flatMap((component) => component?.hoistedImports || [])
      .map((statement) => String(statement).trim())
      .filter(Boolean);
    this.validateHoistedImportCollisions(rawHoistedImports, frameworkReservedIdentifiers);
    const hoistedImportBlock = Array.from(new Set(rawHoistedImports)).join('\n');

    const dependencyBlock = this.buildDependencyModuleBlock(componentsData);
    const componentBlock = this.buildComponentBundleBlock(componentsData);

    return `${hoistedImportBlock}${hoistedImportBlock ? '\n\n' : ''}/**
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
    const lines = [
      'const SLICE_BUNDLE_DEPENDENCIES = {};',
      ...this.getDefaultExportResolverLines()
    ];
    if (dependencyModules.length === 0) {
      return `${lines.join('\n')}`;
    }

    dependencyModules.forEach((module, index) => {
      const exportVar = `__sliceDepExports${index}`;
      // Each dependency lives in its own IIFE scope (see
      // buildV2DependencyModuleBlockFromModules) so private helpers cannot
      // collide across modules.
      const content = this.transformDependencyContent(module.content, '__sliceExports', module.name);
      const body = content.trim();
      lines.push(`// Dependency: ${module.name}`);
      lines.push(`const ${exportVar} = (() => {`);
      lines.push('const __sliceExports = {};');
      if (body) lines.push(body);
      lines.push('return __sliceExports;');
      lines.push('})();');
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

  collectDependencyModulesFromComponents(components = []) {
    const modules = new Map();
    for (const component of components || []) {
      const externalDependencies = component.externalDependencies || {};
      for (const [moduleName, entry] of Object.entries(externalDependencies)) {
        if (modules.has(moduleName)) continue;
        const content = typeof entry === 'string' ? entry : entry?.content;
        if (!content) continue;
        const moduleImports = (entry && typeof entry === 'object' ? entry.moduleImports : null) || [];
        modules.set(moduleName, { name: moduleName, content, moduleImports });
      }
    }
    return Array.from(modules.values());
  }

  getDependencyExportVariableNames(dependencyModules = []) {
    return (dependencyModules || []).map((_, index) => `__sliceDepExports${index}`);
  }

  transformDependencyContent(content, exportVar, moduleName) {
    let ast;
    try {
      ast = parse(content, { sourceType: 'module', plugins: ['jsx'] });
    } catch (error) {
      // Unparseable content (e.g. TS syntax): fall back to the regex transform
      // so we never lose a dependency entirely.
      return this.transformDependencyContentRegexFallback(content, exportVar, moduleName);
    }

    const fallbackKey = this.getDependencyDefaultFallbackKey(moduleName);
    const statements = ast.program.body
      .filter((node) => typeof node.start === 'number' && typeof node.end === 'number')
      .sort((a, b) => a.start - b.start);

    let cursor = 0;
    let output = '';
    for (const node of statements) {
      output += content.slice(cursor, node.start);
      output += this.transformDependencyStatement(node, content, exportVar, moduleName, fallbackKey);
      cursor = node.end;
    }
    output += content.slice(cursor);
    return output;
  }

  describeExportTarget(exportVar, name) {
    return /^[A-Za-z_$][\w$]*$/.test(name)
      ? `${exportVar}.${name}`
      : `${exportVar}[${JSON.stringify(name)}]`;
  }

  collectPatternIdentifiers(node, acc = []) {
    if (!node) return acc;
    switch (node.type) {
      case 'Identifier':
        acc.push(node.name);
        break;
      case 'ObjectPattern':
        for (const prop of node.properties) {
          if (prop.type === 'RestElement') {
            this.collectPatternIdentifiers(prop.argument, acc);
          } else {
            this.collectPatternIdentifiers(prop.value, acc);
          }
        }
        break;
      case 'ArrayPattern':
        for (const element of node.elements) {
          if (element) this.collectPatternIdentifiers(element, acc);
        }
        break;
      case 'AssignmentPattern':
        this.collectPatternIdentifiers(node.left, acc);
        break;
      case 'RestElement':
        this.collectPatternIdentifiers(node.argument, acc);
        break;
      default:
        break;
    }
    return acc;
  }

  transformExportedDeclaration(decl, content, exportVar) {
    const sourceOf = (n) => content.slice(n.start, n.end);

    if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
      const name = decl.id?.name;
      if (!name) return sourceOf(decl);
      // Keep the declaration so other code in the module can still reference the
      // name (intra-module references), then mirror it onto the exports object.
      // Each dependency is IIFE-scoped, so this local binding can't collide.
      return `${sourceOf(decl)}\n${this.describeExportTarget(exportVar, name)} = ${name};`;
    }

    if (decl.type === 'VariableDeclaration') {
      // Keep the declaration verbatim — preserving intra-module references and
      // initializer evaluation — then export every bound name.
      const names = [];
      for (const declarator of decl.declarations) {
        names.push(...this.collectPatternIdentifiers(declarator.id, []));
      }
      const assigns = names
        .map((n) => `${this.describeExportTarget(exportVar, n)} = ${n};`)
        .join('\n');
      return `${sourceOf(decl)}\n${assigns}`;
    }

    return sourceOf(decl);
  }

  transformDependencyStatement(node, content, exportVar, moduleName, fallbackKey) {
    const sourceOf = (n) => content.slice(n.start, n.end);

    if (node.type === 'ImportDeclaration') {
      // Transitive imports of a bundled dependency cannot be resolved at
      // runtime; strip them so they never leak into the emitted bundle.
      console.warn(this.buildImportWarningMessage(
        `Warning: Stripping unsupported import inside bundled dependency: ${node.source?.value}`,
        moduleName
      ));
      return '';
    }

    if (node.type === 'ExportAllDeclaration') {
      console.warn(this.buildImportWarningMessage(
        `Warning: Dropping unsupported 'export *' inside bundled dependency: ${node.source?.value}`,
        moduleName
      ));
      return '';
    }

    if (node.type === 'ExportDefaultDeclaration') {
      const declSource = sourceOf(node.declaration);
      const lines = [`${exportVar}.default = (${declSource});`];
      if (fallbackKey && fallbackKey !== 'default') {
        // Preserve the historical `<basename>Data` key so existing default
        // bindings (which pass it as the preferred key) keep resolving.
        lines.push(`${this.describeExportTarget(exportVar, fallbackKey)} = ${exportVar}.default;`);
      }
      return lines.join('\n');
    }

    if (node.type === 'ExportNamedDeclaration') {
      if (node.source) {
        console.warn(this.buildImportWarningMessage(
          `Warning: Dropping unsupported re-export inside bundled dependency: ${node.source.value}`,
          moduleName
        ));
        return '';
      }

      if (node.declaration) {
        return this.transformExportedDeclaration(node.declaration, content, exportVar);
      }

      // `export { local as exported, ... }` — key the exports object by the
      // PUBLIC (exported) name, mapped to the local binding's value.
      return node.specifiers
        .map((spec) => {
          const localName = spec.local.name;
          const exportedName = spec.exported.name ?? spec.exported.value;
          return `${this.describeExportTarget(exportVar, exportedName)} = ${localName};`;
        })
        .join('\n');
    }

    // Any other top-level statement is kept verbatim.
    return sourceOf(node);
  }

  transformDependencyContentRegexFallback(content, exportVar, moduleName) {
    const dataName = this.getDependencyDefaultFallbackKey(moduleName);
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

  getDependencyDefaultFallbackKey(moduleName) {
    const baseName = moduleName?.split('/').pop()?.replace(/\.[^.]+$/, '');
    return baseName ? `${baseName}Data` : null;
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

  buildDependencyBindings(externalDependencies, options = {}) {
    const lines = [];
    Object.entries(externalDependencies).forEach(([name, entry]) => {
      const bindings = typeof entry === 'string' ? [] : entry.bindings || [];
      const depVar = options.preferShared
        ? `__sliceResolveBundleDependency(${JSON.stringify(name)})`
        : `SLICE_BUNDLE_DEPENDENCIES[${JSON.stringify(name)}]`;

      bindings.forEach((binding) => {
        if (!binding?.localName) return;
        if (binding.type === 'default') {
          const preferredKey = this.getDependencyDefaultFallbackKey(name);
          lines.push(`const ${binding.localName} = __sliceResolveDefaultExport(${depVar}, ${JSON.stringify(name)}, ${JSON.stringify(preferredKey)});`);
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

  getBundleDependencyResolverLines() {
    return [
      "const __sliceSharedDeps = typeof window !== 'undefined' ? (window.__SLICE_SHARED_DEPS__ || {}) : {};",
      'const __sliceResolveBundleDependency = (depName) => Object.prototype.hasOwnProperty.call(__sliceSharedDeps, depName) ? __sliceSharedDeps[depName] : SLICE_BUNDLE_DEPENDENCIES[depName];'
    ];
  }

  getDefaultExportResolverLines() {
    return [
      'const __sliceDefaultExportWarningDeps = new Set();',
      "const __sliceDefaultExportPreferredKeys = ['module', 'exports', 'purify'];",
      'const __sliceDeterministicKeyCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);',
      'function __sliceResolveDefaultExport(dep, depName, preferredKey) {',
      '  if (dep?.default !== undefined) return dep.default;',
      "  if (dep === null || (typeof dep !== 'object' && typeof dep !== 'function')) return dep;",
      "  if (preferredKey && preferredKey !== 'default' && preferredKey !== '__esModule' && Object.prototype.hasOwnProperty.call(dep, preferredKey)) return dep[preferredKey];",
      "  const keys = Object.keys(dep).filter((key) => key !== 'default' && key !== '__esModule');",
      '  if (keys.length === 1) return dep[keys[0]];',
      '  if (keys.length > 1) {',
      '    const preferredMatches = __sliceDefaultExportPreferredKeys.filter((key) => keys.includes(key));',
      '    if (preferredMatches.length === 1) return dep[preferredMatches[0]];',
      '    const sortedKeys = [...keys].sort(__sliceDeterministicKeyCompare);',
      '    const fallbackKey = sortedKeys[0];',
      '    const warningDepName = depName || "<unknown dependency>";',
      '    if (!__sliceDefaultExportWarningDeps.has(warningDepName)) {',
      '      __sliceDefaultExportWarningDeps.add(warningDepName);',
      '      console.warn(`[Slice.js bundler] Ambiguous default export resolution for "${warningDepName}". Falling back to "${fallbackKey}". Keys: ${sortedKeys.join(\', \')}`);',
      '    }',
      '    return dep[fallbackKey];',
      '  }',
      '  return dep;',
      '}'
    ];
  }

  toSafeIdentifier(name) {
    // Injective encoding: every character outside [A-Za-z0-9] (including '_')
    // is escaped to `_<hex>_`. This guarantees that two distinct component
    // names can never collapse to the same identifier (e.g. "my-btn" and
    // "my_btn" used to both yield "SliceComponent_my_btn", emitting duplicate
    // `const` declarations and producing invalid bundle JS). The leading
    // `SliceComponent_` prefix keeps the result a valid identifier even when
    // the name starts with a digit.
    const encoded = String(name).replace(
      /[^a-zA-Z0-9]/g,
      (char) => `_${char.charCodeAt(0).toString(16)}_`
    );
    return `SliceComponent_${encoded}`;
  }

  /**
   * Generates the bundle configuration
   */
  generateBundleConfig(frameworkBundle = null) {
    const metrics = this.analysisData.metrics || {};
    const config = {
      version: '2.0.0',
      format: this.format,
      loadingPolicy: this.loadingPolicy,
      strategy: this.config.strategy,
      minified: this.options.minify,
      obfuscated: this.options.obfuscate,
      production: true,
      generated: new Date().toISOString(),

      stats: {
        totalComponents: metrics.totalComponents || 0,
        totalRoutes: metrics.totalRoutes || 0,
        sharedComponents: this.bundles.critical.components.length,
        sharedPercentage: metrics.sharedPercentage || 0,
        totalSize: metrics.totalSize || 0,
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
        // Only advertise the vendor-shared bundle when it was actually emitted
        // (i.e. there were shared dependencies). Otherwise the config would
        // reference a file that does not exist on disk -> 404 for any runtime
        // that resolves it.
        vendorShared: this.vendorShared.bundle
          ? {
              bundleKey: 'vendor-shared',
              type: 'vendor-shared',
              file: this.vendorShared.file,
              size: this.vendorShared.bundle?.size || 0,
              hash: this.vendorShared.bundle?.hash || null,
              integrity: this.vendorShared.bundle?.integrity || null,
              dependencies: Array.from(this.vendorShared.sharedDependencySet).sort((a, b) => a.localeCompare(b)),
              dependencyCount: this.vendorShared.sharedDependencySet.size,
              routes: Array.from(this.vendorShared.bundleKeysUsingSharedDependencies).sort((a, b) => a.localeCompare(b))
            }
          : null,
        critical: {
          file: this.bundles.critical.file,
          size: this.bundles.critical.size,
          hash: this.bundles.critical.hash || null,
          integrity: this.bundles.critical.integrity || null,
          components: this.bundles.critical.components.map(c => c.name)
        },
        routes: {}
      },
      routeBundles: {},
      routeDependencyGraph: {}
    };

    for (const [key, bundle] of Object.entries(this.bundles.routes)) {
      const routeIdentifier = Array.isArray(bundle.path || bundle.paths)
        ? key
        : (bundle.path || bundle.paths || key);
      const usesVendorShared = this.vendorShared.bundleKeysUsingSharedDependencies.has(key)
        || (bundle.dependencies || []).includes('vendor-shared');
      const dependencies = this.mergeBundleDependencies(
        bundle.dependencies || [],
        usesVendorShared ? ['vendor-shared'] : []
      );

      config.bundles.routes[key] = {
        path: bundle.path || bundle.paths || key, // Support both single path and array of paths, fallback to key
        file: `slice-bundle.${this.routeToFileName(routeIdentifier)}.js`,
        size: bundle.size,
        hash: bundle.hash || null,
        integrity: bundle.integrity || null,
        components: bundle.components.map(c => c.name),
        dependencies
      };

      const paths = Array.isArray(config.bundles.routes[key].path)
        ? config.bundles.routes[key].path
        : [config.bundles.routes[key].path];

      for (const routePath of paths) {
        if (!config.routeBundles[routePath]) {
          config.routeBundles[routePath] = ['critical'];
        }
        for (const dependency of dependencies.filter((dep) => dep !== 'critical')) {
          if (!config.routeBundles[routePath].includes(dependency)) {
            config.routeBundles[routePath].push(dependency);
          }
        }
        if (!config.routeBundles[routePath].includes(key)) {
          config.routeBundles[routePath].push(key);
        }

        const graphEntry = config.routeDependencyGraph[routePath] || {
          bundles: [],
          edges: []
        };
        if (!graphEntry.bundles.includes(key)) {
          graphEntry.bundles.push(key);
          graphEntry.bundles.sort((a, b) => a.localeCompare(b));
        }

        const edgeKeys = new Set(graphEntry.edges.map((edge) => `${edge.from}->${edge.to}`));
        const orderedEdgeSources = ['critical', ...dependencies.filter((dependency) => dependency !== 'critical')];
        for (const source of orderedEdgeSources) {
          const edgeKey = `${source}->${key}`;
          if (!edgeKeys.has(edgeKey)) {
            graphEntry.edges.push({ from: source, to: key });
            edgeKeys.add(edgeKey);
          }
        }

        config.routeDependencyGraph[routePath] = graphEntry;
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
      const cleanedJavaScript = this.cleanJavaScript(jsContent, comp.name, jsPath);

      componentsData[componentKey] = {
        name: comp.name,
        category: comp.category,
        categoryType: comp.categoryType,
        isFramework: true,
        js: cleanedJavaScript.code,
        hoistedImports: cleanedJavaScript.hoistedImports,
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

  getConfiguredPublicFolders() {
    const publicFolders = Array.isArray(this.sliceConfig?.publicFolders)
      ? this.sliceConfig.publicFolders
      : [];

    return publicFolders
      .map((folder) => this.normalizePublicFolder(folder))
      .filter(Boolean);
  }

  normalizePublicFolder(folder) {
    if (typeof folder !== 'string') return null;
    let normalized = folder.trim();
    if (!normalized) return null;

    if (!normalized.startsWith('/')) {
      normalized = `/${normalized}`;
    }

    normalized = normalized.replace(/\\+/g, '/').replace(/\/+/g, '/');
    if (normalized.length > 1 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }

    return normalized;
  }

  normalizeImportPath(importPath) {
    if (typeof importPath !== 'string') return '';
    const cleanPath = importPath.split(/[?#]/)[0];
    return cleanPath.replace(/\\+/g, '/').replace(/\/+/g, '/');
  }

  isRelativeImport(importPath) {
    return importPath.startsWith('./') || importPath.startsWith('../');
  }

  isAbsoluteImport(importPath) {
    return importPath.startsWith('/');
  }

  isImportInPublicFolders(importPath, publicFolders) {
    const normalizedImport = this.normalizeImportPath(importPath);
    return publicFolders.some((folder) => normalizedImport === folder || normalizedImport.startsWith(`${folder}/`));
  }

  classifyImport(importPath, publicFolders) {
    if (typeof importPath !== 'string' || !importPath) {
      return { keep: false, warning: 'Warning: Removing bare import: <unknown>' };
    }

    if (this.isRelativeImport(importPath)) {
      return { keep: false, warning: null };
    }

    if (this.isAbsoluteImport(importPath)) {
      if (this.isImportInPublicFolders(importPath, publicFolders)) {
        return { keep: true, warning: null };
      }

      return {
        keep: false,
        warning: `Warning: Removing absolute import outside publicFolders: ${importPath}`
      };
    }

    return {
      keep: false,
      warning: `Warning: Removing bare import: ${importPath}`
    };
  }

  buildImportWarningMessage(baseMessage, sourceContext) {
    if (!sourceContext) return baseMessage;
    return `${baseMessage} [${sourceContext}]`;
  }

  extractLocalBindingsFromImportStatement(statement) {
    const source = String(statement || '').trim();
    if (!source.startsWith('import ')) return [];
    if (/^import\s+['"][^'"]+['"]\s*;?$/.test(source)) return [];

    const bindings = [];

    const defaultMatch = source.match(/^import\s+([A-Za-z_$][\w$]*)\s*(,|\s+from\s+)/);
    if (defaultMatch && defaultMatch[1] !== '*') {
      bindings.push(defaultMatch[1]);
    }

    const namespaceMatch = source.match(/,?\s*\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]/);
    if (namespaceMatch) {
      bindings.push(namespaceMatch[1]);
    }

    const namedMatch = source.match(/\{([\s\S]*?)\}\s*from\s*['"]/);
    if (namedMatch) {
      const namedSection = namedMatch[1];
      for (const part of namedSection.split(',')) {
        const cleanPart = part.trim();
        if (!cleanPart) continue;
        const aliasParts = cleanPart.split(/\s+as\s+/i).map((v) => v.trim()).filter(Boolean);
        const localName = aliasParts.length > 1 ? aliasParts[1] : aliasParts[0];
        if (/^[A-Za-z_$][\w$]*$/.test(localName)) {
          bindings.push(localName);
        }
      }
    }

    return Array.from(new Set(bindings));
  }

  validateHoistedImportCollisions(importStatements, reservedIdentifiers = new Set()) {
    const reserved = reservedIdentifiers instanceof Set
      ? reservedIdentifiers
      : new Set(reservedIdentifiers || []);
    const bindingToStatement = new Map();

    for (const statement of importStatements || []) {
      const normalizedStatement = String(statement || '').trim();
      if (!normalizedStatement) continue;
      const localBindings = this.extractLocalBindingsFromImportStatement(normalizedStatement);

      for (const localBinding of localBindings) {
        if (reserved.has(localBinding)) {
          throw new Error(`Hoisted import reserved identifier collision: ${localBinding}`);
        }
        const previousStatement = bindingToStatement.get(localBinding);
        if (previousStatement && previousStatement !== normalizedStatement) {
          throw new Error(`Hoisted import binding collision: ${localBinding}`);
        }
        bindingToStatement.set(localBinding, normalizedStatement);
      }
    }
  }

  parseImportsFromCode(code) {
    const ast = parse(code, {
      sourceType: 'module',
      plugins: ['jsx']
    });

    const importNodes = [];
    traverse.default(ast, {
      ImportDeclaration(pathNode) {
        importNodes.push(pathNode.node);
      }
    });

    return importNodes
      .filter((node) => typeof node.start === 'number' && typeof node.end === 'number')
      .sort((a, b) => a.start - b.start);
  }

  parseImportsWithFallbackScanner(code) {
    const entries = [];
    const importRegex = /\bimport\b/g;
    let match = null;

    while ((match = importRegex.exec(code)) !== null) {
      const start = match.index;
      const nextChar = code[start + 'import'.length];
      if (nextChar === '(') {
        continue;
      }

      let index = start + 'import'.length;
      let quote = null;
      let escaped = false;

      while (index < code.length) {
        const char = code[index];

        if (quote) {
          if (escaped) {
            escaped = false;
          } else if (char === '\\') {
            escaped = true;
          } else if (char === quote) {
            quote = null;
          }
          index += 1;
          continue;
        }

        if (char === '\'' || char === '"' || char === '`') {
          quote = char;
          index += 1;
          continue;
        }

        if (char === ';') {
          index += 1;
          break;
        }

        index += 1;
      }

      const end = index;
      const statement = code.slice(start, end);
      const fromMatch = statement.match(/\bfrom\s+['"]([^'"]+)['"]/);
      const sideEffectMatch = statement.match(/\bimport\s+['"]([^'"]+)['"]/);
      const importPath = fromMatch?.[1] || sideEffectMatch?.[1] || null;

      if (!importPath) {
        continue;
      }

      entries.push({ start, end, statement, importPath });
      importRegex.lastIndex = end;
    }

    return entries;
  }

  stripImportsWithFallbackRegex(code, publicFolders, sourceContext, collectHoistedImports) {
    const hoistedImports = [];
    const importEntries = this.parseImportsWithFallbackScanner(code);
    if (importEntries.length === 0) {
      return { code, hoistedImports };
    }

    let cleanedCode = '';
    let cursor = 0;
    for (const entry of importEntries) {
      const { start, end, statement, importPath } = entry;
      const classification = this.classifyImport(importPath, publicFolders);
      cleanedCode += code.slice(cursor, start);
      if (classification.keep) {
        if (collectHoistedImports) {
          hoistedImports.push(statement.trim());
        } else {
          cleanedCode += statement;
        }
      } else if (classification.warning) {
        console.warn(this.buildImportWarningMessage(classification.warning, sourceContext));
      }
      cursor = end;
    }

    cleanedCode += code.slice(cursor);

    return { code: cleanedCode, hoistedImports };
  }

  stripImports(code, options = {}) {
    const { sourceContext = null, collectHoistedImports = false } = options;
    const publicFolders = this.getConfiguredPublicFolders();
    const hoistedImports = [];

    try {
      const importNodes = this.parseImportsFromCode(code);

      if (importNodes.length === 0) {
        return collectHoistedImports ? { code, hoistedImports } : code;
      }

      let cleaned = '';
      let cursor = 0;

      for (const node of importNodes) {
        const importPath = node.source?.value;
        const classification = this.classifyImport(importPath, publicFolders);
        const statement = code.slice(node.start, node.end);

        cleaned += code.slice(cursor, node.start);
        if (classification.keep) {
          if (collectHoistedImports) {
            hoistedImports.push(statement.trim());
          } else {
            cleaned += statement;
          }
        } else if (classification.warning) {
          console.warn(this.buildImportWarningMessage(classification.warning, sourceContext));
        }

        cursor = node.end;
      }

      cleaned += code.slice(cursor);
      return collectHoistedImports
        ? { code: cleaned, hoistedImports }
        : cleaned;
    } catch (error) {
      const fallback = this.stripImportsWithFallbackRegex(code, publicFolders, sourceContext, collectHoistedImports);
      return collectHoistedImports ? fallback : fallback.code;
    }
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
