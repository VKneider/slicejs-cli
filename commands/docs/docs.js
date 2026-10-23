import Print from '../Print.js';

const DEFAULT_FRAMEWORK_BASE_URL = 'https://raw.githubusercontent.com/VKneider/slicejs_docs/master/';
const DEFAULT_COMPONENTS_MANIFEST_URL = 'https://raw.githubusercontent.com/VKneider/slice.js_visual_library/master/agent/docs-manifest.json';
const DEFAULT_COMPONENTS_RAW_BASE_URL = 'https://raw.githubusercontent.com/VKneider/slice.js_visual_library';

const SOURCE_ALIASES = new Map([
  ['framework', 'framework'],
  ['slice-docs', 'framework'],
  ['slicejs-docs', 'framework'],
  ['components', 'components'],
  ['visual', 'components'],
  ['visual-library', 'components'],
  ['slice-components', 'components'],
  ['all', 'all']
]);

function normalizeSource(source = 'all') {
  const normalized = SOURCE_ALIASES.get(String(source).trim().toLowerCase());
  if (!normalized) {
    throw new Error(`Unknown documentation source "${source}". Use framework, components, or all.`);
  }
  return normalized;
}

function joinUrl(base, suffix) {
  return `${String(base).replace(/\/+$/, '')}/${String(suffix).replace(/^\/+/, '')}`;
}

async function fetchResponse(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }
  return response;
}

async function fetchText(url, fetchImpl) {
  const response = await fetchResponse(url, fetchImpl);
  return response.text();
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchResponse(url, fetchImpl);
  return response.json();
}

function getTitle(content, fallback) {
  const titleLine = content.split(/\r?\n/).find((line) => line.startsWith('# '));
  return titleLine ? titleLine.slice(2).trim() : fallback;
}

function parseFrameworkLlm(content, baseUrl, revision = 'master') {
  const documents = [];
  const sections = (`\n${content}`).split(/\n=== /).slice(1);

  for (const section of sections) {
    const lines = section.split('\n');
    const path = lines[0].replace(' ===', '').trim();
    const searchText = lines.slice(1).join('\n').trim();
    if (!path || !searchText) continue;

    const id = path.replace(/^markdown\//, '').replace(/\.md$/, '');
    documents.push({
      source: 'framework',
      catalog: 'slicejs-docs',
      id,
      title: getTitle(searchText, id.split('/').pop()),
      path,
      sourcePath: path,
      rawUrl: joinUrl(baseUrl, path),
      description: '',
      tags: [],
      revision,
      searchText
    });
  }

  return documents;
}

function normalizeComponentsManifest(manifest, rawBaseUrl, preferRawBaseUrl = false) {
  if (!manifest || !Array.isArray(manifest.documents)) {
    throw new Error('Components documentation manifest is missing a documents array');
  }

  return manifest.documents.map((document) => ({
    ...document,
    source: 'components',
    catalog: manifest.catalog || 'slicejs-components',
    path: document.sourcePath,
    rawUrl: preferRawBaseUrl || !document.rawUrl
      ? joinUrl(rawBaseUrl, `${manifest.revision || 'master'}/${document.sourcePath}`)
      : document.rawUrl,
    searchText: null,
    revision: manifest.revision,
    version: manifest.version
  }));
}

function qualifiedId(document) {
  return `${document.source}:${document.id}`;
}

function matchesDocument(document, requestedId) {
  const value = String(requestedId).trim().toLowerCase();
  return [document.id, document.component, document.title, qualifiedId(document)]
    .filter(Boolean)
    .some((candidate) => String(candidate).toLowerCase() === value);
}

function scoreDocument(document, content, query, maxSnippets) {
  const phrase = query.toLowerCase().trim();
  const terms = [...new Set(phrase.split(/\s+/).filter(Boolean))];
  if (terms.length === 0) return null;

  const lines = content.split(/\r?\n/);
  const title = String(document.title || '').toLowerCase();
  const tags = Array.isArray(document.tags) ? document.tags.join(' ').toLowerCase() : '';
  const matched = new Set();
  let score = 0;

  for (const term of terms) {
    if (title.includes(term)) {
      score += 6;
      matched.add(term);
    }
    if (tags.includes(term)) {
      score += 4;
      matched.add(term);
    }
  }

  if (terms.length > 1 && title.includes(phrase)) score += 10;

  const hits = [];
  let section = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^#{1,6}\s/.test(line)) section = line.replace(/^#{1,6}\s+/, '').trim();

    const lower = line.toLowerCase();
    let lineScore = 0;
    for (const term of terms) {
      if (lower.includes(term)) {
        lineScore += /^#{1,6}\s/.test(line) ? 3 : 1;
        matched.add(term);
      }
    }
    if (terms.length > 1 && lower.includes(phrase)) lineScore += 5;
    if (lineScore > 0) {
      score += lineScore;
      hits.push({ line: index + 1, section: section || document.title, text: line.trim(), lineScore });
    }
  }

  if (matched.size === 0) return null;
  const coverage = matched.size / terms.length;
  score *= 0.5 + 0.5 * coverage;

  return {
    doc_id: qualifiedId(document),
    source: document.source,
    title: document.title,
    path: document.path,
    relevance_score: Math.round(score * 100) / 100,
    matched_terms: [...matched],
    snippets: hits
      .sort((a, b) => b.lineScore - a.lineScore || a.line - b.line)
      .slice(0, maxSnippets)
      .map(({ line, section: hitSection, text }) => ({ line, section: hitSection, text }))
  };
}

