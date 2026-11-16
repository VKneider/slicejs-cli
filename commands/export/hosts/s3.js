// commands/export/hosts/s3.js
import { clientSpaFallback } from './shared.js';

export default {
  id: 's3',
  // S3/CloudFront are configured in the bucket/distribution, not in the export.
  // `--spa` writes the shell as 404.html; a CloudFront function is required for
  // a true 200 navigation fallback.
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
