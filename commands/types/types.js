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

// ============================================================
// Event registry scanning (slice.events.register(...) call sites)
// ============================================================

const PAYLOAD_TYPE_MAP = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  object: 'Record<string, unknown>',
  array: 'unknown[]',
  function: '(...args: unknown[]) => unknown',
  any: 'unknown'
};

// Translate a payload mini-schema into a TS type.
//  - null/undefined        => 'void'
//  - 'string' (a scalar)   => 'string'
//  - { id: 'number', ... } => '{ id: number; ... }'
//  - field value may also be { type: 'number' } (long form)
const payloadToTs = (payload) => {
  if (payload === null || payload === undefined) return 'void';
  if (typeof payload === 'string') return PAYLOAD_TYPE_MAP[payload.toLowerCase()] || 'unknown';
  if (typeof payload === 'object' && !Array.isArray(payload)) {
    const inner = Object.entries(payload)
      .map(([key, value]) => {
        let tsType = 'unknown';
        if (typeof value === 'string') {
          tsType = PAYLOAD_TYPE_MAP[value.toLowerCase()] || 'unknown';
        } else if (value && typeof value === 'object' && typeof value.type === 'string') {
          tsType = PAYLOAD_TYPE_MAP[value.type.toLowerCase()] || 'unknown';
        }
        return `${key}: ${tsType}`;
      })
      .join('; ');
    return inner.length > 0 ? `{ ${inner} }` : 'Record<string, unknown>';
  }
  return 'unknown';
};

const parseModule = (source, filePath) => {
  try {
    return parse(source, { sourceType: 'module', plugins: ['classProperties'] });
  } catch (parseError) {
    const loc = parseError.loc ? ` at line ${parseError.loc.line}, column ${parseError.loc.column}` : '';
    Print.warning(`Parse error in ${filePath || 'unknown file'}${loc}: ${parseError.message}`);
    return null;
  }
};

// Matches `<x>.events.register(...)` — covers slice.events, this.events (bind), window.slice.events.
const isEventsRegisterCallee = (callee) => {
  return (
    callee &&
    callee.type === 'MemberExpression' &&
    keyNameFromAst(callee.property) === 'register' &&
    callee.object &&
    callee.object.type === 'MemberExpression' &&
    keyNameFromAst(callee.object.property) === 'events'
  );
};

// Resolve an exported object literal from a module file (export const NAME = {...} / export default {...}).
const resolveExportedObject = async (modulePath, exportName) => {
  if (!(await fs.pathExists(modulePath))) return null;
  let source;
  try {
    source = await fs.readFile(modulePath, 'utf8');
  } catch {
    return null;
  }
  const ast = parseModule(source, modulePath);
  if (!ast) return null;

  let found = null;
  traverse.default(ast, {
    ExportDefaultDeclaration(pathRef) {
      if (exportName !== 'default') return;
      const decl = pathRef.node.declaration;
      if (decl && decl.type === 'ObjectExpression') found = decl;
    },
    ExportNamedDeclaration(pathRef) {
      const decl = pathRef.node.declaration;
      if (decl && decl.type === 'VariableDeclaration') {
        for (const d of decl.declarations) {
          if (keyNameFromAst(d.id) === exportName && d.init && d.init.type === 'ObjectExpression') {
            found = d.init;
          }
        }
      }
    }
  });

  return found ? astNodeToValue(found) : null;
};

