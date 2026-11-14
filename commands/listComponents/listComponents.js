import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import Print from '../Print.js';
import { getSrcPath, getComponentsJsPath, getConfigPath } from '../utils/PathHelper.js';

/**
 * Loads configuration from sliceConfig.json
 * @returns {object|null}
 */
const loadConfig = () => {
   try {
      const configPath = getConfigPath(import.meta.url);
      if (!fs.existsSync(configPath)) {
         Print.error('sliceConfig.json not found');
         Print.info('Run "slice init" to initialize your project');
         return null;
      }
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
   } catch (error) {
      Print.error(`Failed to load configuration: ${error.message}`);
      Print.info('Check that sliceConfig.json is valid JSON');
      return null;
   }
};

const listDirectories = (folderPath) => {
   try {
      if (!fs.existsSync(folderPath)) return [];
      return fs.readdirSync(folderPath);
   } catch (error) {
      Print.error(`Failed to read directory ${folderPath}: ${error.message}`);
      return [];
   }
};

const countFiles = (componentPath) => {
   try {
      if (!fs.existsSync(componentPath)) return 0;
      return fs.readdirSync(componentPath).filter((file) =>
         fs.statSync(path.join(componentPath, file)).isFile()
      ).length;
   } catch {
      return 0;
   }
};

/**
 * Scans sliceConfig.paths.components and returns the live component catalog.
 * @returns {Record<string, {category: string, files: number}>}
 */
const getComponents = () => {
   const config = loadConfig();
   if (!config) return {};

   const components = new Map();
   for (const [category, meta] of Object.entries(config.paths?.components || {})) {
      const cleanPath = meta?.path ? meta.path.replace(/^[/\\]+/, '') : '';
      const fullPath = getSrcPath(import.meta.url, cleanPath);
      for (const entry of listDirectories(fullPath)) {
         const componentPath = path.join(fullPath, entry);
         if (fs.existsSync(componentPath) && fs.statSync(componentPath).isDirectory()) {
            components.set(entry, { category, files: countFiles(componentPath) });
         }
      }
   }

   return Object.fromEntries(
      Object.entries(Object.fromEntries(components)).sort(([a], [b]) => a.localeCompare(b))
   );
};

function writeRegistry(components) {
   const outputPath = getComponentsJsPath(import.meta.url);
   fs.mkdirSync(path.dirname(outputPath), { recursive: true });
   const registry = Object.fromEntries(
      Object.entries(components).map(([name, data]) => [name, data.category])
   );
   fs.writeFileSync(
      outputPath,
      `const components = ${JSON.stringify(registry, null, 2)};\n\nexport default components;\n`
   );
}

function groupByCategory(components) {
   const grouped = new Map();
   for (const [name, data] of Object.entries(components)) {
      if (!grouped.has(data.category)) grouped.set(data.category, []);
      grouped.get(data.category).push(name);
   }
   return new Map(
      [...grouped.entries()]
         .map(([category, names]) => [category, names.sort((a, b) => a.localeCompare(b))])
         .sort(([a], [b]) => a.localeCompare(b))
   );
}

function wrapNames(names, indent = '    ') {
   const width = Math.max(40, (process.stdout.columns || 80) - indent.length);
   const lines = [];
   let current = '';
   for (const name of names) {
      const next = current ? `${current}, ${name}` : name;
      if (next.length > width && current) {
         lines.push(current);
         current = name;
      } else {
         current = next;
      }
   }
   if (current) lines.push(current);
   return lines.map((line) => `${indent}${line}`);
}

function printCompact(components, grouped) {
   const names = Object.keys(components);
   if (names.length === 0) {
      Print.warning('No components found in your project');
      Print.info('Create your first component with "slice component create"');
      return;
   }

   Print.newLine();
   console.log(chalk.bold('Local components'));
   Print.newLine();

   for (const [category, categoryNames] of grouped) {
      const sample = categoryNames.slice(0, 4).join(', ');
      const more = categoryNames.length > 4 ? ` +${categoryNames.length - 4} more` : '';
      console.log(
         `  ${chalk.cyan.bold(category.padEnd(16))} ${chalk.gray(String(categoryNames.length).padStart(3))}  ${chalk.white(sample)}${chalk.gray(more)}`
      );
   }

   Print.newLine();
   Print.info(`Total: ${names.length} component${names.length === 1 ? '' : 's'} in ${grouped.size} categor${grouped.size === 1 ? 'y' : 'ies'}`);
   Print.info('Use "slice component list --all" for every component, or --category <name> to narrow it.');
}

function printAll(components, grouped) {
   const names = Object.keys(components);
   if (names.length === 0) {
      Print.warning('No components found in your project');
      Print.info('Create your first component with "slice component create"');
      return;
   }

   Print.newLine();
   console.log(chalk.bold('Local components'));
   for (const [category, categoryNames] of grouped) {
      Print.newLine();
      console.log(`  ${chalk.cyan.bold(category)} ${chalk.gray(`(${categoryNames.length})`)}`);
      for (const line of wrapNames(categoryNames)) console.log(chalk.white(line));
   }
   Print.newLine();
   Print.info(`Total: ${names.length} component${names.length === 1 ? '' : 's'} in ${grouped.size} categor${grouped.size === 1 ? 'y' : 'ies'}`);
}

function printJson(components, grouped) {
   const payload = {
      total: Object.keys(components).length,
      categories: [...grouped.entries()].map(([name, componentsInCategory]) => ({
         name,
         count: componentsInCategory.length,
         components: componentsInCategory,
      })),
   };
   console.log(JSON.stringify(payload, null, 2));
}

/**
 * Lists local components and rewrites components.js.
 *
 * Default output is a compact category summary; `--all` lists every component.
 * The long cli-table is gone on purpose: real apps have dozens/hundreds of
 * components and a table becomes noise.
 *
 * @param {{ all?: boolean, category?: string, json?: boolean }} [options]
 */
function listComponentsReal(options = {}) {
   try {
      const components = getComponents();
      writeRegistry(components);

      const filter = options.category
         ? Object.entries(components).filter(([, data]) => data.category.toLowerCase() === String(options.category).toLowerCase())
         : Object.entries(components);
      const filtered = Object.fromEntries(filter);
      const grouped = groupByCategory(filtered);

      if (options.json) {
         printJson(filtered, grouped);
         return;
      }

      if (options.all) printAll(filtered, grouped);
      else printCompact(filtered, grouped);
   } catch (error) {
      Print.error(`Failed to list components: ${error.message}`);
      Print.info('Make sure your project structure is correct');
   }
}

export { getComponents };
export default listComponentsReal;
