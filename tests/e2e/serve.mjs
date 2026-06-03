// E2E web server: assembles a complete App-Shell + MultiRoute starter
// (framework src/api + the vendored starter components), runs the real
// production build, and serves dist/ over the production serving contract.
// Used as Playwright's `webServer`. Build artifacts live in an os.tmpdir,
// so nothing is written into the repo.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import { createTestProject } from '../helpers/setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures', 'components');
const FRAMEWORK_SLICE_JS = path.resolve(
  __dirname,
  '../../node_modules/slicejs-web-framework/Slice/Slice.js'
);
const PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 3210;

const CONTENT_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

// A shared module imported by two route components that land in different route
// bundles — this is what triggers the vendor-shared bundle. It must transform to
// >2KB (minVendorSharedTransformedSize), so it embeds a data table that survives
// minification.
function buildSharedKitSource() {
  const rows = [];
  for (let i = 0; i < 60; i += 1) {
    rows.push(
      `  { id: ${i}, key: 'shared_item_${i}', label: 'Shared registry entry number ${i} reused across multiple routes', enabled: ${i % 2 === 0}, weight: ${i * 7} },`
    );
  }
  return `// Shared kit deliberately imported by several routes.
export const SHARED_TAG = 'shared-kit-v1';

export const SHARED_TABLE = [
${rows.join('\n')}
];

export const SHARED_PALETTE = { primary: '#4f46e5', secondary: '#06b6d4', surface: '#0b1020', text: '#e6e9f5' };

export function sharedBadge(label) {
  return '[' + SHARED_TAG + '] ' + String(label);
}

export function sharedLookup(id) {
  return SHARED_TABLE.find((row) => row.id === id) || null;
}

export default { SHARED_TAG, SHARED_TABLE, SHARED_PALETTE, sharedBadge, sharedLookup };
`;
}

const SHARED_KIT_SOURCE = buildSharedKitSource();

// Shared modules for the extra dependency scenarios.
const LEAF_SOURCE = `export const LEAF = 'leaf-value';
export function leafTag() { return 'leaf:' + LEAF; }
`;
// mid.js imports leaf.js -> a transitive dependency of any component using mid.
const MID_SOURCE = `import { LEAF, leafTag } from './leaf.js';
export function midValue() { return 'mid(' + LEAF + ')[' + leafTag() + ']'; }
`;
const APP_CONFIG_SOURCE = `const TITLE = 'Configured';
export const VERSION = 3;
export default { title: TITLE, version: VERSION, tagline: 'default-export-works' };
`;

function componentJs(name, { imports = '', initBody = '' } = {}) {
  return `${imports ? imports + '\n\n' : ''}export default class ${name} extends HTMLElement {
  constructor(props) {
    super();
    slice.attachTemplate(this);
    slice.controller.setComponentProps(this, props);
  }

  init() {
${initBody}
  }
}

customElements.define('slice-${name.toLowerCase()}', ${name});
`;
}

async function scaffold(app, createComponent, name, { js, html, css } = {}) {
  const ok = createComponent(name, 'Visual');
  if (!ok) throw new Error(`[e2e] createComponent failed for ${name}`);
  const dir = path.join(app, 'src', 'Components', 'Visual', name);
  if (js != null) await fs.writeFile(path.join(dir, `${name}.js`), js, 'utf8');
  if (html != null) await fs.writeFile(path.join(dir, `${name}.html`), html, 'utf8');
  if (css != null) await fs.writeFile(path.join(dir, `${name}.css`), css, 'utf8');
}

