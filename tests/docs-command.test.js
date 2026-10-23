import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocsClient, normalizeSource } from '../commands/docs/docs.js';

function responseFrom(value, mode = 'text') {
  return {
    ok: true,
    status: 200,
    async text() {
      return mode === 'json' ? JSON.stringify(value) : value;
    },
    async json() {
      return mode === 'json' ? value : JSON.parse(value);
    }
  };
}

function createFixtureFetch() {
  const frameworkBase = 'https://fixtures/framework/';
  const componentsManifest = 'https://fixtures/components/agent/docs-manifest.json';
  const componentsRaw = 'https://fixtures/components';
  const buttonMarkdown = [
    '---',
    'title: Button',
    '---',
    '',
    '# Button',
    '',
    'Use the Button component with an onClick callback.'
  ].join('\n');
  const frameworkMarkdown = [
    '---',
    'title: Services',
    '---',
    '',
    '# Services',
    '',
    'Services are destroyed through the beforeDestroy lifecycle.'
  ].join('\n');

  const manifest = {
    catalog: 'slicejs-components',
    version: '1.4.0',
    revision: 'test-revision',
    documents: [{
      id: 'button',
      title: 'Button',
      kind: 'Visual',
      component: 'Button',
      sourcePath: 'src/markdown/button.md',
      route: '/docs/input/button',
      tags: ['button', 'input'],
      rawUrl: `${componentsRaw}/test-revision/src/markdown/button.md`
    }]
  };

  const frameworkLlm = [
    '=== markdown/getting-started/services.md ===',
    '# Services',
    '',
    'Services are destroyed through the beforeDestroy lifecycle.'
  ].join('\n');

  return async (url) => {
    if (url === `${frameworkBase}llm.txt`) return responseFrom(frameworkLlm);
    if (url === `${frameworkBase}markdown/getting-started/services.md`) return responseFrom(frameworkMarkdown);
    if (url === componentsManifest) return responseFrom(manifest, 'json');
    if (url === manifest.documents[0].rawUrl) return responseFrom(buttonMarkdown);
    return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
  };
}

test('normalizes public and legacy catalog source names', () => {
  assert.equal(normalizeSource('framework'), 'framework');
  assert.equal(normalizeSource('visual-library'), 'components');
  assert.equal(normalizeSource('slice-components'), 'components');
  assert.equal(normalizeSource('all'), 'all');
});

test('lists, searches, and retrieves Slice.js Components Markdown', async () => {
  const client = createDocsClient({
    fetchImpl: createFixtureFetch(),
    frameworkBaseUrl: 'https://fixtures/framework/',
    componentsManifestUrl: 'https://fixtures/components/agent/docs-manifest.json',
    componentsRawBaseUrl: 'https://fixtures/components'
  });

  const documents = await client.list('components');
  assert.equal(documents.length, 1);
  assert.equal(documents[0].source, 'components');
  assert.equal(documents[0].id, 'button');

  const results = await client.search('button onClick', { source: 'components' });
  assert.equal(results.length, 1);
  assert.equal(results[0].doc_id, 'components:button');
  assert.ok(results[0].matched_terms.includes('button'));

  const [document] = await client.get('Button', { source: 'components' });
  assert.equal(document.doc_id, 'components:button');
  assert.match(document.content, /# Button/);
  assert.equal(document.metadata.revision, 'test-revision');
});

test('supports framework and all-catalog reads', async () => {
  const client = createDocsClient({
    fetchImpl: createFixtureFetch(),
    frameworkBaseUrl: 'https://fixtures/framework/',
    componentsManifestUrl: 'https://fixtures/components/agent/docs-manifest.json',
    componentsRawBaseUrl: 'https://fixtures/components'
  });

  const frameworkResults = await client.search('beforeDestroy', { source: 'framework' });
  assert.equal(frameworkResults[0].doc_id, 'framework:getting-started/services');

  const allDocuments = await client.list('all');
  assert.equal(allDocuments.length, 2);

  const [document] = await client.get('framework:getting-started/services', { source: 'all' });
  assert.equal(document.source, 'framework');
  assert.equal(document.metadata.sourcePath, 'markdown/getting-started/services.md');
});
