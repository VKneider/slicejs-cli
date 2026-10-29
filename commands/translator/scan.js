// `slice translator check` — find the failures that only show up as a key on screen.
//
// The template rules are the framework's own (`Translator/dom.js`), so the CLI and the
// browser cannot disagree about which keys a `data-t` element needs.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'locales', 'public']);
const SKIP_FILES = /(\.spec|\.test|\.generated)\.js$/i;

const require = createRequire(import.meta.url);

/**
 * Resolve the framework's `dom.js` from the project (the version the app runs) or from
 * the CLI's own dependency. Returns null when neither has it (older framework).
 */
export async function loadTemplateRules(projectRoot) {
  const candidates = [
    path.join(projectRoot, 'node_modules', 'slicejs-web-framework', 'Slice', 'Components', 'Structural', 'Translator', 'dom.js')
  ];
  try {
    const entry = require.resolve('slicejs-web-framework');
    candidates.push(path.resolve(path.dirname(entry), '..', 'Slice', 'Components', 'Structural', 'Translator', 'dom.js'));
  } catch {
    // not installed next to the CLI either
  }
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) return null;
  return import(pathToFileURL(file).href);
}

/**
 * Resolve the framework's `content.js` (copy resolver + validator). Returns null when the
 * installed framework is older and does not ship it, so content validation degrades to the
 * file-existence check instead of failing the whole command.
 */
export async function loadContentRules(projectRoot) {
  const candidates = [
    path.join(projectRoot, 'node_modules', 'slicejs-web-framework', 'Slice', 'Components', 'Structural', 'Translator', 'content.js')
  ];
  try {
    const entry = require.resolve('slicejs-web-framework');
    candidates.push(path.resolve(path.dirname(entry), '..', 'Slice', 'Components', 'Structural', 'Translator', 'content.js'));
  } catch {
    // not installed next to the CLI either
  }
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) return null;
  return import(pathToFileURL(file).href);
}