async function addScenarios(app) {
  const createComponent = (await import('../../commands/createComponent/createComponent.js')).default;
  const sharedDir = path.join(app, 'src', 'shared');
  await fs.ensureDir(sharedDir);
  await fs.writeFile(path.join(sharedDir, 'sharedKit.js'), SHARED_KIT_SOURCE, 'utf8');
  await fs.writeFile(path.join(sharedDir, 'leaf.js'), LEAF_SOURCE, 'utf8');
  await fs.writeFile(path.join(sharedDir, 'mid.js'), MID_SOURCE, 'utf8');
  await fs.writeFile(path.join(sharedDir, 'appConfig.js'), APP_CONFIG_SOURCE, 'utf8');

  // (a) vendor-shared: two route components import the same (>2KB) module and
  //     fall into different route bundles (services vs routing categories).
  for (const name of ['ServicesPage', 'RoutingPage']) {
    await scaffold(app, createComponent, name, {
      js: componentJs(name, {
        imports: "import { SHARED_TAG, sharedBadge } from '../../../shared/sharedKit.js';",
        initBody:
          `    this.dataset.sharedTag = SHARED_TAG;\n    this.dataset.sharedBadge = sharedBadge('${name}');`,
      }),
    });
  }

  // (b) transitive dependency: mid.js itself imports leaf.js.
  await scaffold(app, createComponent, 'TransitivePage', {
    js: componentJs('TransitivePage', {
      imports: "import { midValue } from '../../../shared/mid.js';",
      initBody: '    this.dataset.transitive = midValue();',
    }),
  });

  // (c) default-export dependency.
  await scaffold(app, createComponent, 'DefaultDepPage', {
    js: componentJs('DefaultDepPage', {
      imports: "import cfg from '../../../shared/appConfig.js';",
      initBody: '    this.dataset.cfgTitle = cfg.title;\n    this.dataset.cfgTagline = cfg.tagline;',
    }),
  });

  // (d) CSS application.
  await scaffold(app, createComponent, 'CssProbePage', {
    js: componentJs('CssProbePage'),
    html: '<div class="css-probe-marker">styled by Slice</div>',
    css: '.css-probe-marker { color: rgb(7, 113, 219); font-weight: 700; }',
  });

  // Wire all extra routes (keeping the 404 route last).
  const entries = [
    { path: '/services', component: 'ServicesPage', title: 'Services' },
    { path: '/routing', component: 'RoutingPage', title: 'Routing' },
    { path: '/transitive', component: 'TransitivePage', title: 'Transitive' },
    { path: '/defaultdep', component: 'DefaultDepPage', title: 'DefaultDep' },
    { path: '/cssprobe', component: 'CssProbePage', title: 'CssProbe' },
  ];
  const inserted = entries
    .map((e) => `   { path: '${e.path}', component: '${e.component}', metadata: { title: '${e.title}' } },`)
    .join('\n');

  const routesPath = path.join(app, 'src', 'routes.js');
  let routes = await fs.readFile(routesPath, 'utf8');
  routes = routes.replace(/(\n)(\s*)\{ path: '\/404'/, `\n${inserted}\n$2{ path: '/404'`);
  await fs.writeFile(routesPath, routes, 'utf8');
}

async function assembleAndBuild() {
  process.env.NODE_ENV = 'production';

  // Framework src + api copied into a throwaway project.
  const app = await createTestProject();

  // The bundler discovers the framework's structural components under
  // node_modules/slicejs-web-framework — make the installed package resolvable
  // from the assembled project so the framework bundle is generated.
  const fwPkg = path.resolve(__dirname, '../../node_modules/slicejs-web-framework');
  await fs.ensureDir(path.join(app, 'node_modules'));
  await fs.ensureSymlink(fwPkg, path.join(app, 'node_modules', 'slicejs-web-framework'), 'dir')
    .catch(() => fs.copy(fwPkg, path.join(app, 'node_modules', 'slicejs-web-framework')));

  // Drop in the vendored starter Visual/Service components.
  await fs.copy(path.join(FIXTURES, 'Visual'), path.join(app, 'src', 'Components', 'Visual'));
  await fs.copy(path.join(FIXTURES, 'Service'), path.join(app, 'src', 'Components', 'Service'));

  process.env.INIT_CWD = app;

  // Add the dependency scenarios (vendor-shared, transitive, default-export, CSS)
  // so those bundle paths are built and exercised by the browser specs.
  await addScenarios(app);

  // Regenerate components.js from disk (the real `slice component list`).
  const listComponents = (await import('../../commands/listComponents/listComponents.js')).default;
  listComponents();

  // Real production build. E2E_MINIFY=false exercises the unminified bundle path.
  const minify = process.env.E2E_MINIFY !== 'false';
  const build = (await import('../../commands/build/build.js')).default;
  const ok = await build({ minify, obfuscate: minify });
  if (!ok) {
    console.error('[e2e] build failed');
    process.exit(1);
  }

  return path.join(app, 'dist');
}

function startServer(distDir) {
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

      if (pathname === '/slice-env.json') {
        res.setHeader('Content-Type', CONTENT_TYPES['.json']);
        res.end(JSON.stringify({ mode: 'production', env: {} }));
        return;
      }
      if (pathname === '/Slice/Slice.js') {
        const body = await fs.readFile(FRAMEWORK_SLICE_JS).catch(() => null);
        if (!body) { res.statusCode = 404; res.end('Slice.js not found'); return; }
        res.setHeader('Content-Type', CONTENT_TYPES['.js']);
        res.end(body);
        return;
      }

      const filePath = path.join(distDir, pathname);
      if (!filePath.startsWith(distDir)) { res.statusCode = 403; res.end('forbidden'); return; }

      const stat = await fs.stat(filePath).catch(() => null);
      if (stat && stat.isFile()) {
        res.setHeader('Content-Type', CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream');
        res.end(await fs.readFile(filePath));
        return;
      }

      // A missing file WITH an extension is a genuine 404 (don't mask asset
      // 404s as the SPA shell — that produces confusing MIME errors).
      if (path.extname(pathname)) { res.statusCode = 404; res.end('not found'); return; }

      // Extensionless paths are client routes -> SPA fallback.
      const index = await fs.readFile(path.join(distDir, 'App', 'index.html')).catch(() => null);
      if (index) { res.setHeader('Content-Type', CONTENT_TYPES['.html']); res.end(index); return; }
      res.statusCode = 404;
      res.end('not found');
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[e2e] app server ready at http://127.0.0.1:${PORT} (dist: ${distDir})`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

assembleAndBuild()
  .then(startServer)
  .catch((err) => {
    console.error('[e2e] fatal:', err);
    process.exit(1);
  });
