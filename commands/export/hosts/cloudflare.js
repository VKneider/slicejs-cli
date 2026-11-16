// commands/export/hosts/cloudflare.js
import fs from 'fs-extra';
import path from 'path';
import { HEADER_RULES, redirectCatchAll, redirectLines } from './shared.js';

export default {
  id: 'cloudflare',
  // Cloudflare Pages only enables its automatic SPA mode when there is no
  // top-level 404.html. A `_redirects` catch-all is rejected as an infinite
  // loop, and `/* / 200` would intercept every asset.
  spaMode: 'omit-404',
  clientRedirectPages: false,
  ruleFiles: ['_redirects', '_headers'],

  async write({ outDir, redirects }) {
    const redirectBlock = redirects.length ? `${redirectLines(redirects)}\n` : '';
    await fs.writeFile(path.join(outDir, '_redirects'), redirectBlock, 'utf8');
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
      issues.push('Cloudflare export is missing _redirects.');
    }
    return { issues, warnings };
  },

  async spaFallback({ outDir }) {
    const has404 = await fs.pathExists(path.join(outDir, '404.html'));
    if (!has404 && await fs.pathExists(path.join(outDir, '_redirects'))) {
      return true;
    }
    const redirectsFile = path.join(outDir, '_redirects');
    if (await fs.pathExists(redirectsFile)) {
      return redirectCatchAll(await fs.readFile(redirectsFile, 'utf8'));
    }
    return false;
  }
};