// Resolve a relative import specifier to an absolute .js file path.
const resolveRelativeModule = async (fromFile, specifier) => {
  if (!specifier.startsWith('.')) return null; // bare imports are not followed
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.js`, path.join(base, 'index.js')];
  for (const candidate of candidates) {
    if (await fs.pathExists(candidate) && (await fs.stat(candidate)).isFile()) return candidate;
  }
  return null;
};

const mergeCatalog = (registry, catalog, prefix = '') => {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return;
  for (const [key, definition] of Object.entries(catalog)) {
    const eventName = `${prefix}${key}`;
    const payload =
      definition && typeof definition === 'object' && !Array.isArray(definition)
        ? definition.payload ?? null
        : null;
    registry[eventName] = { payload };
  }
};

// Scan src/**/*.js for slice.events.register(<catalog>) calls and build the event registry.
const collectEventRegistry = async ({ projectRoot }) => {
  const srcDir = joinRoot(projectRoot, 'src');
  const files = await collectJavaScriptFiles(srcDir);
  const registry = {};

  for (const file of files) {
    let source;
    try {
      source = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (!source.includes('.events.register(')) continue; // cheap prefilter

    const ast = parseModule(source, file);
    if (!ast) continue;

    // Collect local object-literal consts and import bindings up front.
    const localObjects = new Map(); // name -> ObjectExpression node
    const imports = new Map(); // localName -> { source, imported }
    traverse.default(ast, {
      VariableDeclarator(pathRef) {
        const node = pathRef.node;
        if (node.id?.type === 'Identifier' && node.init?.type === 'ObjectExpression') {
          localObjects.set(node.id.name, node.init);
        }
      },
      ImportDeclaration(pathRef) {
        const src = pathRef.node.source?.value;
        for (const spec of pathRef.node.specifiers || []) {
          if (spec.type === 'ImportDefaultSpecifier') {
            imports.set(spec.local.name, { source: src, imported: 'default' });
          } else if (spec.type === 'ImportSpecifier') {
            imports.set(spec.local.name, { source: src, imported: keyNameFromAst(spec.imported) });
          }
        }
      }
    });

    // Find the register() call sites and capture their arguments. Supports both
    // register(catalog) and register('namespace', catalog).
    const pendingCalls = [];
    traverse.default(ast, {
      CallExpression(pathRef) {
        if (!isEventsRegisterCallee(pathRef.node.callee)) return;
        pendingCalls.push(pathRef.node.arguments);
      }
    });

    // Resolve a catalog arg node to a plain object (inline literal, local const, or import).
    const resolveCatalogArg = async (arg) => {
      if (!arg) return null;
      if (arg.type === 'ObjectExpression') return astNodeToValue(arg);
      if (arg.type === 'Identifier') {
        if (localObjects.has(arg.name)) return astNodeToValue(localObjects.get(arg.name));
        if (imports.has(arg.name)) {
          const { source: importSource, imported } = imports.get(arg.name);
          const modulePath = await resolveRelativeModule(file, importSource);
          if (modulePath) return resolveExportedObject(modulePath, imported);
          Print.warning(`Could not resolve event catalog import "${arg.name}" from "${importSource}" in ${file}`);
          return null;
        }
        Print.warning(`slice.events.register(${arg.name}) in ${file}: argument is not a literal/imported object — skipped for typing.`);
        return null;
      }
      Print.warning(`slice.events.register(...) in ${file}: argument is not an object literal — skipped for typing.`);
      return null;
    };

    for (const args of pendingCalls) {
      let prefix = '';
      let catalogArg = args[0];
      // register('namespace', catalog) — first arg is a string literal.
      if (args[0] && args[0].type === 'StringLiteral') {
        const ns = String(args[0].value).trim();
        prefix = ns.endsWith(':') ? ns : `${ns}:`;
        catalogArg = args[1];
      }
      const catalog = await resolveCatalogArg(catalogArg);
      mergeCatalog(registry, catalog, prefix);
    }
  }

  return registry;
};

// Matches `<x>.events.<method>(...)` — covers slice.events / this.events (bind) / window.slice.events.
const isEventsMethodCallee = (callee, methods) => {
  return (
    callee &&
    callee.type === 'MemberExpression' &&
    methods.includes(keyNameFromAst(callee.property)) &&
    callee.object &&
    callee.object.type === 'MemberExpression' &&
    keyNameFromAst(callee.object.property) === 'events'
  );
};

// Nearest enclosing class name for a call site (the component/service that emits/listens).
const enclosingClassName = (pathRef) => {
  const classPath = pathRef.findParent((p) => p.isClassDeclaration() || p.isClassExpression());
  return classPath?.node?.id?.name || null;
};

// Static pub/sub graph: scan emit()/subscribe() call sites so emitters/listeners are
// documented WITHOUT executing the code (complements the observational runtime tracing).
// Returns { events: { name: { emitters:[], listeners:[] } }, dynamic: { emitters:[], listeners:[] } }.
const collectEventGraph = async ({ projectRoot }) => {
  const srcDir = joinRoot(projectRoot, 'src');
  const files = await collectJavaScriptFiles(srcDir);
  const events = {};
  const dynamic = { emitters: [], listeners: [] };

  const bucketFor = (eventName, kind) => {
    if (!events[eventName]) events[eventName] = { emitters: [], listeners: [] };
    return events[eventName][kind];
  };

  for (const file of files) {
    let source;
    try {
      source = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (!source.includes('.events.emit(') && !source.includes('.events.subscribe(') && !source.includes('.events.subscribeOnce(')) {
      continue; // cheap prefilter
    }

    const ast = parseModule(source, file);
    if (!ast) continue;

    const relFile = path.relative(projectRoot, file).replace(/\\/g, '/');

    traverse.default(ast, {
      CallExpression(pathRef) {
        const callee = pathRef.node.callee;
        let kind = null;
        if (isEventsMethodCallee(callee, ['emit'])) kind = 'emitters';
        else if (isEventsMethodCallee(callee, ['subscribe', 'subscribeOnce'])) kind = 'listeners';
        if (!kind) return;

        const site = {
          file: relFile,
          line: pathRef.node.loc?.start?.line || 0,
          component: enclosingClassName(pathRef)
        };

        const nameArg = pathRef.node.arguments[0];
        if (nameArg && nameArg.type === 'StringLiteral') {
          bucketFor(nameArg.value, kind).push(site);
        } else {
          dynamic[kind].push(site); // computed event name — can't be resolved statically
        }
      }
    });
  }

  return { events, dynamic };
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

const generateEventRegistryLines = (eventRegistry) => {
  const events = sortKeys(eventRegistry || {});
  const names = Object.keys(events);
  if (names.length === 0) return [];

  const lines = [];
  lines.push('export interface SliceEventRegistry {');
  for (const name of names) {
    lines.push(`  '${name}': ${payloadToTs(events[name].payload)};`);
  }
  lines.push('}');
  lines.push('');
  lines.push('type SliceEventCatalog = Record<string, { description?: string; payload?: unknown }>;');
  lines.push('');
  // Single conditional-type signatures (not overload pairs): for a KNOWN event');
  lines.push('// name the payload is enforced; for any other (unknown / framework / dynamic');
  lines.push('// context:* events) it stays permissive. A plain string-fallback overload');
  lines.push('// would swallow wrong-payload calls and defeat the whole point.');
  lines.push('type SliceEventData<K extends string> = K extends keyof SliceEventRegistry ? SliceEventRegistry[K] : unknown;');
  lines.push('type SliceEventArgs<K extends string> = K extends keyof SliceEventRegistry');
  lines.push('  ? (SliceEventRegistry[K] extends void ? [] : [SliceEventRegistry[K]])');
  lines.push('  : unknown[];');
  lines.push('');
  lines.push('export interface SliceTypedEventBinding {');
  lines.push('  subscribe<K extends string>(eventName: K, callback: (data: SliceEventData<K>) => void): string | null;');
  lines.push('  subscribeOnce<K extends string>(eventName: K, callback: (data: SliceEventData<K>) => void): string | null;');
  lines.push('  emit<K extends string>(eventName: K, ...data: SliceEventArgs<K>): void;');
  lines.push('  register(namespace: string, catalog: SliceEventCatalog): unknown;');
  lines.push('  register(catalog: SliceEventCatalog): unknown;');
  lines.push('}');
  lines.push('');
  lines.push('export interface SliceTypedEventManager {');
  lines.push('  init(): boolean;');
  lines.push('  subscribe<K extends string>(eventName: K, callback: (data: SliceEventData<K>) => void, options?: { component?: HTMLElement }): string | null;');
  lines.push('  subscribeOnce<K extends string>(eventName: K, callback: (data: SliceEventData<K>) => void, options?: { component?: HTMLElement }): string | null;');
  lines.push('  unsubscribe(eventName: string, subscriptionId: string): boolean;');
  lines.push('  emit<K extends string>(eventName: K, ...data: SliceEventArgs<K>): void;');
  lines.push('  bind(component: HTMLElement): SliceTypedEventBinding | null;');
  lines.push('  cleanupComponent(sliceId: string): number;');
  lines.push('  hasSubscribers(eventName: string): boolean;');
  lines.push('  subscriberCount(eventName: string): number;');
  lines.push('  isDeclared(eventName: string): boolean;');
  lines.push('  namespaceOf(eventName: string): string | null;');
  lines.push('  register(namespace: string, catalog: SliceEventCatalog): SliceTypedEventManager;');
  lines.push('  register(catalog: SliceEventCatalog): SliceTypedEventManager;');
  lines.push('  clear(): void;');
  lines.push('}');
  lines.push('');
  return lines;
};

const generateDeclarationContent = (componentPropsMap, eventRegistry = {}) => {
  const componentsSorted = sortKeys(componentPropsMap);
  const hasEvents = Object.keys(eventRegistry || {}).length > 0;
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
  if (hasEvents) {
    lines.push(...generateEventRegistryLines(eventRegistry));
  }
  lines.push('declare global {');
  // When typed events exist we declare slice with an index-signature interface so
  // that explicit members (build, events) keep their precise type while dynamic
  // access (slice.anything) stays `any` — `& Record<string, any>` would otherwise
  // collapse slice.events to `any`.
  lines.push(`  const slice: SliceBuildApi${hasEvents ? '' : ' & Record<string, any>'};`);
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
  if (hasEvents) {
    lines.push('    [key: string]: any;');
  }
  lines.push('    build<K extends SliceComponentName>(');
  lines.push('      name: K,');
  lines.push('      props?: SliceComponentPropsMap[K]');
  lines.push('    ): Promise<SliceDynamicElement | null>;');
  if (hasEvents) {
    lines.push('    events: SliceTypedEventManager;');
  }
  lines.push('  }');
  lines.push('}');
  lines.push('');
  lines.push("declare module 'slicejs-web-framework' {");
  lines.push('  interface SliceApi {');
  lines.push('    build<K extends SliceComponentName>(');
  lines.push('      name: K,');
  lines.push('      props?: SliceComponentPropsMap[K]');
  lines.push('    ): Promise<SliceDynamicElement | null>;');
  lines.push('    getComponent<K extends SliceComponentName>(');
  lines.push('      componentSliceId: K | `${K}-${string}`');
  lines.push('    ): SliceDynamicElement | undefined;');
  lines.push('    getComponent<T extends SliceDynamicElement = SliceDynamicElement>(');
  lines.push('      componentSliceId: string');
  lines.push('    ): T | undefined;');
  if (hasEvents) {
    lines.push('    events: SliceTypedEventManager;');
  }
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
  const eventRegistry = await collectEventRegistry({ projectRoot });

  const declaration = generateDeclarationContent(componentPropsMap, eventRegistry);
  await fs.ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, declaration, 'utf8');

  // Static pub/sub graph manifest (documentation): emitters/listeners by call site.
  const eventGraph = await collectEventGraph({ projectRoot });
  const manifest = buildEventManifest(eventRegistry, eventGraph);
  const manifestPath = path.join(path.dirname(outputPath), 'slice-events.generated.js');
  await fs.writeFile(manifestPath, generateEventManifestContent(manifest), 'utf8');

  const siteCount = Object.values(eventGraph.events).reduce(
    (sum, e) => sum + e.emitters.length + e.listeners.length,
    0
  );

  return {
    outputPath,
    manifestPath,
    componentsProcessed: Object.keys(componentPropsMap).length,
    eventsProcessed: Object.keys(eventRegistry).length,
    graphSites: siteCount
  };
};

// Merge the declared registry (payloads) with the static graph (call sites) into one manifest.
const buildEventManifest = (registry, graph) => {
  const names = new Set([...Object.keys(registry), ...Object.keys(graph.events)]);
  const events = {};
  for (const name of Array.from(names).sort((a, b) => a.localeCompare(b))) {
    events[name] = {
      payload: registry[name]?.payload ?? null,
      emitters: graph.events[name]?.emitters || [],
      listeners: graph.events[name]?.listeners || []
    };
  }
  return { events, dynamic: graph.dynamic };
};

const generateEventManifestContent = (manifest) => {
  return `/* Auto-generated by slice types generate. Do not edit manually. */\nexport default ${JSON.stringify(manifest, null, 2)};\n`;
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
  if (typeof result.eventsProcessed === 'number') {
    Print.info(`Registered events typed: ${result.eventsProcessed}`);
  }
  if (result.manifestPath) {
    Print.info(`Event graph manifest: ${toPosixRelative(projectRoot, result.manifestPath)} (${result.graphSites} call site(s))`);
  }
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
  collectEventRegistry,
  collectEventGraph,
  buildEventManifest,
  payloadToTs,
  runGenerateTypes
};
