// commands/export/hosts/vercel.js
import fs from 'fs-extra';
import path from 'path';
import { readJsonIfExists, securityHeaderObjects } from './shared.js';

export default {
  id: 'vercel',
  // Vercel checks the filesystem before applying rewrites, so `/(.*)` does not
  // shadow assets.
  spaMode: 'rewrite',
  clientRedirectPages: false,
  ruleFiles: ['vercel.json'],

  async write({ outDir, redirects, spa }) {
    const securityHeaders = securityHeaderObjects();
    const noStoreHeaders = [
      ...securityHeaders,
      { key: 'Cache-Control', value: 'no-store' }
    ];
    const vercel = {
      headers: [
        { source: '/(.*)', headers: securityHeaders },
        { source: '/bundles/(.*)', headers: noStoreHeaders },
        { source: '/slice-env.json', headers: noStoreHeaders },
        { source: '/slice-env.generated.js', headers: noStoreHeaders }
      ]
    };

    if (spa) {
      vercel.rewrites = [{ source: '/(.*)', destination: '/index.html' }];
    }
    if (redirects.length) {
      // `permanent` maps to 308/307; preserve the SEO status with `statusCode`.
      vercel.redirects = redirects.map(({ from, to, status }) => ({
        source: from,
        destination: to,
        statusCode: status
      }));
    }

    await fs.writeFile(
      path.join(outDir, 'vercel.json'),
      `${JSON.stringify(vercel, null, 2)}\n`,
      'utf8'
    );
    return ['vercel.json'];
  },

  async check({ outDir, explicitHost }) {
    const issues = [];
    const warnings = [];
    const file = path.join(outDir, 'vercel.json');
    const hasVercel = await fs.pathExists(file);

    if (hasVercel && !await readJsonIfExists(file)) {
      issues.push('vercel.json is not valid JSON.');
    }
    if (explicitHost && !hasVercel) {
      issues.push('Vercel export is missing vercel.json.');
    }
    return { issues, warnings };
  },

  async spaFallback({ outDir }) {
    const vercel = await readJsonIfExists(path.join(outDir, 'vercel.json'));
    const rewrites = Array.isArray(vercel?.rewrites) ? vercel.rewrites : [];
    return rewrites.some((rewrite) => rewrite?.destination === '/index.html');
  }
};
