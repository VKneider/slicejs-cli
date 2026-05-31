import fs from 'fs-extra';
import path from 'path';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';

import Print from '../Print.js';
import { getConfigPath, getComponentsJsPath, joinRoot } from '../utils/PathHelper.js';

const TYPE_MAP = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  object: 'Record<string, unknown>',
  array: 'unknown[]',
  function: '(...args: unknown[]) => unknown',
  any: 'unknown'
};

const literalValueFromAst = (node) => {
  if (!node) return undefined;
  if (node.type === 'StringLiteral' || node.type === 'NumericLiteral' || node.type === 'BooleanLiteral') {
    return node.value;
  }
  if (node.type === 'NullLiteral') {
    return null;
  }
  return undefined;
};

const keyNameFromAst = (keyNode) => {
  if (!keyNode) return null;
  if (keyNode.type === 'Identifier') return keyNode.name;
  if (keyNode.type === 'StringLiteral') return keyNode.value;
  return null;
};

const astNodeToValue = (node) => {
  if (!node) return undefined;

  const literal = literalValueFromAst(node);
  if (literal !== undefined || (node && node.type === 'NullLiteral')) {
    return literal;
  }

  if (node.type === 'ArrayExpression') {
    return (node.elements || [])
      .map((element) => astNodeToValue(element))
      .filter((value) => value !== undefined);
  }

  if (node.type === 'ObjectExpression') {
    const out = {};
    for (const property of node.properties || []) {
      if (property.type !== 'ObjectProperty') continue;
      const key = keyNameFromAst(property.key);
      if (!key) continue;
      const value = astNodeToValue(property.value);
      if (value !== undefined) {
        out[key] = value;
      }
    }
    return out;
  }

  return undefined;
};

const normalizePropConfig = (rawConfig) => {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return { type: 'any', required: false };
  }

  const config = {
    type: typeof rawConfig.type === 'string' ? rawConfig.type.toLowerCase() : 'any',
    required: rawConfig.required === true
  };

  if (Array.isArray(rawConfig.allowedValues) && rawConfig.allowedValues.length > 0) {
    config.allowedValues = rawConfig.allowedValues;
  }

  if (rawConfig.schema && typeof rawConfig.schema === 'object' && !Array.isArray(rawConfig.schema)) {
    const schema = {};
    for (const [name, nestedRaw] of Object.entries(rawConfig.schema)) {
      schema[name] = normalizePropConfig(nestedRaw);
    }
    config.schema = schema;
  }

  if (rawConfig.items && typeof rawConfig.items === 'object' && !Array.isArray(rawConfig.items)) {
    config.items = normalizePropConfig(rawConfig.items);
  }

  return config;
};

const extractStaticPropsFromObjectExpression = (objectExpressionNode) => {
  const raw = astNodeToValue(objectExpressionNode);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const props = {};
  for (const [propName, rawConfig] of Object.entries(raw)) {
    props[propName] = normalizePropConfig(rawConfig);
  }

  return Object.keys(props).length > 0 ? props : null;
};

const sortKeys = (obj) => {
  return Object.keys(obj)
    .sort((a, b) => a.localeCompare(b))
    .reduce((acc, key) => {
      acc[key] = obj[key];
      return acc;
    }, {});
};

const parseComponentsRegistry = (content, filePath) => {
  const match = content.match(/const components = ({[\s\S]*?});/);
  if (!match) {
    throw new Error(`Invalid format in ${filePath}. Expected: const components = { ... };`);
  }
  try {
    return JSON.parse(match[1]);
  } catch (parseError) {
    throw new Error(`Failed to parse components registry in ${filePath}: ${parseError.message}`);
  }
};

const extractStaticPropsFromSource = (source, filePath) => {
  let ast;
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['classProperties']
    });
  } catch (parseError) {
    const sourceDesc = filePath || 'unknown file';
    const loc = parseError.loc ? ` at line ${parseError.loc.line}, column ${parseError.loc.column}` : '';
    Print.warning(`Parse error in ${sourceDesc}${loc}: ${parseError.message}`);
    return null;
  }

  let staticPropsObject = null;
  traverse.default(ast, {
    ClassProperty(pathRef) {
      const node = pathRef.node;
      if (!node.static || !node.key || keyNameFromAst(node.key) !== 'props') return;
      if (node.value && node.value.type === 'ObjectExpression') {
        staticPropsObject = node.value;
      }
    }
  });

  if (!staticPropsObject) return null;
  return extractStaticPropsFromObjectExpression(staticPropsObject);
};

