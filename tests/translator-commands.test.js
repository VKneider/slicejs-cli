import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkProject,
  checkTranslations,
  loadTemplateRules,
  scanContentCalls,
  scanHtml,
  scanJs,
  scanRawHrefs
} from '../commands/translator/scan.js';
import { initTranslatorFiles } from '../commands/translator/init.js';
import { validateAgainstSchema } from '../commands/utils/sliceConfigSchema.js';

const rules = await loadTemplateRules(process.cwd());
const skip = rules ? false : 'needs slicejs-web-framework (Translator/dom.js)';

const makeProject = (t, { config = null, files = {} } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-translator-cli-'));
  fs.mkdirSync(path.join(root, 'src', 'Components'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'sliceConfig.json'), JSON.stringify(config || { translator: {} }, null, 2));
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, 'src', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

test('scanHtml reuses the framework rules: text, attribute keys and params', { skip }, () => {
  const entries = scanHtml(
    '<input data-t="home.search" placeholder aria-label />\n<p data-t="cart.items" data-t-count="3"></p>',
    rules,
    'template.html'
  );

  assert.deepEqual(
    entries.map((entry) => entry.key),
    ['home.search.placeholder', 'home.search.ariaLabel', 'cart.items']
  );
  assert.deepEqual(entries[2].params, ['count']);
});

test('scanJs reads slice.t, slice.t.ref and translator.ref, and ignores other objects', { skip }, () => {
  const entries = scanJs(
    [
      "const a = slice.t('orders.title');",
      "const b = slice.t.ref('orders.save');",
      "const c = translator.t('plural.count', { count });",
      "const d = other.t('not.ours');",
      "const e = tr('lab.nav.overview', 'Overview');",
      "const f = translator.ref('menu.home');",
      "const g = $t('home.title');",
      "const h = el.translate('not.ours');",
      "const i = chart.tr('not.ours');"
    ].join('\n'),
    'Component.js'
  );

  assert.deepEqual(entries.map((entry) => entry.key), ['orders.title', 'orders.save', 'plural.count', 'lab.nav.overview', 'menu.home', 'home.title']);
});

test('scanRawHrefs only reports app paths', () => {
  const hrefs = scanRawHrefs(
    '<a href="/pricing">x</a><a href="https://acme.dev">y</a><a href="//cdn/z">z</a><a href="#top">t</a>'
  );
  assert.deepEqual(hrefs, ['/pricing']);
});

test('scanJs marks lists and scanContentCalls reads content document names', () => {
  const entries = scanJs(
    [
      "slice.t.list('roles');",
      "slice.t.ref.list('roles');",
      "translator.list('skills');",
      "translator.refList('skills');",
      "slice.t('home.title');",
      "slice.t.content('experience');"
    ].join('\n'),
    'Component.js'
  );

  assert.deepEqual(
    entries.map((entry) => [entry.key, entry.kind]),
    [['roles', 'list'], ['roles', 'list'], ['skills', 'list'], ['skills', 'list'], ['home.title', 'code']]
  );
  assert.deepEqual(scanContentCalls("slice.t.content('experience'); slice.t.content(\"teaching\");", 'Component.js'), [
    { name: 'experience', where: 'Component.js' },
    { name: 'teaching', where: 'Component.js' }
  ]);
});

const BASE_CONFIG = {
  enabled: true,
  defaultLocale: 'es',
  fallbackLocale: 'es',
  locales: ['es', 'en'],
  path: '/locales',
  localePrefix: false
};

const DICTIONARIES = {
  es: { home: { title: 'Inicio' }, cart: { count: { one: '{count} artículo', other: '{count} artículos' } }, unused: 'x' },
  en: { home: { title: 'Home' }, cart: { count: { one: '{count} item', other: '{count} items' } }, unused: 'x' }
};

test('checkTranslations reports a key missing in one locale and a broken plural', () => {
  const { errors } = checkTranslations({
    config: BASE_CONFIG,
    entries: [
      { key: 'home.title', where: 'Home.html' },
      { key: 'cart.count', where: 'Cart.html' },
      { key: 'only.es', where: 'Home.html' }
    ],
    dictionaries: {
      es: { ...DICTIONARIES.es, onlyEs: 'solo', broken: { one: 'uno' } },
      en: DICTIONARIES.en
    }
  });

  assert.ok(errors.some((error) => /missing "only\.es" in "en"/.test(error)));
});

test('checkTranslations warns on param drift, unused keys and raw links with routing', () => {
  const { warnings } = checkTranslations({
    config: { ...BASE_CONFIG, localePrefix: 'except-default' },
    entries: [{ key: 'greeting', where: 'Home.html' }],
    dictionaries: {
      es: { greeting: 'Hola, {name}', unused: 'x' },
      en: { greeting: 'Hello' }
    },
    rawHrefs: [{ where: 'Home.html', href: '/pricing' }],
    reportUnused: true
  });

  assert.ok(warnings.some((warning) => /missing \{name\}/.test(warning)));
  assert.ok(warnings.some((warning) => /unused key "unused"/.test(warning)));
  assert.ok(warnings.some((warning) => /raw href="\/pricing"/.test(warning)));
});

test('init adds the block and creates dictionaries without overwriting them', (t) => {
  const root = makeProject(t, { config: { themeManager: { enabled: true } } });
  const first = initTranslatorFiles({ projectRoot: root, locales: ['es', 'en'], defaultLocale: 'es' });

  assert.deepEqual(first.errors, []);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'src', 'sliceConfig.json'), 'utf8'));
  assert.equal(config.translator.enabled, true);
  assert.equal(config.translator.defaultLocale, 'es');
  assert.deepEqual(config.translator.locales, ['es', 'en']);
  assert.equal(config.themeManager.enabled, true, 'unrelated config survives');
  assert.ok(fs.existsSync(path.join(root, 'src', 'locales', 'es.json')));
  assert.ok(fs.existsSync(path.join(root, 'src', 'locales', 'en.json')));

  fs.writeFileSync(path.join(root, 'src', 'locales', 'es.json'), '{ "home": { "title": "Inicio" } }\n');
  const second = initTranslatorFiles({ projectRoot: root, locales: ['es', 'en'], defaultLocale: 'es' });

  assert.deepEqual(second.errors, []);
  assert.equal(second.files.find((entry) => entry.file.endsWith('es.json')).status, 'exists');
  assert.match(fs.readFileSync(path.join(root, 'src', 'locales', 'es.json'), 'utf8'), /Inicio/);
  assert.equal(second.files.find((entry) => entry.file.endsWith('sliceConfig.json')).status, 'unchanged');
});

