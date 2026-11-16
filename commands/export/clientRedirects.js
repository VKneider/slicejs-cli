// commands/export/clientRedirects.js
//
// Hosts without server redirect rules (GitHub Pages, S3, `--host none`) get
// portable HTML redirect pages. The same module writes the client-side 404
// fallback used by `--spa` on those hosts.
import fs from 'fs-extra';
import path from 'path';
import { pagePathForUrl } from './files.js';
import { CLIENT_SPA_MARKER } from './hosts/shared.js';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clientRedirectHtml(to, origin) {
  const absolute = /^https?:\/\//i.test(to) ? to : `${origin}${to}`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Redirecting…</title>
  <link rel="canonical" href="${escapeHtml(absolute)}">
  <meta name="robots" content="noindex">
  <meta http-equiv="refresh" content="0; url=${escapeHtml(to)}">
</head>
<body>
  <p>Redirecting to <a href="${escapeHtml(to)}">${escapeHtml(to)}</a>…</p>
</body>
</html>
`;
}

export async function writeClientRedirects(outDir, redirects, origin, { allowRoot = false } = {}) {
  let written = 0;
  const skipped = [];
  for (const { from, to } of redirects) {
    const file = path.join(outDir, pagePathForUrl(from));
    if (await fs.pathExists(file)) {
      if (!(allowRoot && from === '/')) {
        // A canonical page already owns this path; do not replace it with a redirect.
        skipped.push(from);
        continue;
      }
    }
    await fs.ensureDir(path.dirname(file));
    await fs.writeFile(file, clientRedirectHtml(to, origin), 'utf8');
    written += 1;
  }
  return { written, skipped };
}

/**
 * GitHub/S3/none cannot return 200 for unknown routes. Writing the app shell as
 * 404.html lets the client router render the route; the host keeps the 404
 * status. The marker lets `--check` recognize this shape.
 */
export async function writeClientSpa404(outDir) {
  const shell = path.join(outDir, 'App', 'index.html');
  const fallback = await fs.pathExists(shell)
    ? shell
    : path.join(outDir, 'index.html');
  const html = await fs.readFile(fallback, 'utf8');
  await fs.writeFile(
    path.join(outDir, '404.html'),
    `${html}\n${CLIENT_SPA_MARKER}\n`,
    'utf8'
  );
}
