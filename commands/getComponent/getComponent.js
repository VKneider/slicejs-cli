// commands/getComponent/getComponent.js

import fs from "fs-extra";
import path from "path";
import inquirer from "inquirer";
import validations from "../Validations.js";
import Print from "../Print.js";
import { getComponentsJsPath, getPath } from "../utils/PathHelper.js";
import { loadConfig as sharedLoadConfig } from "../utils/loadConfig.js";
import ora from "ora";

// Base URL of the Slice.js documentation repository
const DOCS_REPO_BASE_URL = 'https://raw.githubusercontent.com/VKneider/slice.js_visual_library/master/src/Components';
const COMPONENTS_REGISTRY_URL = 'https://raw.githubusercontent.com/VKneider/slice.js_visual_library/master/src/Components/components.js';

/**
 * Loads configuration from sliceConfig.json
 * @returns {object} - Configuration object
 */
const loadConfig = () => sharedLoadConfig(import.meta.url);

const fetchWithRetry = async (url, retries = 3, baseDelay = 500, binary = false) => {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      return binary ? await response.arrayBuffer() : await response.text();
    } catch (e) {
      if (attempt === retries) throw e;
      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, delay));
    }
  }
};

const runConcurrent = async (items, worker, concurrency = 3) => {
  let index = 0;
  const runners = Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) break;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
};

class ComponentRegistry {
  constructor() {
    this.componentsRegistry = null;
    this.config = null;
    this._configPromise = null;
    // Serializes read-modify-write cycles on components.js: installs run
    // concurrently (runConcurrent), and parallel writers corrupt the file
    // (partial reads) or silently drop registrations (lost updates).
    this._registryLock = Promise.resolve();
  }

  async _ensureConfig() {
    if (!this.config && !this._configPromise) {
      this._configPromise = loadConfig();
    }
    if (this._configPromise) {
      this.config = await this._configPromise;
    }
  }

  async loadRegistry() {
    await this._ensureConfig();
    Print.info('Loading component registry from official repository...');

    try {
      const response = await fetch(COMPONENTS_REGISTRY_URL);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const content = await response.text();

      // Parse the components.js file content
      const match = content.match(/const components = ({[\s\S]*?});/);
      if (!match) {
        throw new Error('Invalid components.js format from repository');
      }

      const allComponents = JSON.parse(match[1]);

      // Filter only Visual and Service components
      this.componentsRegistry = this.filterOfficialComponents(allComponents);

      Print.success('Component registry loaded successfully');

    } catch (error) {
      throw error;
    }
  }

/**
 * Filters the registry to include ONLY Visual and Service category components
 * Excludes AppComponents and any other category
 * @param {object} allComponents - Object with all registry components
 * @returns {object} - Filtered object with only Visual and Service
 */
filterOfficialComponents(allComponents) {
  const filtered = {};
  let excludedCount = 0;
  
  Object.entries(allComponents).forEach(([name, category]) => {
    // Only include Visual or Service category components
    if (category === 'Visual' || category === 'Service') {
      filtered[name] = category;
    } else {
      excludedCount++;
    }
  });
  
  if (excludedCount > 0) {
    Print.info(`Filtered out ${excludedCount} non-Visual/Service components from registry`);
  }
  
  return filtered;
}

  async getLocalComponents() {
    try {
      const componentsPath = getComponentsJsPath(import.meta.url);
      
      if (!await fs.pathExists(componentsPath)) {
        return {};
      }

      const content = await fs.readFile(componentsPath, 'utf8');
      const match = content.match(/const components = ({[\s\S]*?});/);
      
      if (!match) {
        return {};
      }

      return JSON.parse(match[1]);
    } catch (error) {
      Print.warning(`⚠️  Could not read the local component registry at: ${componentsPath}`);
      return {};
    }
  }

