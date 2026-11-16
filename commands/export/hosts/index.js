// commands/export/hosts/index.js
//
// Host preset registry. Every preset is a plain object with one job:
//
//   id                 stable name used by --host
//   spaMode            how --spa is implemented on this host
//   clientRedirectPages whether locale redirects become HTML pages
//   write(ctx)         write the host files, return their names
//   check(ctx)         validate the host files
//   spaFallback(ctx)   whether the export declares an SPA fallback
//
// `spaMode` values:
//   omit-404    Cloudflare Pages: no top-level 404.html, automatic SPA
//   redirects   Netlify: `/* /index.html 200`
//   rewrite     Vercel: `/(.*)` rewrite
//   try-files   nginx: `try_files ... /index.html`
//   client-404  GitHub/S3/none: shell as 404.html, status stays 404
import fs from 'fs-extra';
import path from 'path';
import cloudflare from './cloudflare.js';
import netlify from './netlify.js';
import vercel from './vercel.js';
import nginx from './nginx.js';
import github from './github.js';
import s3 from './s3.js';
import none from './none.js';
import { redirectCatchAll } from './shared.js';

const PRESETS = new Map([
  [cloudflare.id, cloudflare],
  [netlify.id, netlify],
  [vercel.id, vercel],
  [nginx.id, nginx],
  [github.id, github],
  [s3.id, s3],
  [none.id, none]
]);

export const HOST_IDS = [...PRESETS.keys()];

export function getHost(value) {
  const id = String(value || 'cloudflare').toLowerCase();
  const preset = PRESETS.get(id);
  if (!preset) {
    throw new Error(`Unknown host "${value}". Use one of: ${HOST_IDS.join(', ')}.`);
  }
  return preset;
}

/**
 * Pick the preset for `--check` when the user did not pass `--host`.
 * The files are the only evidence: Vercel/nginx/GitHub have unique files;
 * Cloudflare and Netlify share `_redirects`/`_headers`, so the catch-all
 * distinguishes them.
 */
export async function detectHost(outDir) {
  if (await fs.pathExists(path.join(outDir, 'vercel.json'))) return vercel;
  if (await fs.pathExists(path.join(outDir, 'nginx.conf'))) return nginx;
  if (await fs.pathExists(path.join(outDir, '.nojekyll'))) return github;

  const redirectsFile = path.join(outDir, '_redirects');
  if (await fs.pathExists(redirectsFile)) {
    const text = await fs.readFile(redirectsFile, 'utf8');
    return redirectCatchAll(text) ? netlify : cloudflare;
  }
  if (await fs.pathExists(path.join(outDir, '_headers'))) return cloudflare;

  return none;
}
