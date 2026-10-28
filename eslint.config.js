import { nodeConfig, sliceGlobals } from './eslint-config.js';

export default [
  ...nodeConfig,
  // Templates copied into new projects, the browser fixtures the e2e tests load,
  // and the seo command's page.evaluate callbacks all run in the browser.
  {
    files: ['assets/**/*.js', 'tests/**/*.js', 'commands/seo/images.js'],
    languageOptions: { globals: sliceGlobals }
  }
];