const typeFromProp = (propMeta) => {
  if (propMeta.type === 'object' && propMeta.schema && typeof propMeta.schema === 'object') {
    const schemaEntries = Object.entries(sortKeys(propMeta.schema));
    const inner = schemaEntries
      .map(([name, meta]) => {
        const optionalMark = meta.required ? '' : '?';
        return `${name}${optionalMark}: ${typeFromProp(meta)};`;
      })
      .join(' ');
    return `{ ${inner} }`;
  }

  if (propMeta.type === 'array' && propMeta.items && typeof propMeta.items === 'object') {
    return `${typeFromProp(propMeta.items)}[]`;
  }

  const allowedValues = Array.isArray(propMeta.allowedValues) ? propMeta.allowedValues : [];

  if (allowedValues.length > 0 && propMeta.type === 'string' && allowedValues.every((value) => typeof value === 'string')) {
    return allowedValues.map((value) => `'${String(value).replace(/'/g, "\\'")}'`).join(' | ');
  }

  if (allowedValues.length > 0 && propMeta.type === 'number' && allowedValues.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return allowedValues.join(' | ');
  }

  return TYPE_MAP[propMeta.type] || 'unknown';
};

const interfaceNameFor = (componentName) => `${componentName}Props`;
const DYNAMIC_FALLBACK_PROP = '__dynamicPropsFallback';

const DEFAULT_EDITOR_COMPILER_OPTIONS = {
  allowJs: true,
  checkJs: true,
  strict: false,
  noImplicitAny: false,
  strictNullChecks: false,
  maxNodeModuleJsDepth: 2
};

const DEFAULT_EDITOR_INCLUDE = ['src/Components/**/*.js', 'src/**/*.d.ts'];
const DEFAULT_EDITOR_EXCLUDE = ['node_modules', 'dist', 'src/libs/**', 'tests/**'];
const NOISY_INCLUDE_PATTERNS = new Set(['src/**/*.js', 'api/**/*.js', 'tests/**/*.js']);

const readPublicFolderExcludes = async (projectRoot) => {
  const configPath = getConfigPath(import.meta.url, projectRoot);
  if (!(await fs.pathExists(configPath))) return [];

  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const folders = Array.isArray(parsed?.publicFolders) ? parsed.publicFolders : [];
    return folders
      .map((folder) => String(folder || '').trim())
      .filter(Boolean)
      .map((folder) => folder.replace(/^[/\\]+/, ''))
      .map((folder) => `src/${folder}/**`);
  } catch {
    return [];
  }
};