export function createDocsClient(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required to access documentation');
  }

  const frameworkBaseUrl = options.frameworkBaseUrl || process.env.SLICE_FRAMEWORK_DOCS_BASE_URL || DEFAULT_FRAMEWORK_BASE_URL;
  const frameworkRevision = options.frameworkRevision || process.env.SLICE_FRAMEWORK_DOCS_REVISION || 'master';
  const componentsManifestUrl = options.componentsManifestUrl || process.env.SLICE_COMPONENTS_MANIFEST_URL || DEFAULT_COMPONENTS_MANIFEST_URL;
  const componentsRawBaseOverride = options.componentsRawBaseUrl || process.env.SLICE_COMPONENTS_RAW_BASE_URL || null;
  const componentsRawBaseUrl = componentsRawBaseOverride || DEFAULT_COMPONENTS_RAW_BASE_URL;
  const catalogCache = new Map();
  const contentCache = new Map();

  async function loadCatalog(source) {
    const normalized = normalizeSource(source);
    if (normalized === 'all') {
      const [framework, components] = await Promise.all([
        loadCatalog('framework'),
        loadCatalog('components')
      ]);
      return [...framework, ...components];
    }

    if (catalogCache.has(normalized)) return catalogCache.get(normalized);

    const promise = normalized === 'framework'
      ? fetchText(joinUrl(frameworkBaseUrl, 'llm.txt'), fetchImpl)
        .then((content) => parseFrameworkLlm(content, frameworkBaseUrl, frameworkRevision))
      : fetchJson(componentsManifestUrl, fetchImpl)
        .then((manifest) => normalizeComponentsManifest(manifest, componentsRawBaseUrl, Boolean(componentsRawBaseOverride)));

    catalogCache.set(normalized, promise);
    return promise;
  }

  async function getContent(document) {
    const key = qualifiedId(document);
    if (contentCache.has(key)) return contentCache.get(key);

    const promise = fetchText(document.rawUrl, fetchImpl);
    contentCache.set(key, promise);
    return promise;
  }

  async function list(source = 'all') {
    return loadCatalog(source);
  }

  async function search(query, { source = 'all', maxResults = 5, snippetsPerDoc = 3 } = {}) {
    const documents = await loadCatalog(source);
    const results = [];
    for (const document of documents) {
      const content = document.searchText || await getContent(document);
      const result = scoreDocument(document, content, query, snippetsPerDoc);
      if (result) results.push(result);
    }
    return results
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, maxResults);
  }

  async function get(ids, { source = 'all' } = {}) {
    const requestedIds = Array.isArray(ids) ? ids : [ids];
    const documents = await loadCatalog(source);
    const results = [];

    for (const requestedId of requestedIds) {
      const document = documents.find((candidate) => matchesDocument(candidate, requestedId));
      if (!document) {
        throw new Error(`Documentation document not found: "${requestedId}" in source "${normalizeSource(source)}"`);
      }

      const content = await getContent(document);
      results.push({
        doc_id: qualifiedId(document),
        source: document.source,
        catalog: document.catalog,
        id: document.id,
        title: document.title,
        content,
        metadata: {
          path: document.path,
          sourcePath: document.sourcePath,
          rawUrl: document.rawUrl,
          route: document.route || null,
          component: document.component || null,
          kind: document.kind || null,
          tags: document.tags || [],
          version: document.version || null,
          revision: document.revision || null
        }
      });
    }

    return results;
  }

  return { list, search, get };
}

