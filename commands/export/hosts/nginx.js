// commands/export/hosts/nginx.js
import fs from 'fs-extra';
import path from 'path';
import { nginxSecurityHeaders } from './shared.js';

const security = nginxSecurityHeaders('  ');

export default {
  id: 'nginx',
  spaMode: 'try-files',
  clientRedirectPages: false,
  ruleFiles: ['nginx.conf'],

  async write({ outDir, redirects, spa }) {
    const redirectBlock = redirects
      .map(({ from, to, status }) => `location = ${from} {\n  return ${status} ${to};\n}\n`)
      .join('\n');
    const fallback = spa ? 'try_files $uri $uri/ /index.html;' : 'try_files $uri $uri/ =404;';

    const nginx = `root /var/www/dist-static;
index index.html;

${redirectBlock}location / {
  ${fallback}
${security}
}

error_page 404 /404.html;

location /bundles/ {
${security}
  add_header Cache-Control "no-store";
}

location = /slice-env.json {
${security}
  add_header Cache-Control "no-store";
}

location = /slice-env.generated.js {
${security}
  add_header Cache-Control "no-store";
}
`;

    await fs.writeFile(path.join(outDir, 'nginx.conf'), nginx, 'utf8');
    return ['nginx.conf'];
  },

  async check({ outDir, explicitHost }) {
    const issues = [];
    const warnings = [];
    const file = path.join(outDir, 'nginx.conf');
    const hasNginx = await fs.pathExists(file);

    if (hasNginx) {
      const text = await fs.readFile(file, 'utf8');
      if (!/error_page\s+404\s+\/404\.html/.test(text)) {
        issues.push('nginx.conf does not map 404 to /404.html.');
      }
    }
    if (explicitHost && !hasNginx) {
      issues.push('nginx export is missing nginx.conf.');
    }
    return { issues, warnings };
  },

  async spaFallback({ outDir }) {
    const file = path.join(outDir, 'nginx.conf');
    if (!await fs.pathExists(file)) return false;
    return /try_files\s+\$uri\s+\$uri\/\s+\/index\.html/.test(await fs.readFile(file, 'utf8'));
  }
};
