import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { withTestProject } from './helpers/setup.js';
import { classifyValidation, validateConfigRules, validateProject } from '../commands/utils/ProjectValidation.js';
import { checkComponents, checkConfig } from '../commands/doctor/doctor.js';

// The contract this file freezes: whatever `slice build` blocks on, `slice
// doctor` reports as a failure, and whatever build only warns about, doctor
// warns about. They used to disagree — doctor dropped source errors and turned
// every prop error into a warning — so the two commands could contradict each
// other about the same project.

const WIDGET = (body) => path.join('src', 'Components', 'Visual', 'Widget', 'Widget.js');

// The scaffold's routes.js points at demo components the trimmed registry does
// not contain; tests that count advisories start from a route that resolves.
const cleanRoutes = (root) => fs.writeFile(
  path.join(root, 'src', 'routes.js'),
  "const routes = [{ path: '/', component: 'Widget' }];\nexport default routes;\n"
);

async function verdicts(root) {
  const validation = await validateProject({ projectRoot: root });
  return {
    validation,
    ...classifyValidation(validation),
    row: await checkComponents()
  };
}

describe('doctor and build classify components the same way', () => {
  test('a clean project: no findings, doctor passes', async () => {
    await withTestProject(async (root) => {
      // The scaffold's routes.js points at demo components the trimmed registry
      // does not contain. A route that resolves keeps this case clean.
      await fs.writeFile(
        path.join(root, 'src', 'routes.js'),
        "const routes = [{ path: '/', component: 'Widget' }];\nexport default routes;\n"
      );
      const { blocking, advisory, row } = await verdicts(root);
      assert.deepEqual(blocking, []);
      assert.deepEqual(advisory, []);
      assert.equal(row.pass, true);
    }, { visualComponents: ['Widget'] });
  });

  test('a syntax error blocks the build and fails doctor', async () => {
    await withTestProject(async (root) => {
      await fs.writeFile(path.join(root, WIDGET()), 'export default class Widget {\n  static props = { oops: oops }\n');
      const { blocking, row } = await verdicts(root);
      assert.equal(blocking.length, 1);
      assert.equal(blocking[0].kind, 'source');
      assert.equal(row.pass, undefined);
      assert.equal(row.warn, undefined);
      assert.match(row.message, /block "slice build"/);
      assert.equal(row.issues.length, blocking.length);
    }, { visualComponents: ['Widget'] });
  });

  test('a missing default export blocks the build and fails doctor', async () => {
    await withTestProject(async (root) => {
      await fs.writeFile(path.join(root, WIDGET()), 'export const notAComponent = 1;\n');
      const { blocking, row } = await verdicts(root);
      assert.equal(blocking.length, 1);
      assert.match(blocking[0].message, /no default export/);
      assert.equal(row.pass, undefined);
    }, { visualComponents: ['Widget'] });
  });

  test('an unresolved relative import blocks the build and fails doctor', async () => {
    await withTestProject(async (root) => {
      await fs.writeFile(path.join(root, WIDGET()), "import './missing.js';\nexport default class Widget {}\n");
      const { blocking, row } = await verdicts(root);
      assert.equal(blocking.length, 1);
      assert.match(blocking[0].message, /cannot resolve/);
      assert.equal(row.pass, undefined);
    }, { visualComponents: ['Widget'] });
  });

  test('a prop definition error blocks the build and fails doctor', async () => {
    await withTestProject(async (root) => {
      await fs.writeFile(
        path.join(root, WIDGET()),
        "export default class Widget {\n  static props = { label: { type: 'nope' } }\n}\n"
      );
      const { blocking, row } = await verdicts(root);
      assert.equal(blocking.length, 1);
      assert.equal(blocking[0].kind, 'prop');
      assert.equal(row.pass, undefined);
      assert.match(row.suggestion, /Widget\.label/);
    }, { visualComponents: ['Widget'] });
  });

  test('type "any" is advice for both: build warns, doctor warns', async () => {
    await withTestProject(async (root) => {
      await cleanRoutes(root);
      await fs.writeFile(
        path.join(root, WIDGET()),
        "export default class Widget {\n  static props = { label: { type: 'any' } }\n}\n"
      );
      const { blocking, advisory, row } = await verdicts(root);
      assert.deepEqual(blocking, []);
      assert.equal(advisory.length, 1);
      assert.equal(row.warn, true);
      assert.equal(row.pass, undefined);
    }, { visualComponents: ['Widget'] });
  });

  test('building an unregistered component is advice for both', async () => {
    await withTestProject(async (root) => {
      await cleanRoutes(root);
      await fs.writeFile(
        path.join(root, WIDGET()),
        "export default class Widget {\n  init() { slice.build('NotRegistered'); }\n}\n"
      );
      const { blocking, advisory, row } = await verdicts(root);
      assert.deepEqual(blocking, []);
      assert.equal(advisory.length, 1);
      assert.equal(row.warn, true);
    }, { visualComponents: ['Widget'] });
  });

  test('a component folder without its .js is advice for both', async () => {
    await withTestProject(async (root) => {
      await fs.ensureDir(path.join(root, 'src', 'Components', 'Visual', 'Ghost'));
      const { blocking, advisory, row } = await verdicts(root);
      assert.deepEqual(blocking, []);
      assert.ok(advisory.some((issue) => /Ghost/.test(issue.message)));
      assert.equal(row.warn, true);
    }, { visualComponents: ['Widget'] });
  });
});

