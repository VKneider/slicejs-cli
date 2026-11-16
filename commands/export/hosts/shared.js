// commands/export/hosts/shared.js
//
// Pieces every host preset shares: the security headers, the Cloudflare/Netlify
// `_headers` text, redirect lines and the marker used by the client-side
// 404 fallback.
import fs from 'fs-extra';
import path from 'path';

export const SECURITY_HEADERS = [
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin']
];

export const HEADER_RULES = `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
/bundles/*
  Cache-Control: no-store
/slice-env.json
  Cache-Control: no-store
/slice-env.generated.js
  Cache-Control: no-store
`;

// Written into the `404.html` shell used by GitHub Pages, S3 and `--host none`.
// `--check` uses it to know that unknown routes render the app.
export const CLIENT_SPA_MARKER = '<!-- slice:client-spa-fallback -->';

export function redirectLines(redirects) {
  return redirects.map(({ from, to, status }) => `${from}  ${to}  ${status}`).join('\n');
}

export function redirectCatchAll(text) {
  return /^\s*\/\*\s+\/index\.html\s+200\s*$/m.test(text);
}

export async function readJsonIfExists(file) {
  if (!await fs.pathExists(file)) return null;
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export function securityHeaderObjects() {
  return SECURITY_HEADERS.map(([key, value]) => ({ key, value }));
}

export function nginxSecurityHeaders(indent = '  ') {
  return SECURITY_HEADERS
    .map(([key, value]) => `${indent}add_header ${key} "${value}" always;`)
    .join('\n');
}

export async function clientSpaFallback(outDir) {
  const file = path.join(outDir, '404.html');
  if (!await fs.pathExists(file)) return false;
  return (await fs.readFile(file, 'utf8')).includes(CLIENT_SPA_MARKER);
}