  async findUpdatableComponents() {
    await this._ensureConfig();
    const localComponents = await this.getLocalComponents();
    const updatableComponents = [];

    Object.entries(localComponents).forEach(([name, category]) => {
      // Check if component exists in remote registry
      if (this.componentsRegistry[name] && this.componentsRegistry[name] === category) {
        // Check if local component directory exists using dynamic paths
        const categoryPath = validations.getCategoryPath(category);
        
        // Use 4 levels for node_modules compatibility
        const isProduction = this.config?.production?.enabled === true;
        const folderSuffix = isProduction ? 'dist' : 'src';
        const componentPath = getPath(import.meta.url, folderSuffix, categoryPath, name);
        
        if (fs.pathExistsSync(componentPath)) {
          updatableComponents.push({
            name,
            category,
            path: componentPath
          });
        }
      }
    });

    return updatableComponents;
  }

  getAvailableComponents(category = null) {
    if (!this.componentsRegistry) return {};
    
    const components = {};
    Object.entries(this.componentsRegistry).forEach(([name, componentCategory]) => {
      if (!category || componentCategory === category) {
        // Special components that don't need all files
        let files;
        if (componentCategory === 'Visual') {
          // Logical routing components only need JS
          if (['Route', 'MultiRoute', 'Link'].includes(name)) {
            files = [`${name}.js`];
          } else if (name === 'Icon') {
            // Icon component needs font files to render glyphs
            files = [`${name}.js`, `${name}.html`, `${name}.css`, 'slc.eot', 'slc.woff2', 'slc.woff', 'slc.ttf', 'slc.svg'];
          } else {
            // Normal visual components need JS, HTML, CSS
            files = [`${name}.js`, `${name}.html`, `${name}.css`];
          }
        } else {
          // Service components only need JS
          files = [`${name}.js`];
        }

        components[name] = {
          name,
          category: componentCategory,
          files: files
        };
      }
    });
    
    return components;
  }


  async downloadComponentFiles(componentName, category, targetPath) {
    const component = this.getAvailableComponents(category)[componentName];
    
    if (!component) {
      throw new Error(`Component ${componentName} not found in ${category} category`);
    }

    const downloadedFiles = [];
    const failedFiles = [];
    const total = component.files.length;
    let done = 0;
    const spinner = ora(`Downloading ${componentName} 0/${total}`).start();
    const BINARY_EXTENSIONS = ['.eot', '.woff2', '.woff', '.ttf'];
    const worker = async (fileName) => {
      const url = `${DOCS_REPO_BASE_URL}/${category}/${componentName}/${fileName}`;
      const localPath = path.join(targetPath, fileName);
      const isBinary = BINARY_EXTENSIONS.some(ext => fileName.endsWith(ext));
      try {
        const content = await fetchWithRetry(url, 3, 500, isBinary);
        if (isBinary) {
          await fs.writeFile(localPath, Buffer.from(content));
        } else {
          await fs.writeFile(localPath, content, 'utf8');
        }
        downloadedFiles.push(fileName);
      } catch (error) {
        Print.downloadError(fileName);
        failedFiles.push(fileName);
      } finally {
        done += 1;
        spinner.text = `Downloading ${componentName} ${done}/${total}`;
      }
    };
    await runConcurrent(component.files, worker, 3);
    spinner.stop();

    // Only throw error if main file (.js) was not downloaded
    const mainFileDownloaded = downloadedFiles.some(file => file.endsWith('.js'));
    
    if (!mainFileDownloaded) {
      throw new Error(`Failed to download main component file (${componentName}.js)`);
    }

    // Report files that failed (but don't stop the process)
    if (failedFiles.length > 0) {
      Print.warning(`Some files couldn't be downloaded: ${failedFiles.join(', ')}`);
      Print.info('Component installed with available files');
    }

    return downloadedFiles;
  }

  async updateLocalRegistrySafe(componentName, category) {
    // Queue behind any in-flight registry update; keep the chain alive even
    // when an update throws so later updates still run.
    const run = this._registryLock.then(() => this._updateLocalRegistry(componentName, category));
    this._registryLock = run.catch(() => {});
    return run;
  }