test('init does not re-enable a deliberately disabled translator', (t) => {
  const root = makeProject(t, {
    config: { translator: { enabled: false, defaultLocale: 'es', locales: ['es'] } }
  });

  const result = initTranslatorFiles({ projectRoot: root, locales: ['es'], defaultLocale: 'es' });
  assert.deepEqual(result.errors, []);

  const config = JSON.parse(fs.readFileSync(path.join(root, 'src', 'sliceConfig.json'), 'utf8'));
  assert.equal(config.translator.enabled, false);
});

test('schema: if/then, minLength, uniqueItems and additionalProperties are enforced', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      enabled: { type: 'boolean' },
      defaultLocale: { type: 'string', minLength: 1 },
      locales: { type: 'array', uniqueItems: true, items: { type: 'string' } }
    },
    if: { properties: { enabled: { const: true } }, required: ['enabled'] },
    then: { required: ['defaultLocale'] }
  };

  const issues = validateAgainstSchema({ enabled: true, locales: ['es', 'es'], nope: 1 }, schema);
  assert.ok(issues.some((issue) => /defaultLocale/.test(issue.path)));
  assert.ok(issues.some((issue) => /duplicated/.test(issue.message)));
  assert.ok(issues.some((issue) => /not a known option/.test(issue.message)));
  assert.deepEqual(validateAgainstSchema({ enabled: false, locales: ['es'] }, schema), []);
});

