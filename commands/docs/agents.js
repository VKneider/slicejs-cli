import fs from 'fs-extra';
import path from 'path';

import {
   componentDocCell,
   serializeComponentsRegistry,
   writeComponentsRegistry,
} from '../utils/componentCatalog.js';

const MARKER_START = (name) => `<!-- slice:generated:${name}:start -->`;
const MARKER_END = (name) => `<!-- slice:generated:${name}:end -->`;

const DEFAULT_PURPOSES = {
   AppComponents: 'Application-specific UI: the shell and the screens that compose Visual components for this product.',
   DocumentationPages: 'Generated documentation pages and their supporting views.',
   DemoComponents: 'Interactive demos and fixtures used by documentation or examples.',
};

export function readGeneratedBlock(content, name) {
   const start = content.indexOf(MARKER_START(name));
   const end = content.indexOf(MARKER_END(name));
   if (start === -1 || end === -1 || end < start) return null;
   return content.slice(start, end + MARKER_END(name).length);
}

function replaceGeneratedBlock(content, name, block) {
   const start = content.indexOf(MARKER_START(name));
   const end = content.indexOf(MARKER_END(name));
   const wrapped = `${MARKER_START(name)}\n${block.trim()}\n${MARKER_END(name)}`;
   if (start !== -1 && end !== -1 && end > start) {
      return `${content.slice(0, start)}${wrapped}${content.slice(end + MARKER_END(name).length)}`;
   }
   const separator = content.endsWith('\n') ? '\n' : '\n\n';
   return `${content}${separator}## Components (generated)\n\n${wrapped}\n`;
}

function categoryRows(catalog) {
   const rows = catalog.categories.map((category) => {
      const count = category.components.length;
      return `| ${category.name} | ${category.type} | \`${category.relativePath}\` | ${count} | [AGENTS.md](${category.relativePath}/AGENTS.md) |`;
   });
   return [
      '| Category | Type | Path | Components | Guide |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
   ].join('\n');
}

function componentRows(category) {
   const rows = category.components.map((component) =>
      `| ${component.name} | ${component.type} | ${component.fileCount} | ${componentDocCell(component)} |`,
   );
   return [
      '| Component | Type | Files | Docs |',
      '| --- | --- | --- | --- |',
      ...(rows.length ? rows : ['| — | — | — | — |']),
   ].join('\n');
}

function packageName(projectRoot, packageJson) {
   return packageJson?.name || path.basename(projectRoot);
}

function packageManager(projectRoot, packageJson) {
   if (packageJson?.packageManager) return String(packageJson.packageManager).split('@')[0];
   if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
   if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
   return 'npm';
}

function rootAgentsTemplate({ projectRoot, packageJson, catalog }) {
   const name = packageName(projectRoot, packageJson);
   const pm = packageManager(projectRoot, packageJson);
   return `# ${name} — agent guide

## Read first

1. This file.
2. The nearest \`src/Components/<Category>/AGENTS.md\` before editing a component.
3. The component \`README.md\` before changing its API or behavior.
4. \`docs/events/\` before changing an event contract.

## Commands

- Dev: \`${pm} dev\`
- Build: \`${pm} build\`
- Regenerate docs: \`${pm} exec slice docs generate\`
- Check generated docs: \`${pm} exec slice docs check\`

## Component categories

${MARKER_START('categories')}
${categoryRows(catalog)}
${MARKER_END('categories')}

## Documentation map

- Category guides: \`src/Components/<Category>/AGENTS.md\`
- Component docs: \`<Component>/README.md\`
- Event catalog: \`docs/events/index.md\`, \`diagram.mmd\`, \`diagram.html\`
- Changelog (optional): \`CHANGELOG.md\` or \`src/Components/<Category>/CHANGELOG.md\`

## Rules

- Visual and Service are registry categories. Do not hand-edit components installed by \`slice get\`;
  their authoritative docs are \`slice docs\` / MCP.
- App-owned components document themselves in \`README.md\` next to the code.
- Generated files are never edited by hand: \`components.js\`, \`docs/events/*\`,
  \`src/slice-events.generated.js\`, \`src/*.generated.d.ts\`.
- A behavior change updates the component README and the category guide in the same change.
- Event names use \`namespace:action\`.

## Done

- [ ] Component README updated (or \`No docs impact\` explained)
- [ ] Nearest category \`AGENTS.md\` updated
- [ ] \`slice docs generate\` run when events/components changed
- [ ] Changelog updated if the project uses one
`;
}