  async _updateLocalRegistry(componentName, category) {
    const componentsPath = getComponentsJsPath(import.meta.url);
    if (!await fs.pathExists(componentsPath)) {
      const dir = path.dirname(componentsPath);
      await fs.ensureDir(dir);
      const initial = `const components = {};\n\nexport default components;\n`;
      await fs.writeFile(componentsPath, initial, 'utf8');
    }
    const content = await fs.readFile(componentsPath, 'utf8');
    const match = content.match(/const components = ({[\s\S]*?});/);
    if (!match) throw new Error('Invalid components.js format in local project');
    const componentsObj = JSON.parse(match[1]);
    if (!componentsObj[componentName]) {
      componentsObj[componentName] = category;
      const sorted = Object.keys(componentsObj)
        .sort()
        .reduce((obj, key) => { obj[key] = componentsObj[key]; return obj; }, {});
      const newContent = `const components = ${JSON.stringify(sorted, null, 2)};\n\nexport default components;\n`;
      await fs.writeFile(componentsPath, newContent, 'utf8');
      Print.registryUpdate(`Registered ${componentName} in local components.js`);
    } else {
      Print.info(`${componentName} already exists in local registry`);
    }
  }

  async installComponent(componentName, category, force = false) {
    await this._ensureConfig();
     const availableComponents = this.getAvailableComponents(category);

  if (!availableComponents[componentName]) {
    throw new Error(`Component '${componentName}' not found in category '${category}' in the official repository`);
  }

    // Detect if validations has access to configuration
  let categoryPath;
  const hasValidConfig = validations.config && 
                         validations.config.paths && 
                         validations.config.paths.components &&
                         validations.config.paths.components[category];
  
  if (hasValidConfig) {
    categoryPath = validations.getCategoryPath(category);
  } else {
    if (category === 'Visual') {
      categoryPath = 'Components/Visual';
    } else if (category === 'Service') {
      categoryPath = 'Components/Service';
    } else {
      throw new Error(`Unknown category: ${category}`);
    }
  }
  
  const isProduction = this.config?.production?.enabled === true;
  const folderSuffix = isProduction ? 'dist' : 'src';
  
  const cleanCategoryPath = categoryPath ? categoryPath.replace(/^[/\\]+/, '') : '';
  const targetPath = getPath(import.meta.url, folderSuffix, cleanCategoryPath, componentName);



    // Check if component already exists
    if (await fs.pathExists(targetPath) && !force) {
      const { overwrite } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'overwrite',
          message: `The component '${componentName}' already exists locally. Overwrite with the repository version?`,
          default: false
        }
      ]);
      
      if (!overwrite) {
        Print.info('Installation cancelled by user');
        return false;
      }
    }

    try {
      // Create component directory
      await fs.ensureDir(targetPath);

      // Download component files
      const downloadedFiles = await this.downloadComponentFiles(componentName, category, targetPath);

      await this.updateLocalRegistrySafe(componentName, category);

      Print.success(`${componentName} installed successfully from official repository!`);
      console.log(`📁 Location: ${[folderSuffix, categoryPath, componentName].join('/').replace(/\/+/g, '/')}/`);
      console.log(`📄 Files: ${downloadedFiles.join(', ')}`);

      return true;

    } catch (error) {
      // Only clean up if main file (.js) does not exist
      const mainFilePath = path.join(targetPath, `${componentName}.js`);
      const mainFileExists = await fs.pathExists(mainFilePath);
      
      if (!mainFileExists && await fs.pathExists(targetPath)) {
        // Only clean up if main file was not installed
        await fs.remove(targetPath);
      } else if (mainFileExists) {
        Print.warning('Component partially installed - main file exists');
      }
      
      throw error;
    }
  }

  async installMultipleComponents(componentNames, category = 'Visual', force = false) {
    const results = [];
    Print.info(`Getting ${componentNames.length} ${category} components from official repository...`);
    const total = componentNames.length;
    let done = 0;
    const spinner = ora(`Installing 0/${total}`).start();
    const worker = async (componentName) => {
      try {
        const result = await this.installComponent(componentName, category, force);
        results.push({ name: componentName, success: result });
      } catch (error) {
        Print.componentError(componentName, 'getting', error.message);
        results.push({ name: componentName, success: false, error: error.message });
      } finally {
        done += 1;
        spinner.text = `Installing ${done}/${total}`;
      }
    };
    await runConcurrent(componentNames, worker, 3);
    spinner.stop();

    // Summary
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    Print.newLine();
    Print.summary(successful, failed, componentNames.length);

    return results;
  }

  async updateAllComponents(force = false) {
    Print.info('Looking for updatable Visual components...');
    
    const allUpdatableComponents = await this.findUpdatableComponents();
    
    // Filter only Visual components
    const updatableComponents = allUpdatableComponents.filter(comp => comp.category === 'Visual');
    
    if (updatableComponents.length === 0) {
      Print.info('No local Visual components found that match the official repository');
      Print.info('Use "slice browse" to see available components');
      return true;
    }

    // Show statistics if there are Service components that won't be synced
    const serviceComponents = allUpdatableComponents.filter(comp => comp.category === 'Service');
    if (serviceComponents.length > 0) {
      Print.info(`Found ${serviceComponents.length} Service components (skipped - sync only affects Visual components)`);
    }

    Print.newLine();
    Print.subtitle(`Found ${updatableComponents.length} updatable Visual components:`);
    Print.newLine();
    updatableComponents.forEach(comp => {
      console.log(`🎨 ${comp.name} (${comp.category})`);
    });

    if (!force) {
      const { confirmUpdate } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirmUpdate',
          message: `Do you want to update these Visual components to the repository versions?`,
          default: true
        }
      ]);

      if (!confirmUpdate) {
        Print.info('Update cancelled by user');
        return false;
      }
    }

    // Only update Visual components
    const visualComponentNames = updatableComponents.map(c => c.name);
    
    Print.info(`Updating ${visualComponentNames.length} Visual components...`);
    const results = await this.installMultipleComponents(visualComponentNames, 'Visual', true);

    // Final summary
    const totalSuccessful = results.filter(r => r.success).length;
    const totalFailed = results.filter(r => !r.success).length;

    Print.newLine();
    Print.title('Visual Components Sync Summary');
    Print.success(`Visual components updated: ${totalSuccessful}`);
    
    if (totalFailed > 0) {
      Print.error(`Visual components failed: ${totalFailed}`);
    } else {
      Print.success('All your Visual components are now updated to the latest official versions!');
    }

    // Additional information about Service components
    if (serviceComponents.length > 0) {
      Print.newLine();
      Print.info(`Note: ${serviceComponents.length} Service components were found but not updated`);
      Print.info('Service components maintain manual versioning - update them individually if needed');
      Print.commandExample('Update Service component manually', 'slice get FetchManager --service --force');
    }

    return totalFailed === 0;
  }

  displayAvailableComponents() {
    if (!this.componentsRegistry) {
      Print.error('❌ Could not load component registry');
      return;
    }

    console.log('\n📚 Available components in the official Slice.js repository:\n');

    const visualComponents = this.getAvailableComponents('Visual');
    const serviceComponents = this.getAvailableComponents('Service');

    // Only show names without descriptions
    Print.info('🎨 Visual Components (UI):');
    Object.keys(visualComponents).forEach(name => {
      const files = visualComponents[name].files;
      const fileIcons = files.map(file => {
        if (file.endsWith('.js')) return '📜';
        if (file.endsWith('.html')) return '🌐';
        if (file.endsWith('.css')) return '🎨';
        return '📄';
      }).join(' ');
      console.log(`  • ${name} ${fileIcons}`);
    });

    Print.info('\n⚙️  Service Components (Logic):');
    Object.keys(serviceComponents).forEach(name => {
      console.log(`  • ${name} 📜`);
    });

    Print.newLine();
    Print.info(`Total: ${Object.keys(visualComponents).length} Visual + ${Object.keys(serviceComponents).length} Service components`);

    console.log(`\n💡 Usage examples:`);
    console.log(`slice get Button Card Input          # Install Visual components`);
    console.log(`slice get FetchManager --service     # Install Service component`);
    console.log(`slice sync                           # Sync Visual components`);
  }

  async interactiveInstall() {
    const { componentType } = await inquirer.prompt([
      {
        type: 'list',
        name: 'componentType',
        message: 'Select the type of component to install from the repository:',
        choices: [
          { name: '🎨 Visual Components (UI)', value: 'Visual' },
          { name: '⚙️  Service Components (Logic)', value: 'Service' }
        ]
      }
    ]);

    const availableComponents = this.getAvailableComponents(componentType);
    const componentChoices = Object.keys(availableComponents).map(name => ({
      name: name,
      value: name
    }));

    if (componentType === 'Visual') {
      const { installMode } = await inquirer.prompt([
        {
          type: 'list',
          name: 'installMode',
          message: 'How do you want to install Visual components?',
          choices: [
            { name: 'Get one', value: 'single' },
            { name: 'Get multiple', value: 'multiple' }
          ]
        }
      ]);

      if (installMode === 'multiple') {
        const { selectedComponents } = await inquirer.prompt([
          {
            type: 'checkbox',
            name: 'selectedComponents',
            message: 'Select Visual components to install from the repository:',
            choices: componentChoices,
            validate: (input) => {
              if (input.length === 0) {
                return 'You must select at least one component';
              }
              return true;
            }
          }
        ]);

        await this.installMultipleComponents(selectedComponents, componentType);
      } else {
        const { selectedComponent } = await inquirer.prompt([
          {
            type: 'list',
            name: 'selectedComponent',
            message: 'Select a Visual component:',
            choices: componentChoices
          }
        ]);

        await this.installComponent(selectedComponent, componentType);
      }
    } else {
      const { selectedComponent } = await inquirer.prompt([
        {
          type: 'list',
          name: 'selectedComponent',
          message: 'Select a Service component:',
          choices: componentChoices
        }
      ]);

      await this.installComponent(selectedComponent, componentType);
    }
  }

  findComponentInRegistry(componentName) {
    if (!this.componentsRegistry) return null;
    
    const normalizedName = componentName.charAt(0).toUpperCase() + componentName.slice(1);
    
    if (this.componentsRegistry[normalizedName]) {
      return {
        name: normalizedName,
        category: this.componentsRegistry[normalizedName]
      };
    }
    
    return null;
  }
}

