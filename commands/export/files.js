// commands/export/files.js
import fs from 'fs-extra';
import path from 'path';

export async function listFiles(dir, base = dir) {
  const files = [];
  for (const entry of await fs.readdir(dir)) {
    const full = path.join(dir, entry);
    const stat = await fs.stat(full);
    if (stat.isDirectory()) {
      files.push(...await listFiles(full, base));
    } else {
      files.push({ path: path.relative(base, full).replace(/\\/g, '/'), size: stat.size });
    }
  }
  return files;
}

export function pagePathForUrl(url) {
  const clean = String(url).split(/[?#]/)[0].replace(/^\/+|\/+$/g, '');
  if (!clean) return 'index.html';
  const normalized = path.normalize(clean);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error(`Refusing to export an unsafe route: ${url}`);
  }
  return path.join(normalized, 'index.html');
}

export async function writePage(outDir, url, page) {
  const file = path.join(outDir, pagePathForUrl(url));
  await fs.ensureDir(path.dirname(file));
  await fs.writeFile(file, page.html);
}