const collectJavaScriptFiles = async (dirPath) => {
  if (!(await fs.pathExists(dirPath))) return [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectJavaScriptFiles(fullPath);
      files.push(...nested);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
};

const ensureNoCheckInPublicVendorFiles = async (projectRoot) => {
  const configPath = getConfigPath(import.meta.url, projectRoot);
  if (!(await fs.pathExists(configPath))) return { updatedFiles: 0, scannedFiles: 0 };

  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch {
    return { updatedFiles: 0, scannedFiles: 0 };
  }

  const publicFolders = Array.isArray(parsed?.publicFolders) ? parsed.publicFolders : [];
  const candidateDirs = publicFolders
    .map((folder) => String(folder || '').trim())
    .filter(Boolean)
    .map((folder) => folder.replace(/^[/\\]+/, ''))
    .map((folder) => joinRoot(projectRoot, 'src', folder));

  const uniqueDirs = Array.from(new Set(candidateDirs));
  let scannedFiles = 0;
  let updatedFiles = 0;

  for (const dirPath of uniqueDirs) {
    const jsFiles = await collectJavaScriptFiles(dirPath);
    for (const filePath of jsFiles) {
      scannedFiles += 1;
      const raw = await fs.readFile(filePath, 'utf8');
      if (raw.startsWith('// @ts-nocheck')) {
        continue;
      }

      await fs.writeFile(filePath, `// @ts-nocheck\n${raw}`, 'utf8');
      updatedFiles += 1;
    }
  }

  return { updatedFiles, scannedFiles };
};

const generateDeclarationContent = (componentPropsMap) => {
  const componentsSorted = sortKeys(componentPropsMap);
  const lines = [];

  lines.push('/* Auto-generated by slice types generate. Do not edit manually. */');
  lines.push('');

  for (const [componentName, props] of Object.entries(componentsSorted)) {
    lines.push(`export interface ${interfaceNameFor(componentName)} {`);
    lines.push('  [key: string]: unknown;');
    const sortedProps = sortKeys(props);
    const isDynamicFallback = Object.keys(sortedProps).length === 1 && sortedProps[DYNAMIC_FALLBACK_PROP];
    if (!isDynamicFallback) {
      for (const [propName, propMeta] of Object.entries(sortedProps)) {
        const optionalMark = propMeta.required ? '' : '?';
        lines.push(`  ${propName}${optionalMark}: ${typeFromProp(propMeta)};`);
      }
    }
    lines.push('}');
    lines.push('');
  }

  lines.push('export interface SliceComponentPropsMap {');
  for (const componentName of Object.keys(componentsSorted)) {
    lines.push(`  ${componentName}: ${interfaceNameFor(componentName)};`);
  }
  lines.push('}');
  lines.push('');
  lines.push('export type SliceComponentName = keyof SliceComponentPropsMap;');
  lines.push('export type SliceDynamicElement = HTMLElement & Record<string, any>;');
  lines.push('');
  lines.push('declare global {');
  lines.push('  const slice: SliceBuildApi & Record<string, any>;');
  lines.push('');
  lines.push('  interface Event {');
  lines.push('    detail: any;');
  lines.push('    key: any;');
  lines.push('    request: any;');
  lines.push('    waitUntil: any;');
  lines.push('    respondWith: any;');
  lines.push('    target: any;');
  lines.push('    currentTarget: any;');
  lines.push('  }');
  lines.push('');
  lines.push('  interface Element {');
    lines.push('    querySelector<E extends Element = HTMLElement>(selectors: string): E | null;');
  lines.push('    querySelectorAll<E extends Element = HTMLElement>(selectors: string): NodeListOf<E>;');
  lines.push('  }');
  lines.push('  interface HTMLElement {');
  lines.push('    [key: string]: any;');
  lines.push('  }');
  lines.push('  interface EventTarget {');
  lines.push('    [key: string]: any;');
  lines.push('  }');
  lines.push('');
  lines.push('  interface SliceBuildApi {');
  lines.push('    build<K extends SliceComponentName>(');
  lines.push('      name: K,');
  lines.push('      props?: SliceComponentPropsMap[K]');
  lines.push('    ): Promise<SliceDynamicElement | null>;');
  lines.push('  }');
  lines.push('}');
  lines.push('');
  lines.push("declare module 'slicejs-web-framework' {");
  lines.push('  interface SliceApi {');
  lines.push('    build<K extends SliceComponentName>(');
  lines.push('      name: K,');
  lines.push('      props?: SliceComponentPropsMap[K]');
  lines.push('    ): Promise<SliceDynamicElement | null>;');
  lines.push('    getComponent<T extends SliceDynamicElement = SliceDynamicElement>(');
  lines.push('      componentSliceId: string');
  lines.push('    ): T | undefined;');
  lines.push('  }');
  lines.push('}');
  lines.push('');
  lines.push('export {};');
  lines.push('');

  return lines.join('\n');
};

const readCategoryPathFromConfig = async (configPath, category) => {
  const raw = await fs.readFile(configPath, 'utf8');
  const config = JSON.parse(raw);
  const categoryEntry = config?.paths?.components?.[category];
  if (!categoryEntry || !categoryEntry.path) {
    return null;
  }
  return categoryEntry.path.replace(/^[/\\]+/, '');
};

const loadComponentStaticProps = async ({ projectRoot, registryMap }) => {
  const configPath = getConfigPath(import.meta.url, projectRoot);
  const categoryPathCache = new Map();
  const componentPropsMap = {};
  let skippedCount = 0;
  let processedCount = 0;

  for (const [componentName, category] of Object.entries(sortKeys(registryMap))) {
    if (!categoryPathCache.has(category)) {
      const categoryPath = await readCategoryPathFromConfig(configPath, category);
      categoryPathCache.set(category, categoryPath);
    }

    const categoryPath = categoryPathCache.get(category);
    if (!categoryPath) {
      skippedCount++;
      continue;
    }

    const componentFile = joinRoot(projectRoot, 'src', categoryPath, componentName, `${componentName}.js`);
    if (!(await fs.pathExists(componentFile))) {
      skippedCount++;
      continue;
    }

    let source;
    try {
      source = await fs.readFile(componentFile, 'utf8');
    } catch (readError) {
      Print.warning(`Cannot read ${componentFile}: ${readError.message}`);
      skippedCount++;
      continue;
    }

    const props = extractStaticPropsFromSource(source, componentFile);
    if (props) {
      componentPropsMap[componentName] = props;
      processedCount++;
    } else {
      componentPropsMap[componentName] = { [DYNAMIC_FALLBACK_PROP]: { type: 'any', required: false } };
    }
  }

  if (skippedCount > 0) {
    Print.info(`Skipped ${skippedCount} component(s) with missing or unreadable files`);
  }

  return componentPropsMap;
};

const generateTypesFile = async ({ projectRoot, outputPath }) => {
  const registryPath = getComponentsJsPath(import.meta.url, projectRoot);
  let registryContent;
  try {
    registryContent = await fs.readFile(registryPath, 'utf8');
  } catch (readError) {
    throw new Error(`Cannot read components registry at ${registryPath}: ${readError.message}`);
  }
  const registryMap = parseComponentsRegistry(registryContent, registryPath);

  const componentPropsMap = await loadComponentStaticProps({ projectRoot, registryMap });

  const declaration = generateDeclarationContent(componentPropsMap);
  await fs.ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, declaration, 'utf8');

  return {
    outputPath,
    componentsProcessed: Object.keys(componentPropsMap).length
  };
};

