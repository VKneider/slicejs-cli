import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import Print from '../Print.js';
import { generateTypesFile, runGenerateTypes } from '../types/types.js';
import { scanComponentCatalog, loadProjectConfig } from '../utils/componentCatalog.js';
import { checkAgents, generateAgents } from './agents.js';
import { checkEventDocs, generateEventDocs } from './events.js';

const TARGETS = new Set(['all', 'agents', 'types', 'events']);

function normalizeTarget(target) {
   const value = String(target || 'all').toLowerCase();
   if (!TARGETS.has(value)) {
      throw new Error(`Unknown docs target "${target}". Use all, agents, types, or events.`);
   }
   return value;
}

async function loadCatalog(projectRoot) {
   const config = await loadProjectConfig(projectRoot);
   return scanComponentCatalog({ projectRoot, config });
}

// Automatic generation (dev/component commands) must not take over a project
// that keeps a hand-written AGENTS.md and has not opted into the scaffold.
export async function hasDocumentationScaffold(projectRoot) {
   const rootAgents = path.join(projectRoot, 'AGENTS.md');
   if (await fs.pathExists(rootAgents)) {
      const content = await fs.readFile(rootAgents, 'utf8');
      if (content.includes('<!-- slice:generated:categories:start -->')) return true;
   }
   return fs.pathExists(path.join(projectRoot, 'docs', 'events', 'index.md'));
}

export async function generateDocs({ projectRoot, target = 'all', outputPath }) {
   const only = normalizeTarget(target);
   const catalog = await loadCatalog(projectRoot);
   const written = [];

   if (only === 'all' || only === 'agents') {
      const result = await generateAgents({ projectRoot, catalog });
      written.push(...result.files);
   }

   if (only === 'all' || only === 'types') {
      const resolvedOutput = outputPath
         ? (path.isAbsolute(outputPath) ? outputPath : path.join(projectRoot, outputPath))
         : path.join(projectRoot, 'src', 'slice-build.generated.d.ts');
      await runGenerateTypes({ projectRoot, outputPath: resolvedOutput });
      written.push(resolvedOutput);
   }

   if (only === 'all' || only === 'events') {
      const result = await generateEventDocs({ projectRoot });
      written.push(...result.files);
   }

   Print.success(`Documentation generated (${only}).`);
   for (const file of [...new Set(written)].sort()) {
      Print.info(path.relative(projectRoot, file).replace(/\\/g, '/'));
   }
   return { written };
}

async function checkTypes({ projectRoot }) {
   const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-docs-check-'));
   const issues = [];
   try {
      const outputPath = path.join(tempRoot, 'slice-build.generated.d.ts');
      const result = await generateTypesFile({ projectRoot, outputPath });
      const pairs = [
         [outputPath, path.join(projectRoot, 'src', 'slice-build.generated.d.ts')],
         [path.join(tempRoot, 'slice-runtime.generated.d.ts'), path.join(projectRoot, 'src', 'slice-runtime.generated.d.ts')],
         [result.manifestPath, path.join(projectRoot, 'src', 'slice-events.generated.js')],
      ];
      for (const [expectedPath, actualPath] of pairs) {
         if (!(await fs.pathExists(actualPath))) {
            issues.push(`missing ${path.relative(projectRoot, actualPath).replace(/\\/g, '/')}`);
            continue;
         }
         const expected = await fs.readFile(expectedPath, 'utf8');
         const actual = await fs.readFile(actualPath, 'utf8');
         if (expected !== actual) {
            issues.push(`outdated ${path.relative(projectRoot, actualPath).replace(/\\/g, '/')}`);
         }
      }
   } finally {
      await fs.remove(tempRoot);
   }
   return issues;
}

export async function checkDocs({ projectRoot, target = 'all' }) {
   const only = normalizeTarget(target);
   const catalog = await loadCatalog(projectRoot);
   const issues = [];

   if (only === 'all' || only === 'agents') {
      const result = await checkAgents({ projectRoot, catalog });
      issues.push(...result.issues);
   }

   if (only === 'all' || only === 'types') {
      issues.push(...await checkTypes({ projectRoot }));
   }

   if (only === 'all' || only === 'events') {
      const result = await checkEventDocs({ projectRoot });
      issues.push(...result.issues);
   }

   if (issues.length) {
      Print.warning(`Documentation drift detected (${only}).`);
      for (const issue of issues) Print.info(issue);
      Print.info('Run "slice docs generate" to update the generated files.');
      return { ok: false, issues };
   }

   Print.success(`Documentation is current (${only}).`);
   return { ok: true, issues: [] };
}
