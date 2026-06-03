// One-time dev utility: downloads the starter Visual/Service components from the
// official Slice.js visual library and persists them under ./components so the
// browser E2E can assemble a complete, renderable starter app hermetically
// (no network at test time). Re-run with `node tests/e2e/fixtures/vendor-components.mjs`
// to refresh the fixture.
import fs from 'fs-extra';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'components');
const BASE = 'https://raw.githubusercontent.com/VKneider/slice.js_visual_library/master/src/Components';

// Mirrors the starter set installed by `slice init`.
const VISUAL = ['Button', 'Link', 'Loading', 'MultiRoute', 'Navbar', 'NotFound', 'Route'];
const SERVICE = ['FetchManager', 'IndexedDbManager', 'LocalStorageManager'];
// Logical routing components ship JS-only (mirrors getAvailableComponents()).
const JS_ONLY = new Set(['Route', 'MultiRoute', 'Link']);

function filesFor(name, category) {
  if (category === 'Service' || JS_ONLY.has(name)) return [`${name}.js`];
  return [`${name}.js`, `${name}.html`, `${name}.css`];
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function vendor(name, category) {
  const dir = path.join(OUT, category, name);
  await fs.ensureDir(dir);
  for (const file of filesFor(name, category)) {
    const required = file.endsWith('.js');
    try {
      const content = await fetchText(`${BASE}/${category}/${name}/${file}`);
      await fs.writeFile(path.join(dir, file), content, 'utf8');
      process.stdout.write(`  ✓ ${category}/${name}/${file} (${content.length}b)\n`);
    } catch (err) {
      if (required) throw err;
      // Optional html/css may not exist for simple components (e.g. NotFound).
      process.stdout.write(`  - ${category}/${name}/${file} (skipped: ${err.message.split(' for ')[0]})\n`);
    }
  }
}

async function main() {
  await fs.emptyDir(OUT);
  for (const name of VISUAL) await vendor(name, 'Visual');
  for (const name of SERVICE) await vendor(name, 'Service');

  // Persist a registry manifest so the harness can register them in components.js.
  const registry = {};
  for (const name of VISUAL) registry[name] = 'Visual';
  for (const name of SERVICE) registry[name] = 'Service';
  await fs.writeJson(path.join(OUT, 'registry.json'), registry, { spaces: 2 });

  console.log(`\nVendored ${VISUAL.length} Visual + ${SERVICE.length} Service components into ${OUT}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
