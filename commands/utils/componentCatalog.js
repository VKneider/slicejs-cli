import fs from 'fs-extra';
import path from 'path';

const cleanCategoryPath = (value) =>
   String(value || '').replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');

export function getComponentCategories(config) {
   const entries = Object.entries(config?.paths?.components || {});
   return entries
      .map(([name, meta]) => ({
         name,
         type: meta?.type || 'Visual',
         path: meta?.path || `/Components/${name}`,
         description: typeof meta?.description === 'string' ? meta.description : '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadProjectConfig(projectRoot) {
   const configPath = path.join(projectRoot, 'src', 'sliceConfig.json');
   if (!(await fs.pathExists(configPath))) {
      throw new Error(`sliceConfig.json not found at ${configPath}`);
   }
   return fs.readJson(configPath);
}

export async function scanComponentCatalog({ projectRoot, config }) {
   const categories = [];

   for (const category of getComponentCategories(config)) {
      const relativePath = path.posix.join('src', cleanCategoryPath(category.path));
      const directory = path.join(projectRoot, 'src', cleanCategoryPath(category.path));
      const components = [];

      if (await fs.pathExists(directory)) {
         const entries = await fs.readdir(directory, { withFileTypes: true });
         for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
            const componentDir = path.join(directory, entry.name);
            const files = await fs.readdir(componentDir, { withFileTypes: true });
            const fileNames = files
               .filter((file) => file.isFile())
               .map((file) => file.name)
               .sort((a, b) => a.localeCompare(b));
            components.push({
               name: entry.name,
               category: category.name,
               type: category.type,
               directory: componentDir,
               relativePath: path.posix.join(relativePath, entry.name),
               fileCount: fileNames.length,
               files: fileNames,
               readme: fileNames.includes('README.md'),
               spec: fileNames.some((name) => name.endsWith('.spec.js')),
            });
         }
      }

      components.sort((a, b) => a.name.localeCompare(b.name));
      categories.push({ ...category, relativePath, directory, components });
   }

   const components = categories.flatMap((category) => category.components);
   return { config, categories, components };
}

export function buildComponentsRegistry(catalog) {
   const registry = {};
   for (const component of catalog.components) registry[component.name] = component.category;
   return Object.fromEntries(Object.entries(registry).sort(([a], [b]) => a.localeCompare(b)));
}

export function serializeComponentsRegistry(catalog) {
   return `const components = ${JSON.stringify(buildComponentsRegistry(catalog), null, 2)};\n\nexport default components;\n`;
}

export async function writeComponentsRegistry(projectRoot, catalog) {
   const outputPath = path.join(projectRoot, 'src', 'Components', 'components.js');
   await fs.ensureDir(path.dirname(outputPath));
   await fs.writeFile(outputPath, serializeComponentsRegistry(catalog), 'utf8');
   return outputPath;
}

export async function syncComponentsRegistry(projectRoot) {
   const config = await loadProjectConfig(projectRoot);
   const catalog = await scanComponentCatalog({ projectRoot, config });
   await writeComponentsRegistry(projectRoot, catalog);
   return catalog;
}

export async function readComponentsRegistry(projectRoot) {
   const registryPath = path.join(projectRoot, 'src', 'Components', 'components.js');
   if (!(await fs.pathExists(registryPath))) return null;
   const source = await fs.readFile(registryPath, 'utf8');
   const match = source.match(/const components = ({[\s\S]*?});/);
   if (!match) return null;
   try {
      return JSON.parse(match[1]);
   } catch {
      return null;
   }
}

export function componentDocCommand(component) {
   // Only the registry-owned categories publish component docs remotely.
   // App categories (Domain, Core, Providers, AppComponents, DataDisplay…) are
   // local and document themselves in a README next to the component.
   if (!['Visual', 'Service'].includes(component.category)) return null;
   const id = component.name
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/[_\s]+/g, '-')
      .toLowerCase();
   return `slice docs get components:${id}`;
}

export function componentDocCell(component) {
   if (component.readme) return `[README](./${component.name}/README.md)`;
   const command = componentDocCommand(component);
   return command ? `\`${command}\`` : '—';
}