function parseMaxResults(value, fallback = 5) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

export async function runDocsList(options = {}) {
  const client = createDocsClient();
  const documents = await client.list(options.source || 'all');
  const entries = documents.map((document) => ({
    doc_id: qualifiedId(document),
    source: document.source,
    catalog: document.catalog,
    id: document.id,
    title: document.title,
    path: document.path,
    sourcePath: document.sourcePath,
    component: document.component,
    kind: document.kind,
    route: document.route || null,
    tags: document.tags || [],
    version: document.version || null,
    revision: document.revision || null
  }));
  if (options.json) {
    console.log(JSON.stringify(entries));
    return entries;
  }

  Print.title(`Documentation (${normalizeSource(options.source || 'all')})`);
  for (const document of documents) {
    const suffix = document.component ? ` [${document.kind}]` : '';
    console.log(`- ${document.source}:${document.id} — ${document.title}${suffix}`);
  }
  return entries;
}

export async function runDocsSearch(query, options = {}) {
  if (!query || !query.trim()) throw new Error('A search query is required');
  const client = createDocsClient();
  const results = await client.search(query, {
    source: options.source || 'all',
    maxResults: parseMaxResults(options.maxResults),
    snippetsPerDoc: parseMaxResults(options.snippetsPerDoc, 3)
  });

  if (options.json) {
    console.log(JSON.stringify(results));
    return results;
  }

  Print.title(`Documentation search: ${query}`);
  for (const result of results) {
    console.log(`- ${result.doc_id} — ${result.title} (${result.relevance_score})`);
    for (const snippet of result.snippets) {
      console.log(`  ${snippet.section}: ${snippet.text}`);
    }
  }
  if (results.length === 0) Print.info('No matching documentation found.');
  return results;
}

export async function runDocsGet(ids, options = {}) {
  if (!ids || ids.length === 0) throw new Error('At least one documentation ID is required');
  const client = createDocsClient();
  const results = await client.get(ids, { source: options.source || 'all' });

  if (options.json) {
    console.log(JSON.stringify(results.length === 1 ? results[0] : results));
    return results;
  }

  if (options.stdout) {
    for (let index = 0; index < results.length; index += 1) {
      if (index > 0) process.stdout.write('\n\n---\n\n');
      process.stdout.write(results[index].content);
    }
    if (results.length > 0 && !results[results.length - 1].content.endsWith('\n')) process.stdout.write('\n');
    return results;
  }

  for (const result of results) {
    Print.title(`${result.title} (${result.doc_id})`);
    console.log(result.content);
    Print.info(`Source: ${result.metadata.rawUrl}`);
  }
  return results;
}

export { normalizeSource, parseFrameworkLlm, scoreDocument };
