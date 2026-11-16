// commands/export/hosts/netlify.js
import fs from 'fs-extra';
import path from 'path';
import { HEADER_RULES, redirectCatchAll, redirectLines } from './shared.js';

export default {
  id: 'netlify',
  // Netlify's shadowing rules keep existing files first, so the catch-all is
  // safe for assets and gives unknown routes the shell with a 200.
  spaMode: 'redirects',
  clientRedirectPages: false,

  async write({ outDir, redirects, spa }) {
    const redirectBlock = redirects.length ? `${redirectLines(redirects)}\n` : '';
    const spaBlock = spa ? '/*  /index.html  200\n' : '';
    await fs.writeFile(path.join(outDir, '_redirects'), `${redirectBlock}${spaBlock}`, 'utf8');
    await fs.writeFile(path.join(outDir, '_headers'), HEADER_RULES, 'utf8');
    return ['_redirects', '_headers'];
  },

  async check({ outDir, explicitHost }) {
    const issues = [];
    const warnings = [];
    const hasRedirects = await fs.pathExists(path.join(outDir, '_redirects'));
    const hasHeaders = await fs.pathExists(path.join(outDir, '_headers'));

    if (hasRedirects !== hasHeaders) {
      issues.push('_redirects and _headers must be written together (Cloudflare/Netlify).');
    }
    if (explicitHost && !hasRedirects) {
      issues.push('Netlify export is missing _redirects.');
    }
    return { issues, warnings };
  },

  async spaFallback({ outDir }) {
    const redirectsFile = path.join(outDir, '_redirects');
    if (!await fs.pathExists(redirectsFile)) return false;
    return redirectCatchAll(await fs.readFile(redirectsFile, 'utf8'));
  }
};