// Main get function
async function getComponents(componentNames = [], options = {}) {
  const registry = new ComponentRegistry();
  
  try {
    await registry.loadRegistry();
  } catch (error) {
    Print.error('Could not load component registry from official repository');
    Print.info('Check your internet connection and try again');
    return false;
  }

  // Interactive mode if no components specified
  if (!componentNames || componentNames.length === 0) {
    await registry.interactiveInstall();
    return true;
  }

  // Determine category
  const category = options.service ? 'Service' : 'Visual';

  if (componentNames.length === 1) {
    // Single component install
    const componentInfo = registry.findComponentInRegistry(componentNames[0]);
    
    if (!componentInfo) {
      Print.error(`Component '${componentNames[0]}' not found in official repository`);
      Print.commandExample('View available components', 'slice browse');
      return false;
    }

    // Use the category from registry unless Service is explicitly requested
    const actualCategory = options.service ? 'Service' : componentInfo.category;

    try {
      await registry.installComponent(componentInfo.name, actualCategory, options.force);
      return true;
    } catch (error) {
      Print.error(`Error installing component: ${error.message}`);
      return false;
    }
  } else {
    // Multiple components install
    const normalizedComponents = componentNames.map(name => 
      name.charAt(0).toUpperCase() + name.slice(1)
    );

    try {
      await registry.installMultipleComponents(normalizedComponents, category, options.force);
      return true;
    } catch (error) {
      Print.error(`Error installing components: ${error.message}`);
      return false;
    }
  }
}

// List components function
async function listComponents() {
  const registry = new ComponentRegistry();
  
  try {
    await registry.loadRegistry();
    registry.displayAvailableComponents();
    return true;
  } catch (error) {
    Print.error('Could not load component registry from official repository');
    Print.info('Check your internet connection and try again');
    return false;
  }
}

// Sync components function
async function syncComponents(options = {}) {
  const registry = new ComponentRegistry();
  
  try {
    await registry.loadRegistry();
    return await registry.updateAllComponents(options.force);
  } catch (error) {
    Print.error('Could not load component registry from official repository');
    Print.info('Check your internet connection and try again');
    return false;
  }
}

export default getComponents;
export { listComponents, syncComponents, ComponentRegistry, loadConfig, runConcurrent, fetchWithRetry };
