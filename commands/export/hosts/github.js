// commands/export/hosts/github.js
import fs from 'fs-extra';
import path from 'path';
import { clientSpaFallback } from './shared.js';

export default {
  id: 'github',
  // GitHub Pages has no server redirects/headers. `--spa` writes the shell as
  // 404.html; unknown routes render the app with a 404 status.
  spaMode: 'client-404',
  clientRedirectPages: true,
  ruleFiles: [],

  async write({ outDir }) {
    await fs.writeFile(path.join(outDir, '.nojekyll'), '', 'utf8');
    return ['.nojekyll'];
  },

  async check({ outDir, explicitHost }) {
    const issues = [];
    const warnings = [];
    if (explicitHost && !await fs.pathExists(path.join(outDir, '.nojekyll'))) {
      issues.push('GitHub Pages export is missing .nojekyll.');
    }
    return { issues, warnings };
  },

  spaFallback({ outDir }) {
    return clientSpaFallback(outDir);
  }
};