test('checkTranslations accepts lists of messages and records, and rejects a non-list', () => {
  const { errors } = checkTranslations({
    config: BASE_CONFIG,
    entries: [
      { key: 'roles', where: 'Home.js', kind: 'list' },
      { key: 'single', where: 'Home.js', kind: 'list' },
      { key: 'missing', where: 'Home.js', kind: 'list' }
    ],
    dictionaries: {
      es: { roles: ['Profesor', 'Ingeniero'], single: 'No es una lista' },
      en: { roles: ['Professor', 'Engineer'], single: ['One'] }
    }
  });

  assert.ok(errors.some((error) => /"single" in "es" is not a list/.test(error)));
  assert.ok(errors.some((error) => /missing list "missing" in "es"/.test(error)));
  assert.ok(errors.some((error) => /missing list "missing" in "en"/.test(error)));
});

test('checkProject validates content documents and referenced names', { skip }, async (t) => {
  const root = makeProject(t, {
    config: { translator: BASE_CONFIG },
    files: {
      'Components/Home/Home.html': '<h1 data-t="home.title"></h1>',
      'Components/Home/Home.js': "export const load = () => slice.t.content('experience');",
      'locales/es.json': JSON.stringify({ home: { title: 'Inicio' } }),
      'locales/en.json': JSON.stringify({ home: { title: 'Home' } }),
      'locales/content/experience.json': JSON.stringify({
        records: [
          {
            id: 1,
            copy: {
              es: { position: 'Ingeniero', responsibilities: ['A', 'B'] },
              en: { position: 'Engineer', responsibilities: ['A', 'B'] }
            }
          }
        ]
      })
    }
  });

  const result = await checkProject(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.contentCount, 1);

  const contentFile = path.join(root, 'src', 'locales', 'content', 'experience.json');
  const document = JSON.parse(fs.readFileSync(contentFile, 'utf8'));
  delete document.records[0].copy.es;
  fs.writeFileSync(contentFile, JSON.stringify(document));
  const brokenCopy = await checkProject(root);
  assert.ok(brokenCopy.errors.some((error) => /content\/experience\.json: records\[0\]\.copy: copy is missing "es"/.test(error)));

  fs.writeFileSync(
    path.join(root, 'src', 'Components', 'Home', 'Home.js'),
    "export const load = () => slice.t.content('missing');"
  );
  const missingDocument = await checkProject(root);
  assert.ok(missingDocument.errors.some((error) => /missing content document "missing"/.test(error)));
});

test('checkProject reads templates, js and dictionaries from the project', { skip }, async (t) => {
  const root = makeProject(t, {
    config: { translator: BASE_CONFIG },
    files: {
      'Components/Home/Home.html': '<h1 data-t="home.title"></h1><input data-t="home.search" placeholder />',
      'Components/Home/Home.js': "export const label = slice.t('home.save');",
      'locales/es.json': JSON.stringify({ home: { title: 'Inicio', save: 'Guardar', search: { placeholder: 'Buscar' } } }),
      'locales/en.json': JSON.stringify({ home: { title: 'Home', save: 'Save', search: { placeholder: 'Search' } } })
    }
  });

  const result = await checkProject(root);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.locales, ['es', 'en']);

  fs.writeFileSync(path.join(root, 'src', 'locales', 'en.json'), JSON.stringify({ home: { title: 'Home' } }));
  const fallbackOnly = await checkProject(root);
  // The key is missing in `en` but the configured fallback (`es`) answers, as at runtime.
  assert.deepEqual(fallbackOnly.errors, []);

  fs.writeFileSync(path.join(root, 'src', 'locales', 'es.json'), JSON.stringify({ home: { title: 'Inicio' } }));
  const broken = await checkProject(root);
  assert.ok(broken.errors.some((error) => /missing "home\.save" in "es"/.test(error)));
  assert.ok(broken.errors.some((error) => /missing "home\.search\.placeholder" in "en"/.test(error)));
});
