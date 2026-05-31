// cli/utils/bundling/DependencyAnalyzer.js
import fs from 'fs-extra';
import path from 'path';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import { getSrcPath, getComponentsJsPath, getConfigPath, getPath } from '../PathHelper.js';

export default class DependencyAnalyzer {
  constructor(moduleUrl) {
    this.moduleUrl = moduleUrl;
    this.componentsPath = path.dirname(getComponentsJsPath(moduleUrl));
    this.frameworkComponentsPath = getPath(moduleUrl, 'node_modules', 'slicejs-web-framework', 'Slice', 'Components', 'Structural');
    this.routesPath = getSrcPath(moduleUrl, 'routes.js');

    // Analysis storage
    this.components = new Map();
    this.routes = new Map();
    this.dependencyGraph = new Map();
  }

  /**
   * Executes complete project analysis
   */
  async analyze() {
    console.log('🔍 Analyzing project...');

    // 1. Load component configuration
    await this.loadComponentsConfig();

    // 2. Analyze component files
    await this.analyzeComponents();
    await this.analyzeFrameworkComponents();

    // 3. Load and analyze routes
    await this.analyzeRoutes();

    // 4. Build dependency graph
    this.buildDependencyGraph();

    // 5. Calculate metrics
    const metrics = this.calculateMetrics();

    console.log('✅ Analysis completed');

    return {
      components: Array.from(this.components.values()),
      routes: Array.from(this.routes.values()),
      dependencyGraph: this.dependencyGraph,
      routeGroups: this.routeGroups,
      metrics
    };
  }

  /**
   * Loads component configuration from components.js
   */
  async loadComponentsConfig() {
    const componentsConfigPath = path.join(this.componentsPath, 'components.js');
    const configPath = getConfigPath(this.moduleUrl);
    let sliceConfig = {};

    if (!await fs.pathExists(componentsConfigPath)) {
      throw new Error('components.js not found');
    }

    if (await fs.pathExists(configPath)) {
      try {
        sliceConfig = await fs.readJson(configPath);
      } catch (error) {
        console.warn('Warning: Could not read sliceConfig.json for component paths:', error.message);
      }
    }

    // Read and parse components.js
    const content = await fs.readFile(componentsConfigPath, 'utf-8');

    const config = this.parseComponentsConfig(content);

    // Group components by category
    const categoryMap = new Map();

    // Build category map from component assignments
    for (const [componentName, categoryName] of Object.entries(config)) {
      if (!categoryMap.has(categoryName)) {
        categoryMap.set(categoryName, []);
      }
      categoryMap.get(categoryName).push(componentName);
    }

    // Process each category
    for (const [categoryName, componentList] of categoryMap) {
      const configCategory = sliceConfig?.paths?.components?.[categoryName];

      // Determine category type based on config or category name
      let categoryType = configCategory?.type || 'Visual';
      if (categoryName === 'Service') categoryType = 'Service';
      if (categoryName === 'AppComponents') categoryType = 'Visual'; // AppComponents are visual

      // Resolve category path from config if available
      let categoryPath = path.join(this.componentsPath, categoryName);
      if (configCategory?.path) {
        categoryPath = getSrcPath(this.moduleUrl, configCategory.path);
      }

      if (await fs.pathExists(categoryPath)) {
        const files = await fs.readdir(categoryPath);

        for (const file of files) {
          const componentPath = path.join(categoryPath, file);
          const stat = await fs.stat(componentPath);

          if (stat.isDirectory() && componentList.includes(file)) {
            this.components.set(file, {
              name: file,
              category: categoryName,
              categoryType: categoryType,
              path: componentPath,
              dependencies: new Set(),
              usedBy: new Set(),
              routes: new Set(),
              size: 0
            });
          }
        }
      }
    }
  }