describe('config rules are shared with the build', () => {
  test('doctor fails on a config the build refuses to bundle', async () => {
    await withTestProject(async (root) => {
      const configPath = path.join(root, 'src', 'sliceConfig.json');
      const config = await fs.readJson(configPath);
      await fs.writeJson(configPath, { ...config, context: { enabled: true }, events: { enabled: false } });

      const row = await checkConfig();
      assert.equal(row.pass, false);
      assert.match(row.message, /would build a broken bundle/);
      assert.match(row.suggestion, /events\.enabled/);
    });
  });

  test('the rule itself is one function', () => {
    assert.equal(validateConfigRules({ context: { enabled: true }, events: { enabled: false } }).length, 1);
    assert.equal(validateConfigRules({ context: { enabled: true }, events: { enabled: true } }).length, 0);
    assert.equal(validateConfigRules({ context: { enabled: false } }).length, 0);
  });
});

describe('routes.js is part of the same pass', () => {
  const writeRoutes = (root, source) => fs.writeFile(path.join(root, 'src', 'routes.js'), source);

  test('an unresolved import blocks the build and fails doctor', async () => {
    await withTestProject(async (root) => {
      // routes.js is served as-is: the bundler never resolves it, so this used
      // to ship and break the router in the browser.
      await writeRoutes(root, "import './Components/Visual/Ghost/Ghost.js';\nconst routes = [];\nexport default routes;\n");
      const { blocking, row } = await verdicts(root);
      assert.equal(blocking.length, 1);
      assert.equal(blocking[0].kind, 'route');
      assert.match(blocking[0].message, /cannot resolve/);
      assert.equal(row.pass, undefined);
      assert.match(row.message, /block "slice build"/);
    }, { visualComponents: ['Widget'] });
  });

  test('a syntax error blocks the build and fails doctor', async () => {
    await withTestProject(async (root) => {
      await writeRoutes(root, 'const routes = [;\nexport default routes;\n');
      const { blocking, row } = await verdicts(root);
      assert.equal(blocking.length, 1);
      assert.match(blocking[0].message, /Syntax error/);
      assert.equal(row.pass, undefined);
    }, { visualComponents: ['Widget'] });
  });

  test('a route pointing at an unregistered component is advice for both', async () => {
    await withTestProject(async (root) => {
      await writeRoutes(root, "const routes = [{ path: '/ghost', component: 'Ghost' }];\nexport default routes;\n");
      const { blocking, advisory, row } = await verdicts(root);
      assert.deepEqual(blocking, []);
      assert.equal(advisory.length, 1);
      assert.match(advisory[0].message, /not registered in components\.js/);
      assert.equal(row.warn, true);
    }, { visualComponents: ['Widget'] });
  });
});

describe('categories and route params', () => {
  test('a component registered under an unknown category blocks the build', async () => {
    await withTestProject(async (root) => {
      await fs.writeFile(
        path.join(root, 'src', 'routes.js'),
        "const routes = [{ path: '/', component: 'Widget' }];\nexport default routes;\n"
      );
      const registryPath = path.join(root, 'src', 'Components', 'components.js');
      const registry = await fs.readFile(registryPath, 'utf8');
      await fs.writeFile(registryPath, registry.replace(/const components = \{/, 'const components = {\n  "GhostComp": "Widgets",'));

      const { blocking, row } = await verdicts(root);
      assert.equal(blocking.length, 1);
      assert.match(blocking[0].message, /no path in sliceConfig\.paths\.components/);
      assert.equal(row.pass, undefined);
    }, { visualComponents: ['Widget'] });
  });

  test('a registered component in a missing category folder blocks the build', async () => {
    await withTestProject(async (root) => {
      await fs.writeFile(
        path.join(root, 'src', 'routes.js'),
        "const routes = [{ path: '/', component: 'Widget' }];\nexport default routes;\n"
      );
      const configPath = path.join(root, 'src', 'sliceConfig.json');
      const config = await fs.readJson(configPath);
      config.paths.components.Widgets = { path: '/Components/Widgets', type: 'Visual' };
      await fs.writeJson(configPath, config);

      const registryPath = path.join(root, 'src', 'Components', 'components.js');
      const registry = await fs.readFile(registryPath, 'utf8');
      await fs.writeFile(registryPath, registry.replace(/const components = \{/, 'const components = {\n  "GhostComp": "Widgets",'));

      const { blocking, row } = await verdicts(root);
      assert.equal(blocking.length, 1, JSON.stringify(blocking));
      assert.match(blocking[0].message, /Components[\\/]Widgets does not exist/);
      assert.equal(row.pass, undefined);
    }, { visualComponents: ['Widget'] });
  });

  test('an empty configured category with no folder is not a finding', async () => {
    await withTestProject(async (root) => {
      await fs.writeFile(
        path.join(root, 'src', 'routes.js'),
        "const routes = [{ path: '/', component: 'Widget' }];\nexport default routes;\n"
      );
      const configPath = path.join(root, 'src', 'sliceConfig.json');
      const config = await fs.readJson(configPath);
      config.paths.components.Future = { path: '/Components/Future', type: 'Visual' };
      await fs.writeJson(configPath, config);

      const { blocking, advisory } = await verdicts(root);
      assert.deepEqual(blocking, []);
      assert.deepEqual(advisory, [], 'a category nothing is registered under is harmless');
    }, { visualComponents: ['Widget'] });
  });

  test('a ":param" route never matches, and is reported', async () => {
    await withTestProject(async (root) => {
      await fs.writeFile(
        path.join(root, 'src', 'routes.js'),
        "const routes = [{ path: '/producto/:id', component: 'Widget' }];\nexport default routes;\n"
      );

      const { blocking, advisory, row } = await verdicts(root);
      assert.deepEqual(blocking, []);
      assert.ok(advisory.some((issue) => /uses ":id"/.test(issue.message)));
      assert.ok(advisory.some((issue) => /\$\{id\}/.test(issue.message)), 'and shows the fix');
      assert.equal(row.warn, true);
    }, { visualComponents: ['Widget'] });
  });
});