const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
function parseAttributes(source) {
  const attributes = {};
  for (const match of String(source ?? '').matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase();
    attributes[name] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
}

/**
 * Every `data-t` key an HTML string needs: the element's text, the attribute keys
 * (`key.ariaLabel`) and the `data-t-*` params used to resolve plurals.
 * `rules` is the framework's dom.js module.
 */
export function scanHtml(html, rules, where = '') {
  const entries = [];
  for (const match of String(html).matchAll(/<([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)\/?>/g)) {
    const tagName = match[1].toUpperCase();
    const attributes = parseAttributes(match[2]);
    if (!attributes['data-t']) continue;

    const element = {
      tagName,
      hasAttribute: (name) => Object.prototype.hasOwnProperty.call(attributes, name),
      getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null)
    };
    const keys = rules.templateKeys(element);
    if (!keys) continue;

    const params = Object.keys(attributes)
      .filter((name) => name.startsWith('data-t-'))
      .map((name) => name.slice(7))
      .filter((name) => name && !rules.RESERVED_PARAMS.includes(name))
      .map((name) => rules.camelCase(name));

    if (keys.text) entries.push({ key: keys.text, where, kind: 'text', params });
    for (const [attribute, key] of Object.entries(keys.attributes)) {
      entries.push({ key, where, kind: 'attribute', attribute, params });
    }
  }
  return entries;
}

/** `slice.t('key')`, `slice.t.ref('key')`, `slice.t.list('key')`, `slice.t.ref.list('key')`,
 *  `slice.translator.t('key')`, and local helpers named `tr()`/`translate()`. */
export function scanJs(source, where = '') {
  const entries = [];
  const pattern = /(?:slice\.t\.ref\.list|slice\.t\.list|slice\.t\.ref|(?:slice(?:\.translator)?|translator)\.(?:refList|t|ref|list)|(?<![.\w$])(?:\$t|tr|translate))\(\s*(['"])([^'"]+)\1/g;
  for (const match of String(source).matchAll(pattern)) {
    const call = match[0];
    entries.push({
      key: match[2],
      where,
      kind: /\.list\s*\(/.test(call) || /\.refList\s*\(/.test(call) ? 'list' : 'code'
    });
  }
  return entries;
}

/** `slice.t.content('name')`: a content document, not a dictionary key. */
export function scanContentCalls(source, where = '') {
  const calls = [];
  const pattern = /(?:slice\.t|slice\.translator|translator)\.content\(\s*(['"])([^'"]+)\1/g;
  for (const match of String(source).matchAll(pattern)) {
    calls.push({ name: match[2], where });
  }
  return calls;
}

/** Raw `href="/path"` inside an anchor (they lose the locale with routing on). */
export function scanRawHrefs(html) {
  const hrefs = [];
  for (const tag of String(html).matchAll(/<a\b[^>]*>/gi)) {
    const match = /\bhref\s*=\s*(['"])(\/[^'"]*)\1/i.exec(tag[0]);
    if (!match) continue;
    const href = match[2];
    if (href.startsWith('//') || href.startsWith('{{')) continue;
    hrefs.push(href);
  }
  return hrefs;
}

function walk(directory, files = []) {
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(directory, entry.name), files);
      continue;
    }
    if (SKIP_FILES.test(entry.name)) continue;
    if (/\.(html|js)$/i.test(entry.name)) files.push(path.join(directory, entry.name));
  }
  return files;
}

/** Every `.html`/`.js` the app ships (never `locales/`, `public/` or `node_modules/`). */
export function sourceFiles(projectRoot) {
  const src = path.join(projectRoot, 'src');
  const files = new Set(walk(path.join(src, 'Components')));
  for (const extra of [path.join(src, 'App', 'index.html'), path.join(src, 'App', 'index.js'), path.join(src, 'routes.js')]) {
    if (fs.existsSync(extra)) files.add(extra);
  }
  return [...files].sort();
}

/** Read every source file and collect the keys, the raw hrefs and the dictionaries. */
export async function collectProject(projectRoot, options = {}) {
  const rules = options.rules || await loadTemplateRules(projectRoot);
  if (!rules) {
    throw new Error('The installed slicejs-web-framework has no Translator/template rules: update the framework.');
  }

  const entries = [];
  const rawHrefs = [];
  const templates = [];
  const contentCalls = [];
  for (const file of sourceFiles(projectRoot)) {
    const where = path.relative(projectRoot, file);
    const content = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.html')) {
      templates.push({ file, where, content });
      entries.push(...scanHtml(content, rules, where));
      for (const href of scanRawHrefs(content)) rawHrefs.push({ where, href });
    } else {
      entries.push(...scanJs(content, where));
      contentCalls.push(...scanContentCalls(content, where));
    }
  }

  const config = readTranslatorConfig(projectRoot);
  const dictionaries = config?.enabled ? readDictionaries(projectRoot, config) : {};
  const content = config?.enabled ? readContentDocuments(projectRoot, config) : { documents: {}, errors: [] };
  const contentRules = options.contentRules || await loadContentRules(projectRoot);

  return { rules, config, dictionaries, entries, rawHrefs, templates, contentCalls, content, contentRules };
}

export function readTranslatorConfig(projectRoot) {
  for (const folder of ['src', 'dist']) {
    const file = path.join(projectRoot, folder, 'sliceConfig.json');
    if (!fs.existsSync(file)) continue;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')).translator || null;
    } catch (error) {
      throw new Error(`invalid ${folder}/sliceConfig.json: ${error.message}`);
    }
  }
  return null;
}

export function readDictionaries(projectRoot, config) {
  const folder = String(config.path || '/locales').replace(/^\/+|\/+$/g, '') || 'locales';
  const locales = [
    config.defaultLocale,
    ...(Array.isArray(config.locales) ? config.locales : []),
    config.fallbackLocale
  ].filter((value) => typeof value === 'string' && value);

  const dictionaries = {};
  for (const locale of [...new Set(locales)]) {
    for (const base of ['src', 'dist']) {
      const root = path.join(projectRoot, base, folder);
      const file = path.join(root, `${locale}.json`);
      const namespaceDir = path.join(root, locale);
      if (!fs.existsSync(file) && !fs.existsSync(namespaceDir)) continue;
      let messages = {};
      if (fs.existsSync(file)) {
        try {
          messages = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (error) {
          throw new Error(`invalid translator dictionary ${path.join(base, folder, `${locale}.json`)}: ${error.message}`);
        }
      }
      if (fs.existsSync(namespaceDir) && fs.statSync(namespaceDir).isDirectory()) {
        for (const name of fs.readdirSync(namespaceDir)) {
          if (!name.endsWith('.json')) continue;
          try {
            messages[name.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(namespaceDir, name), 'utf8'));
          } catch (error) {
            throw new Error(`invalid translator dictionary ${path.join(base, folder, locale, name)}: ${error.message}`);
          }
        }
      }
      dictionaries[locale] = messages;
      break;
    }
  }
  return dictionaries;
}

/**
 * Every content document under `<path>/content/` (`src` wins over `dist`). Names are the
 * file paths without `.json`, using `/` (`teaching`, `teaching/pr2`).
 * @param {string} projectRoot
 * @param {{ path?: string }} config
 * @returns {{ documents: Record<string, any>, errors: string[] }}
 */
export function readContentDocuments(projectRoot, config) {
  const folder = String(config.path || '/locales').replace(/^\/+|\/+$/g, '') || 'locales';
  const documents = {};
  const errors = [];

  for (const base of ['src', 'dist']) {
    const root = path.join(projectRoot, base, folder, 'content');
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;

    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.json')) continue;
        const name = path.relative(root, full).split(path.sep).join('/').slice(0, -5);
        try {
          documents[name] = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch (error) {
          errors.push(`invalid content document ${path.relative(projectRoot, full)}: ${error.message}`);
        }
      }
    };
    walk(root);
    if (Object.keys(documents).length > 0 || errors.length > 0) break;
  }

  return { documents, errors };
}

export function lookup(dictionary, key) {  let node = dictionary;
  for (const part of String(key).split('.')) {
    if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

function flatten(dictionary, prefix = '', out = []) {
  for (const [key, value] of Object.entries(dictionary || {})) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.other !== 'string') {
      flatten(value, full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

const paramsOf = (text) => new Set([...String(text).matchAll(/\{([A-Za-z_$][\w$]*)\}/g)].map((match) => match[1]));

/**
 * The rules of the feature: missing key per locale, plural without `other`, params that
 * differ between locales, dead keys and raw links that lose the locale.
 */
export function checkTranslations({ entries, dictionaries, config, rawHrefs = [], reportUnused = false, content = { documents: {}, errors: [] }, contentCalls = [], contentRules = null }) {
  const errors = [];
  const warnings = [];
  const locales = config?.enabled
    ? [...new Set([config.defaultLocale, ...(config.locales || [])].filter(Boolean))]
    : [];

  if (!config?.enabled) {
    return { errors: ['translator is not enabled in sliceConfig.json: run `slice translator init`'], warnings };
  }
  if (typeof config.defaultLocale !== 'string' || !config.defaultLocale.trim()) {
    return {
      errors: ['translator.enabled is true but defaultLocale is missing: the runtime stays disabled (set "defaultLocale" or "enabled": false)'],
      warnings
    };
  }
  if (locales.length === 0) {
    return { errors: ['translator has no locales configured'], warnings };
  }

  const seen = new Set();
  for (const entry of entries) {
    // Library defaults (`slice.*`) are registered by the component itself in the
    // translator's defaults layer; the app is not required to copy them.
    if (entry.key.startsWith('slice.')) continue;
    const id = `${entry.kind || 'code'}|${entry.key}|${entry.attribute || ''}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const where = `${entry.where}${entry.attribute ? ` (${entry.attribute})` : ''}`;
    if (entry.kind === 'list') {
      for (const locale of locales) {
        const value = lookup(dictionaries[locale], entry.key)
          ?? lookup(dictionaries[config.fallbackLocale], entry.key);
        if (value === undefined) errors.push(`missing list "${entry.key}" in "${locale}" (${where})`);
        else if (!Array.isArray(value)) errors.push(`"${entry.key}" in "${locale}" is not a list (${where})`);
      }
      continue;
    }

    const texts = {};
    for (const locale of locales) {
      const value = lookup(dictionaries[locale], entry.key)
        ?? lookup(dictionaries[config.fallbackLocale], entry.key);
      if (value === undefined) {
        errors.push(`missing "${entry.key}" in "${locale}" (${where})`);
        continue;
      }
      if (value && typeof value === 'object' && typeof value.other !== 'string') {
        errors.push(`"${entry.key}" in "${locale}" is a group or a plural without "other" (${where})`);
        continue;
      }
      texts[locale] = typeof value === 'string' ? value : value.other;
    }

    const withText = Object.entries(texts);
    if (withText.length > 1) {
      const expected = paramsOf(withText[0][1]);
      for (const [locale, text] of withText.slice(1)) {
        const actual = paramsOf(text);
        for (const param of expected) {
          if (!actual.has(param)) warnings.push(`"${entry.key}" (${locale}) is missing {${param}} used by ${withText[0][0]} (${where})`);
        }
        for (const param of actual) {
          if (!expected.has(param)) warnings.push(`"${entry.key}" (${locale}) uses {${param}} which ${withText[0][0]} does not (${where})`);
        }
      }
    }
  }

  // Content documents: a `slice.t.content('name')` needs `locales/content/name.json`,
  // and every `copy` needs a branch for each locale with the same shape.
  const contentLocales = [...new Set([...locales, config.fallbackLocale].filter(Boolean))];
  const missingDocuments = new Set();
  for (const { name, where } of contentCalls) {
    if (content.documents[name] === undefined && !missingDocuments.has(name)) {
      missingDocuments.add(name);
      errors.push(`missing content document "${name}" (${where})`);
    }
  }
  for (const error of content.errors || []) errors.push(error);
  if (contentRules && typeof contentRules.validateContentDocument === 'function') {
    for (const [name, document] of Object.entries(content.documents || {})) {
      for (const issue of contentRules.validateContentDocument(document, contentLocales)) {
        errors.push(`content/${name}.json${issue.path ? `: ${issue.path}` : ''}: ${issue.message}`);
      }
    }
  }

  // Keys nobody reads: cheap to spot, expensive to keep forever. Opt-in: keys reached
  // through an app helper (`tr(key)`, a table of labels) are invisible to the scan, so
  // this would otherwise report false positives.
  if (reportUnused) {
    const used = new Set(entries.map((entry) => entry.key));
    const unused = [];
    for (const locale of locales) {
      for (const key of flatten(dictionaries[locale])) {
        if (used.has(key) || key.startsWith('slice.')) continue;
        if (!unused.includes(key)) unused.push(key);
      }
    }
    for (const key of unused.slice(0, 20)) warnings.push(`unused key "${key}"`);
    if (unused.length > 20) warnings.push(`…and ${unused.length - 20} more unused keys`);
  }

  if (config.localePrefix) {
    for (const { where, href } of rawHrefs) {
      warnings.push(`raw href="${href}" in ${where} loses the locale: use slice.router.href()`);
    }
  }

  return { errors, warnings };
}

/** Everything `slice translator check` and the doctor row need. */
export async function checkProject(projectRoot, options = {}) {
  const collected = await collectProject(projectRoot, options);
  const result = checkTranslations({
    ...collected,
    reportUnused: options.unused === true
  });
  const locales = collected.config?.enabled
    ? [...new Set([collected.config.defaultLocale, ...(collected.config.locales || [])].filter(Boolean))]
    : [];
  return {
    ...result,
    config: collected.config,
    entries: collected.entries,
    locales,
    dictionaryCount: Object.keys(collected.dictionaries).length,
    contentCount: Object.keys(collected.content?.documents || {}).length
  };
}