  /**
   * Parses components.js safely using AST (no eval).
   * @param {string} content
   * @returns {Record<string, string>}
   */
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
      throw new Error(`Could not parse components.js: ${error.message}`);
    }
  }


  /**
   * Extracts string values from AST nodes.
   * @param {object} node
   * @returns {string|null}
   */
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
   * Analyzes each component's files
   */
  async analyzeComponents() {
    for (const [name, component] of this.components) {
      const jsFile = path.join(component.path, `${name}.js`);

      if (!await fs.pathExists(jsFile)) continue;

      // Read JavaScript file
      const content = await fs.readFile(jsFile, 'utf-8');

      // Calculate size
      component.size = await this.calculateComponentSize(component.path);

      // Parse and extract dependencies
      component.dependencies = await this.extractDependencies(content, jsFile);
    }
  }

  async analyzeFrameworkComponents() {
    if (!await fs.pathExists(this.frameworkComponentsPath)) {
      return;
    }
    const frameworkConfigPath = getConfigPath(this.moduleUrl);
    let frameworkConfig = {};
    try {
      frameworkConfig = await fs.readJson(frameworkConfigPath);
    } catch (error) {
      console.warn('Warning: Could not read sliceConfig.json for framework bundling:', error.message);
    }

    const enabledStructural = this.getEnabledStructuralComponents(frameworkConfig);
    const componentEntries = await fs.readdir(this.frameworkComponentsPath);

    for (const componentName of componentEntries) {
      if (!enabledStructural.has(componentName)) {
        continue;
      }

      const componentPath = path.join(this.frameworkComponentsPath, componentName);
      const componentStat = await fs.stat(componentPath);
      if (!componentStat.isDirectory()) continue;

      const key = `Framework/Structural/${componentName}`;
      if (this.components.has(key)) continue;

      this.components.set(key, {
        name: componentName,
        category: 'Framework/Structural',
        categoryType: 'Visual',
        path: componentPath,
        dependencies: new Set(),
        usedBy: new Set(),
        routes: new Set(),
        size: 0,
        isFramework: true
      });
    }

    if (enabledStructural.has('EventManagerDebugger')) {
      this.addFrameworkFileComponent('EventManagerDebugger', 'EventManager');
    }

    if (enabledStructural.has('ContextManagerDebugger')) {
      this.addFrameworkFileComponent('ContextManagerDebugger', 'ContextManager');
    }

    if (enabledStructural.has('ThemeManager')) {
      this.addFrameworkFileComponent('ThemeManager', path.join('StylesManager', 'ThemeManager'));
    }
  }

  addFrameworkFileComponent(componentName, folderName) {
    const componentPath = path.join(this.frameworkComponentsPath, folderName);
    const key = `Framework/Structural/${componentName}`;

    if (this.components.has(key)) return;

    this.components.set(key, {
      name: componentName,
      fileName: componentName,
      category: 'Framework/Structural',
      categoryType: 'Visual',
      path: componentPath,
      dependencies: new Set(),
      usedBy: new Set(),
      routes: new Set(),
      size: 0,
      isFramework: true
    });
  }

  getEnabledStructuralComponents(config) {
    const enabled = new Set(['Controller', 'Router', 'StylesManager']);

    if (config?.logger?.enabled) {
      enabled.add('Logger');
    }

    if (config?.debugger?.enabled) {
      enabled.add('Debugger');
    }

    if (config?.events?.enabled) {
      enabled.add('EventManager');
    }

    if (config?.events?.ui?.enabled) {
      enabled.add('EventManagerDebugger');
    }

    if (config?.context?.enabled) {
      enabled.add('ContextManager');
    }

    if (config?.context?.ui?.enabled) {
      enabled.add('ContextManagerDebugger');
    }

    if (config?.themeManager?.enabled) {
      enabled.add('ThemeManager');
    }

    return enabled;
  }

  /**
   * Extracts dependencies from a component file
   */
  async extractDependencies(code, componentFilePath = null) {
    const dependencies = new Set();

    const resolveRoutesArray = (node, scope) => {
      if (!node) return null;

      if (node.type === 'ArrayExpression') {
        return node;
      }

      if (node.type === 'CallExpression') {
        const calleeName = node.callee?.name || null;
        if (calleeName && node.arguments?.length) {
          const firstArg = node.arguments[0];
          const resolvedObject = resolveObjectExpression(firstArg, scope);
          if (resolvedObject) {
            return resolvedObject;
          }
        }
      }

      if (node.type === 'ObjectExpression') {
        const routesProp = node.properties.find(p => p.key?.name === 'routes');
        if (routesProp?.value) {
          return resolveRoutesArray(routesProp.value, scope);
        }
      }

      if (node.type === 'Identifier' && scope) {
        const binding = scope.getBinding(node.name);
        if (!binding) return null;
        const bindingNode = binding.path?.node;

        if (bindingNode?.type === 'VariableDeclarator') {
          const init = bindingNode.init;
          if (init?.type === 'ArrayExpression') {
            return init;
          }

          if (init?.type === 'CallExpression') {
            return resolveRoutesArray(init, binding.path.scope);
          }

          if (init?.type === 'Identifier') {
            return resolveRoutesArray(init, binding.path.scope);
          }

          if (init?.type === 'ObjectExpression') {
            return resolveRoutesArray(init, binding.path.scope);
          }

          if (init?.type === 'MemberExpression') {
            return resolveRoutesArray(init, binding.path.scope);
          }
        }

        if (bindingNode?.type === 'ImportSpecifier' || bindingNode?.type === 'ImportDefaultSpecifier') {
          const parent = binding.path.parentPath?.node;
          if (parent?.type === 'ImportDeclaration') {
            const importedName = bindingNode.type === 'ImportDefaultSpecifier'
              ? 'default'
              : bindingNode.imported?.name;
            const importedNode = resolveImportedValue(parent.source.value, importedName, componentFilePath);
            return resolveRoutesArray(importedNode, null);
          }
        }
      }

      if (node.type === 'MemberExpression' && scope) {
        const objectNode = resolveObjectExpression(node.object, scope);
        if (objectNode) {
          const propName = node.property?.name || node.property?.value;
          if (propName) {
            const prop = objectNode.properties.find(p => p.key?.name === propName || p.key?.value === propName);
            if (prop?.value) {
              return resolveRoutesArray(prop.value, scope);
            }
          }
        }
      }

      return null;
    };

    const resolveObjectExpression = (node, scope) => {
      if (!node) return null;
      if (node.type === 'ObjectExpression') return node;

      if (node.type === 'Identifier' && scope) {
        const binding = scope.getBinding(node.name);
        const bindingNode = binding?.path?.node;
        if (bindingNode?.type === 'VariableDeclarator') {
          const init = bindingNode.init;
          if (init?.type === 'ObjectExpression') {
            return init;
          }
          if (init?.type === 'Identifier') {
            return resolveObjectExpression(init, binding.path.scope);
          }
        }

        if (bindingNode?.type === 'ImportSpecifier' || bindingNode?.type === 'ImportDefaultSpecifier') {
          const parent = binding.path.parentPath?.node;
          if (parent?.type === 'ImportDeclaration') {
            const importedName = bindingNode.type === 'ImportDefaultSpecifier'
              ? 'default'
              : bindingNode.imported?.name;
            const importedNode = resolveImportedValue(parent.source.value, importedName, componentFilePath);
            return resolveObjectExpression(importedNode, null);
          }
        }
      }

      return null;
    };

    const resolveStringValue = (node, scope) => {
      if (!node) return null;
      if (node.type === 'StringLiteral') return node.value;
      if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
        return node.quasis.map(q => q.value.cooked).join('');
      }

      if (node.type === 'Identifier' && scope) {
        const binding = scope.getBinding(node.name);
        const bindingNode = binding?.path?.node;
        if (bindingNode?.type === 'VariableDeclarator') {
          return resolveStringValue(bindingNode.init, binding.path.scope);
        }

        if (bindingNode?.type === 'ImportSpecifier' || bindingNode?.type === 'ImportDefaultSpecifier') {
          const parent = binding.path.parentPath?.node;
          if (parent?.type === 'ImportDeclaration') {
            const importedName = bindingNode.type === 'ImportDefaultSpecifier'
              ? 'default'
              : bindingNode.imported?.name;
            const importedNode = resolveImportedValue(parent.source.value, importedName, componentFilePath);
            return resolveStringValue(importedNode, null);
          }
        }
      }

      if (node.type === 'MemberExpression' && scope) {
        const objectNode = resolveObjectExpression(node.object, scope);
        if (objectNode) {
          const propName = node.property?.name || node.property?.value;
          if (propName) {
            const prop = objectNode.properties.find(p => p.key?.name === propName || p.key?.value === propName);
            if (prop?.value) {
              return resolveStringValue(prop.value, scope);
            }
          }
        }
      }

      return null;
    };

    const resolveImportedValue = (importPath, importedName, fromFilePath) => {
      if (!fromFilePath) return null;

      const baseDir = path.dirname(fromFilePath);
      const resolvedPath = resolveImportPath(importPath, baseDir);
      if (!resolvedPath) {
        console.warn(`⚠️  Cannot resolve import for MultiRoute routes: ${importPath}`);
        return null;
      }

      const cacheKey = `${resolvedPath}:${importedName || 'default'}`;
      if (!resolveImportedValue.cache) {
        resolveImportedValue.cache = new Map();
      }
      if (resolveImportedValue.cache.has(cacheKey)) {
        return resolveImportedValue.cache.get(cacheKey);
      }

      try {
        const source = fs.readFileSync(resolvedPath, 'utf-8');
        const importAst = parse(source, {
          sourceType: 'module',
          plugins: ['jsx']
        });

        const topLevelBindings = new Map();
        for (const node of importAst.program.body) {
          if (node.type === 'VariableDeclaration') {
            node.declarations.forEach(decl => {
              if (decl.id?.type === 'Identifier') {
                topLevelBindings.set(decl.id.name, decl.init);
              }
            });
          }
        }

        let exportNode = null;
        for (const node of importAst.program.body) {
          if (node.type === 'ExportDefaultDeclaration' && importedName === 'default') {
            exportNode = node.declaration;
            break;
          }

          if (node.type === 'ExportNamedDeclaration') {
            if (node.declaration?.type === 'VariableDeclaration') {
              for (const decl of node.declaration.declarations) {
                if (decl.id?.name === importedName) {
                  exportNode = decl.init;
                  break;
                }
              }
            }

            if (!exportNode && node.specifiers?.length) {
              const specifier = node.specifiers.find(s => s.exported?.name === importedName);
              if (specifier && specifier.local?.name) {
                exportNode = topLevelBindings.get(specifier.local.name) || null;
              }
            }
          }

          if (exportNode) break;
        }

        if (exportNode?.type === 'Identifier') {
          exportNode = topLevelBindings.get(exportNode.name) || exportNode;
        }

        resolveImportedValue.cache.set(cacheKey, exportNode || null);
        return exportNode || null;
      } catch (error) {
        console.warn(`⚠️  Error resolving import ${importPath}: ${error.message}`);
        resolveImportedValue.cache.set(cacheKey, null);
        return null;
      }
    };

    const resolveImportPath = (importPath, baseDir) => {
      if (!importPath.startsWith('.')) return null;

      const resolvedBase = path.resolve(baseDir, importPath);
      const extensions = ['.js', '.mjs', '.cjs', '.json'];

      if (fs.existsSync(resolvedBase) && fs.statSync(resolvedBase).isFile()) {
        return resolvedBase;
      }

      if (!path.extname(resolvedBase)) {
        for (const ext of extensions) {
          const candidate = resolvedBase + ext;
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        }
      }

      return null;
    };

    const addRouteConfigDependencies = (routesConfigNode, scope) => {
      if (!routesConfigNode || routesConfigNode.type !== 'ObjectExpression') return;

      const processObject = (node) => {
        if (!node || node.type !== 'ObjectExpression') return;

        const componentProp = node.properties.find(p => p.key?.name === 'component');
        if (componentProp?.value) {
          const componentName = resolveStringValue(componentProp.value, scope);
          if (componentName) {
            dependencies.add(componentName);
          }
        }

        const itemsProp = node.properties.find(p => p.key?.name === 'items');
        if (itemsProp?.value) {
          const itemsNode = resolveRoutesArray(itemsProp.value, scope);
          addMultiRouteDependencies(itemsNode, scope);
        }

        node.properties.forEach((prop) => {
          const valueNode = prop.value;
          if (valueNode?.type === 'ObjectExpression') {
            processObject(valueNode);
          }
        });
      };

      processObject(routesConfigNode);
    };

    const addMultiRouteDependencies = (routesArrayNode, scope) => {
      if (!routesArrayNode) return;

      if (routesArrayNode.type === 'ObjectExpression') {
        addRouteConfigDependencies(routesArrayNode, scope);
        return;
      }

      if (routesArrayNode.type !== 'ArrayExpression') return;

      routesArrayNode.elements.forEach(routeElement => {
        if (!routeElement) return;

        if (routeElement.type === 'SpreadElement') {
          const spreadArray = resolveRoutesArray(routeElement.argument, scope);
          addMultiRouteDependencies(spreadArray, scope);
          return;
        }

        const routeObject = resolveObjectExpression(routeElement, scope) || routeElement;
        if (routeObject?.type === 'ObjectExpression') {
          const componentProp = routeObject.properties.find(p => p.key?.name === 'component');
          if (componentProp?.value) {
            const componentName = resolveStringValue(componentProp.value, scope);
            if (componentName) {
              dependencies.add(componentName);
            }
          }

          const itemsProp = routeObject.properties.find(p => p.key?.name === 'items');
          if (itemsProp?.value) {
            const itemsNode = resolveRoutesArray(itemsProp.value, scope);
            addMultiRouteDependencies(itemsNode, scope);
          }
        }
      });
    };

    try {
      const ast = parse(code, {
        sourceType: 'module',
        plugins: ['jsx']
      });

      traverse.default(ast, {
        // Detect slice.build() calls
        CallExpression(path) {
          const { callee, arguments: args } = path.node;

          // slice.build('MultiRoute', { routes: [...] })
          if (
            callee.type === 'MemberExpression' &&
            callee.object.name === 'slice' &&
            callee.property.name === 'build' &&
            args[0]?.type === 'StringLiteral' &&
            args[0].value === 'MultiRoute' &&
            args[1]?.type === 'ObjectExpression'
          ) {
            // Add MultiRoute itself
            dependencies.add('MultiRoute');

            // Extract routes from MultiRoute props
            const routesProp = args[1].properties.find(p => p.key?.name === 'routes');
            if (routesProp) {
              const routesArrayNode = resolveRoutesArray(routesProp.value, path.scope);
              addMultiRouteDependencies(routesArrayNode);
            }
          }
          // Regular slice.build() calls
          else if (
            callee.type === 'MemberExpression' &&
            callee.object.name === 'slice' &&
            callee.property.name === 'build' &&
            args[0]?.type === 'StringLiteral'
          ) {
            dependencies.add(args[0].value);
          }
        },

        // Detect direct imports (less common but possible)
        ImportDeclaration(path) {
          const importPath = path.node.source.value;
          if (importPath.includes('/Components/')) {
            const componentName = importPath.split('/').pop();
            dependencies.add(componentName);
          }
        }
      });
    } catch (error) {
      console.warn(`⚠️  Error parsing component: ${error.message}`);
    }

    return dependencies;
  }

  /**
   * Analyzes the routes file and detects route groups
   */
  async analyzeRoutes() {
    if (!await fs.pathExists(this.routesPath)) {
      throw new Error(`routes.js not found at expected path: ${this.routesPath}. Ensure your routes.js file exists in the src directory.`);
    }

    const content = await fs.readFile(this.routesPath, 'utf-8');

    try {
      const ast = parse(content, {
        sourceType: 'module',
        plugins: ['jsx']
      });

      let currentRoute = null;
      const self = this; // Save reference to instance

      traverse.default(ast, {
        ObjectExpression(path) {
          // Look for route objects: { path: '/', component: 'HomePage' }
          const properties = path.node.properties;
          const pathProp = properties.find(p => p.key?.name === 'path');
          const componentProp = properties.find(p => p.key?.name === 'component');

          if (pathProp && componentProp) {
            const routePath = pathProp.value.value;
            const componentName = componentProp.value.value;

            currentRoute = {
              path: routePath,
              component: componentName,
              dependencies: new Set([componentName])
            };

            self.routes.set(routePath, currentRoute);

            // Mark the component as used by this route
            if (self.components.has(componentName)) {
              self.components.get(componentName).routes.add(routePath);
            }
          }
        }
      });

      // Detect and store route groups based on MultiRoute usage
      this.routeGroups = this.detectRouteGroups();

    } catch (error) {
      console.warn(`⚠️  Error parsing routes at ${this.routesPath}: ${error.message}`);
    }
  }

  /**
   * Builds the complete dependency graph
   */
  buildDependencyGraph() {
    // Propagate transitive dependencies
    for (const [name, component] of this.components) {
      this.dependencyGraph.set(name, this.getAllDependencies(name, new Set()));
    }

    // Calculate usedBy (inverse dependencies)
    for (const [name, deps] of this.dependencyGraph) {
      for (const dep of deps) {
        if (this.components.has(dep)) {
          this.components.get(dep).usedBy.add(name);
        }
      }
    }
  }

  /**
   * Detects route groups based on MultiRoute usage
   */
  detectRouteGroups() {
    const routeGroups = new Map();

    for (const [componentName, component] of this.components) {
      // Check if component uses MultiRoute
      const hasMultiRoute = Array.from(component.dependencies).includes('MultiRoute');

      if (hasMultiRoute) {
        // Find all routes that point to this component
        const relatedRoutes = Array.from(this.routes.values())
          .filter(route => route.component === componentName);

        if (relatedRoutes.length > 1) {
          // Group these routes together
          const groupKey = `multiroute-${componentName}`;
          routeGroups.set(groupKey, {
            component: componentName,
            routes: relatedRoutes.map(r => r.path),
            type: 'multiroute'
          });

          // Mark component as multiroute handler
          component.isMultiRouteHandler = true;
          component.multiRoutePaths = relatedRoutes.map(r => r.path);
        }
      }
    }

    return routeGroups;
  }

  /**
   * Gets all dependencies of a component (recursive)
   */
  getAllDependencies(componentName, visited = new Set()) {
    if (visited.has(componentName)) return new Set();
    visited.add(componentName);

    const component = this.components.get(componentName);
    if (!component) return new Set();

    const allDeps = new Set(component.dependencies);

    for (const dep of component.dependencies) {
      const transitiveDeps = this.getAllDependencies(dep, visited);
      for (const transDep of transitiveDeps) {
        allDeps.add(transDep);
      }
    }

    return allDeps;
  }

  /**
   * Calculates the total size of a component (JS + HTML + CSS)
   */
  async calculateComponentSize(componentPath) {
    let totalSize = 0;
    const files = await fs.readdir(componentPath);

    for (const file of files) {
      const filePath = path.join(componentPath, file);
      const stat = await fs.stat(filePath);

      if (stat.isFile()) {
        totalSize += stat.size;
      }
    }

    return totalSize;
  }

  /**
   * Calculates project metrics
   */
  calculateMetrics() {
    const totalComponents = this.components.size;
    const totalRoutes = this.routes.size;

    // Shared components (used in multiple routes)
    const sharedComponents = Array.from(this.components.values())
      .filter(c => c.routes.size >= 2);

    // Total size
    const totalSize = Array.from(this.components.values())
      .reduce((sum, c) => sum + c.size, 0);

    // Components by category
    const byCategory = {};
    for (const comp of this.components.values()) {
      byCategory[comp.category] = (byCategory[comp.category] || 0) + 1;
    }

    // Top components by usage
    const topByUsage = Array.from(this.components.values())
      .sort((a, b) => b.routes.size - a.routes.size)
      .slice(0, 10)
      .map(c => ({
        name: c.name,
        routes: c.routes.size,
        size: c.size
      }));

    return {
      totalComponents,
      totalRoutes,
      sharedComponentsCount: sharedComponents.length,
      sharedPercentage: (sharedComponents.length / totalComponents * 100).toFixed(1),
      totalSize,
      averageSize: Math.round(totalSize / totalComponents),
      byCategory,
      topByUsage
    };
  }

  /**
   * Generates a visual report of the analysis
   */
  generateReport(metrics) {
    console.log('\n📊 PROJECT ANALYSIS\n');
    console.log(`Total components: ${metrics.totalComponents}`);
    console.log(`Total routes: ${metrics.totalRoutes}`);
    console.log(`Shared components: ${metrics.sharedComponentsCount} (${metrics.sharedPercentage}%)`);
    console.log(`Total size: ${(metrics.totalSize / 1024).toFixed(1)} KB`);
    console.log(`Average size: ${(metrics.averageSize / 1024).toFixed(1)} KB per component`);

    console.log('\n📦 By category:');
    for (const [category, count] of Object.entries(metrics.byCategory)) {
      console.log(`  ${category}: ${count} components`);
    }

    console.log('\n🔥 Top 10 most used components:');
    metrics.topByUsage.forEach((comp, i) => {
      console.log(`  ${i + 1}. ${comp.name} - ${comp.routes} routes - ${(comp.size / 1024).toFixed(1)} KB`);
    });
  }
}
