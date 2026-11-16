// commands/export/hosts/none.js
import { clientSpaFallback } from './shared.js';

export default {
  id: 'none',
  // Portable export: no host files. `--spa` writes the shell as 404.html; the
  // server in front decides the status.
  spaMode: 'client-404',
  clientRedirectPages: true,

  async write() {
    return [];
  },

  async check() {
    return { issues: [], warnings: [] };
  },

  spaFallback({ outDir }) {
    return clientSpaFallback(outDir);
  }
};