function registryRules(category) {
   if (category.name === 'Visual') {
      return `## Registry rule

\`Visual\` is where \`slice get\` installs registry Visual components. A downloaded component is not
edited by hand: its authoritative docs are \`slice docs\` / MCP. A local component added to this
category is app-owned and documents itself in its own \`README.md\`.
`;
   }
   if (category.name === 'Service') {
      return `## Registry rule

\`Service\` is where \`slice get\` installs registry Service components. A downloaded component is not
edited by hand: its authoritative docs are \`slice docs\` / MCP. A local service added to this
category is app-owned and documents itself in its own \`README.md\`.
`;
   }
   return `## What this category is

${category.description || DEFAULT_PURPOSES[category.name] || 'TODO: describe this category. What belongs here, what does not, and how it relates to the other categories.'}
`;
}

function categoryAgentsTemplate(category) {
   return `# ${category.name}

${registryRules(category)}

## Components

${MARKER_START('components')}
${componentRows(category)}
${MARKER_END('components')}

## Local rules

- Keep this guide current when adding, removing or changing a component in this category.
- Prefer the component \`README.md\` for API details; link it from the table above.
- Document non-obvious decisions and gotchas here.

## Events

- Emitted and listened events are documented in \`docs/events/\`.
- Event names use \`namespace:action\`.

## Changelog

- Optional: \`CHANGELOG.md\` next to this file.
`;
}

function updateRootAgents(content, catalog) {
   const block = categoryRows(catalog);
   if (readGeneratedBlock(content, 'categories')) {
      return replaceGeneratedBlock(content, 'categories', block);
   }
   const separator = content.endsWith('\n') ? '\n' : '\n\n';
   return `${content}${separator}## Component categories\n\n${MARKER_START('categories')}\n${block}\n${MARKER_END('categories')}\n`;
}

function updateCategoryAgents(content, category) {
   const block = componentRows(category);
   if (readGeneratedBlock(content, 'components')) {
      return replaceGeneratedBlock(content, 'components', block);
   }
   const separator = content.endsWith('\n') ? '\n' : '\n\n';
   return `${content}${separator}## Components (generated)\n\n${MARKER_START('components')}\n${block}\n${MARKER_END('components')}\n`;
}

export async function expectedAgentsFiles({ projectRoot, catalog }) {
   const packageJsonPath = path.join(projectRoot, 'package.json');
   const packageJson = (await fs.pathExists(packageJsonPath)) ? await fs.readJson(packageJsonPath) : null;
   const files = new Map();

   const rootPath = path.join(projectRoot, 'AGENTS.md');
   if (await fs.pathExists(rootPath)) {
      const current = await fs.readFile(rootPath, 'utf8');
      files.set(rootPath, updateRootAgents(current, catalog));
   } else {
      files.set(rootPath, rootAgentsTemplate({ projectRoot, packageJson, catalog }));
   }

   for (const category of catalog.categories) {
      const categoryPath = path.join(category.directory, 'AGENTS.md');
      if (await fs.pathExists(categoryPath)) {
         const current = await fs.readFile(categoryPath, 'utf8');
         files.set(categoryPath, updateCategoryAgents(current, category));
      } else {
         files.set(categoryPath, categoryAgentsTemplate(category));
      }
   }

   const claudePath = path.join(projectRoot, 'CLAUDE.md');
   if (!(await fs.pathExists(claudePath))) files.set(claudePath, '@AGENTS.md\n');

   files.set(
      path.join(projectRoot, 'src', 'Components', 'components.js'),
      serializeComponentsRegistry(catalog),
   );

   return files;
}

export async function generateAgents({ projectRoot, catalog }) {
   const files = await expectedAgentsFiles({ projectRoot, catalog });
   for (const [filePath, content] of files) {
      await fs.ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, content, 'utf8');
   }
   await writeComponentsRegistry(projectRoot, catalog);
   return { files: [...files.keys()] };
}

export async function checkAgents({ projectRoot, catalog }) {
   const issues = [];
   const expected = await expectedAgentsFiles({ projectRoot, catalog });

   for (const [filePath, content] of expected) {
      if (!(await fs.pathExists(filePath))) {
         issues.push(`missing ${path.relative(projectRoot, filePath).replace(/\\/g, '/')}`);
         continue;
      }
      const actual = await fs.readFile(filePath, 'utf8');
      if (actual !== content) {
         issues.push(`outdated ${path.relative(projectRoot, filePath).replace(/\\/g, '/')}`);
      }
   }

   for (const category of catalog.categories) {
      const categoryPath = path.join(category.directory, 'AGENTS.md');
      if (!(await fs.pathExists(categoryPath))) continue;
      const content = await fs.readFile(categoryPath, 'utf8');
      if (content.includes('TODO: describe this category')) {
         issues.push(`placeholder purpose in ${path.relative(projectRoot, categoryPath).replace(/\\/g, '/')}`);
      }
   }

   return { ok: issues.length === 0, issues };
}
