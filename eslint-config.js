// ESLint flat config for Slice.js projects.
//
// It lives in the CLI (not its own package) because every Slice project already
// has `slicejs-cli` as a devDependency: one import, one thing to install.
//
//   // eslint.config.js — an app (browser)
//   import slice from 'slicejs-cli/eslint-config.js';
//   export default [
//     ...slice,
//     { languageOptions: { globals: { ToastProvider: 'writable' } } }, // app globals last
//   ];
//
//   // eslint.config.js — tooling that runs in Node
//   import { nodeConfig } from 'slicejs-cli/eslint-config.js';
//   export default nodeConfig;
//
// What belongs here: the environment, the framework globals, and rules that
// catch mistakes without turning every project yellow.
//
// What does NOT belong here: framework invariants (a component that cannot load,
// a broken route, a reserved prop). Those are `slice build` / `slice doctor`
// rules, and they live in exactly one place. Lint runs in your editor; the build
// decides whether a project ships.
//
// A plugin with custom rules was evaluated and rejected for now: an audit of 338
// components across four apps found no true positive for any candidate rule.
// Revisit it if a rule shows real findings.

import js from '@eslint/js';
import globals from 'globals';

/**
 * The globals a Slice app has in the browser: the DOM ones plus the two the
 * framework adds. Exported so a project can reuse them in an override.
 */
export const sliceGlobals = {
  ...globals.browser,
  slice: 'readonly',
  Slice: 'readonly'
};

// Deliberately warnings: they catch a mistake in review without failing a build
// that has been green for months. A project can escalate them in its own config.
const recommendedWarnings = {
  'no-unused-vars': ['warn', {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
    destructuredArrayIgnorePattern: '^_'
  }],
  'no-console': 'off',
  'no-constant-condition': ['warn', { checkLoops: false }],
  'no-constant-binary-expression': 'warn',
  'no-duplicate-imports': 'warn',
  'no-self-compare': 'warn',
  'no-template-curly-in-string': 'warn',
  'no-unmodified-loop-condition': 'warn',
  'no-unreachable-loop': 'warn',
  'no-unused-private-class-members': 'warn',
  'require-atomic-updates': 'off'
};

// Generated, vendored or throwaway output. `components.js` is rewritten by
// `slice component list`, `.tmp/` is where the CLI's own tests write, and the
// agent folders hold a vendored copy of the skill.
const ignores = [
  'dist/**',
  'node_modules/**',
  'coverage/**',
  'playwright-report/**',
  'test-results/**',
  '.tmp/**',
  '.agents/**',
  '.claude/**',
  '.opencode/**',
  'src/libs/**',
  '**/*.generated.js',
  'src/Components/components.js'
];

const base = (globalsForEnv = {}) => [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globalsForEnv
    },
    rules: recommendedWarnings
  },
  { ignores }
];

/** Node globals, for a repo that mixes an app with Node tooling in one config. */
export const nodeGlobals = { ...globals.node };

/** App preset: browser + framework globals for `src/`, Node for the server side. */
export const appConfig = [
  ...base(),
  {
    // App code runs in the browser and sees the framework globals. Scoped, so a
    // server file does not quietly get `document`/`window` as defined globals.
    files: ['src/**/*.{js,mjs,cjs}'],
    languageOptions: { globals: sliceGlobals }
  },
  {
    // The server entry and build scripts are Node, not browser code.
    files: ['api/**/*.{js,mjs,cjs}', 'scripts/**/*.{js,mjs,cjs}', '*.config.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    // Specs and e2e helpers run in Node, and Playwright exposes `page`/`browser`.
    files: ['**/*.spec.js', 'tests/**/*.{js,mjs,cjs}', 'playwright/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...sliceGlobals,
        page: 'readonly',
        browser: 'readonly'
      }
    }
  }
];

/** Node preset: CLIs, build scripts and tooling. */
export const nodeConfig = base({ ...globals.node });

export default appConfig;