const toPosixRelative = (projectRoot, targetPath) => {
  const relative = path.relative(projectRoot, targetPath).replace(/\\/g, '/');
  return relative;
};

const ensureEditorConfigForTypes = async ({ projectRoot, outputPath }) => {
  try {
    const tsconfigPath = joinRoot(projectRoot, 'tsconfig.json');
    if (await fs.pathExists(tsconfigPath)) {
      return { mode: 'tsconfig_exists', filePath: tsconfigPath, includeAdded: false };
    }

    const jsconfigPath = joinRoot(projectRoot, 'jsconfig.json');
    const declarationGlob = (() => {
      const relative = toPosixRelative(projectRoot, outputPath);
      if (!relative) return 'src/**/*.d.ts';
      const idx = relative.lastIndexOf('/');
      if (idx === -1) return relative;
      const dir = relative.slice(0, idx);
      return `${dir}/**/*.d.ts`;
    })();

    const writeDefaultJsconfig = async () => {
      const jsconfig = {
        compilerOptions: { ...DEFAULT_EDITOR_COMPILER_OPTIONS },
        include: [...DEFAULT_EDITOR_INCLUDE, declarationGlob],
        exclude: [...DEFAULT_EDITOR_EXCLUDE]
      };
      await fs.writeFile(jsconfigPath, `${JSON.stringify(jsconfig, null, 2)}\n`, 'utf8');
    };

    if (!(await fs.pathExists(jsconfigPath))) {
      await writeDefaultJsconfig();
      return { mode: 'created_jsconfig', filePath: jsconfigPath, includeAdded: true };
    }

    let jsconfigRaw;
    try {
      jsconfigRaw = await fs.readFile(jsconfigPath, 'utf8');
    } catch {
      // Don't fail — fall back to writing the default options.
      await writeDefaultJsconfig();
      return { mode: 'reset_jsconfig', reason: 'unreadable', filePath: jsconfigPath, includeAdded: true };
    }

    let parsed;
    try {
      parsed = JSON.parse(jsconfigRaw);
    } catch {
      // The jsconfig was edited into invalid JSON (a typo, comments, trailing commas...).
      // Don't fail — just write the default options so editor IntelliSense keeps working.
      await writeDefaultJsconfig();
      return { mode: 'reset_jsconfig', reason: 'invalid_json', filePath: jsconfigPath, includeAdded: true };
    }

    const include = Array.isArray(parsed.include) ? parsed.include : [];
    const needsInclude = !include.includes(declarationGlob);
    const hasAllDefaultInclude = DEFAULT_EDITOR_INCLUDE.every((entry) => include.includes(entry));
    const hasNoisyInclude = include.some((entry) => NOISY_INCLUDE_PATTERNS.has(entry));
    const exclude = Array.isArray(parsed.exclude) ? parsed.exclude : [];
    const publicFolderExcludes = await readPublicFolderExcludes(projectRoot);
    const desiredExcludes = Array.from(new Set([...DEFAULT_EDITOR_EXCLUDE, ...publicFolderExcludes]));
    const hasAllDefaultExclude = desiredExcludes.every((entry) => exclude.includes(entry));

    const compilerOptions = parsed && typeof parsed.compilerOptions === 'object' && parsed.compilerOptions !== null
      ? { ...parsed.compilerOptions }
      : {};

    let compilerOptionsChanged = false;
    for (const [key, value] of Object.entries(DEFAULT_EDITOR_COMPILER_OPTIONS)) {
      if (compilerOptions[key] === undefined) {
        compilerOptions[key] = value;
        compilerOptionsChanged = true;
      }
    }

    if (!needsInclude && !compilerOptionsChanged && hasAllDefaultInclude && hasAllDefaultExclude && !hasNoisyInclude) {
      return { mode: 'jsconfig_already_has_include', filePath: jsconfigPath, includeAdded: false };
    }

    parsed.compilerOptions = compilerOptions;
    parsed.include = needsInclude ? [...include, declarationGlob] : include;
    const includeSet = new Set(
      (Array.isArray(parsed.include) ? parsed.include : []).filter((entry) => !NOISY_INCLUDE_PATTERNS.has(entry))
    );
    DEFAULT_EDITOR_INCLUDE.forEach((entry) => includeSet.add(entry));
    parsed.include = Array.from(includeSet);

    const excludeSet = new Set(Array.isArray(parsed.exclude) ? parsed.exclude : []);
    desiredExcludes.forEach((entry) => excludeSet.add(entry));
    parsed.exclude = Array.from(excludeSet);
    await fs.writeFile(jsconfigPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    return { mode: 'updated_jsconfig', filePath: jsconfigPath, includeAdded: needsInclude };
  } catch (error) {
    return {
      mode: 'editor_config_error',
      filePath: projectRoot,
      includeAdded: false,
      errorMessage: error?.message || 'Unknown editor config setup error'
    };
  }
};

const runGenerateTypes = async ({ projectRoot, outputPath }) => {
  const result = await generateTypesFile({ projectRoot, outputPath });
  const editorConfig = await ensureEditorConfigForTypes({ projectRoot, outputPath });
  const publicVendorSuppression = await ensureNoCheckInPublicVendorFiles(projectRoot);
  Print.success(`Generated TypeScript declarations at ${result.outputPath}`);
  Print.info(`Components with static props: ${result.componentsProcessed}`);
  if (editorConfig.mode === 'created_jsconfig') {
    Print.info(`Created jsconfig.json and included declaration glob for editor IntelliSense.`);
  } else if (editorConfig.mode === 'updated_jsconfig') {
    Print.info(`Updated jsconfig.json include list for declaration IntelliSense.`);
  } else if (editorConfig.mode === 'jsconfig_already_has_include') {
    Print.info(`jsconfig.json already includes declaration glob. Editor IntelliSense should pick generated types.`);
  } else if (editorConfig.mode === 'tsconfig_exists') {
    Print.info(`tsconfig.json detected. Types declaration is generated; ensure include covers ${toPosixRelative(projectRoot, outputPath)}.`);
  } else if (editorConfig.mode === 'reset_jsconfig') {
    const why = editorConfig.reason === 'invalid_json' ? 'contained invalid JSON' : 'could not be read';
    Print.warning(`jsconfig.json ${why}; wrote the default options so editor IntelliSense keeps working.`);
    Print.info(`Review ${editorConfig.filePath} if you had custom settings there.`);
  } else if (editorConfig.mode === 'editor_config_error') {
    Print.warning(`Unexpected editor config setup error: ${editorConfig.errorMessage}`);
  }
  if (publicVendorSuppression.updatedFiles > 0) {
    Print.info(`Added // @ts-nocheck to ${publicVendorSuppression.updatedFiles} vendor JS files from publicFolders.`);
  }
  return result;
};

export {
  ensureNoCheckInPublicVendorFiles,
  ensureEditorConfigForTypes,
  extractStaticPropsFromSource,
  generateDeclarationContent,
  generateTypesFile,
  parseComponentsRegistry,
  runGenerateTypes
};
