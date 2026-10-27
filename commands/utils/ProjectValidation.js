// One validation pass, two consumers.
//
// `slice build` blocks the bundle on it; `slice doctor` reports it. They used to
// disagree because each one picked different fields out of the same result:
// build blocked on source errors and prop errors, doctor showed only props and
// demoted everything to a warning. The rules live in `validateComponentProps`,
// `validateRoutes` and `validateConfigRules`; this module owns the composition
// and the classification, so callers only decide how to print it and which exit
// code to use.

import fs from 'fs-extra';
import path from 'node:path';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import { validateComponentProps, parseComponentsRegistry } from '../types/types.js';
import { describeSyntaxError, findUnresolvedRelativeImports } from './SourceDiagnostics.js';
import { getComponentsJsPath, getConfigPath } from './PathHelper.js';

/**
 * Config combinations that build fine and misbehave at runtime. Pure function:
 * both commands feed it the same object, so the rule exists once.
 */
export function validateConfigRules(config) {
  const problems = [];

  if (config?.context?.enabled && !config?.events?.enabled) {
    problems.push({
      path: 'context.enabled',
      message:
        'requires events.enabled: ContextManager reactivity (setState → watch/bind) runs through '
        + 'EventManager, and EventManager is only bundled when events are enabled.'
    });
  }

  return problems;
}

/**
 * Static checks for `src/routes.js`.
 *
 * The router fetches this file at runtime instead of bundling it, so neither
 * the bundler nor a component-only check ever looks at it. That let `slice
 * build` ship `dist/routes.js` with an import of a file that does not exist.
 */
export async function validateRoutes({ projectRoot, registeredNames = new Set() }) {
  const file = path.join(projectRoot, 'src', 'routes.js');
  const routeErrors = [];
  const routeWarnings = [];
  let routeCount = 0;

  let source;
  try {
    source = await fs.readFile(file, 'utf8');
  } catch {
    return { routeErrors, routeWarnings, routeCount }; // no routes file: nothing to check
  }

  const syntax = describeSyntaxError(source, file);
  if (!syntax.ok) {
    routeErrors.push({ component: 'routes.js', message: `Syntax error at ${syntax.message}` });
    return { routeErrors, routeWarnings, routeCount };
  }

  const unresolved = findUnresolvedRelativeImports(source, path.dirname(file));
  if (unresolved.length > 0) {
    routeErrors.push({
      component: 'routes.js',
      message:
        `cannot resolve ${unresolved.map((spec) => `"${spec}"`).join(', ')}. routes.js is served as-is and `
        + 'loaded by the browser, so an unresolved import breaks the router module and nothing navigates.'
    });
  }

  // `{ path, component: 'Name' }`. A name that is not registered does not break
  // startup: `slice.build(name)` throws when the user navigates to that route.
  // Advisory, so an app with a stale route still builds.
  const reported = new Set();
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
    traverse.default(ast, {
      ObjectExpression({ node }) {
        for (const property of node.properties) {
          if (property.type !== 'ObjectProperty' || property.computed) continue;
          const key = property.name ?? property.key?.name ?? property.key?.value;
          if (property.value?.type !== 'StringLiteral') continue;

          // `:id` looks like a parameter and is never matched: the router only
          // compiles patterns containing `${`.
          if (key === 'path') {
            const routePath = property.value.value;
            const colon = routePath.match(/(?:^|\/):([A-Za-z_]\w*)/);
            if (colon) {
              routeWarnings.push({
                component: 'routes.js',
                message:
                  `route "${routePath}" uses ":${colon[1]}", which Slice never matches. `
                  + `It only compiles "\${${colon[1]}}" patterns, so this path is treated as a literal.`
              });
            }
            continue;
          }

          if (key !== 'component') continue;

          routeCount += 1;
          const name = property.value.value;
          if (registeredNames.has(name) || reported.has(name)) continue;

          reported.add(name);
          routeWarnings.push({
            component: 'routes.js',
            message:
              `a route uses component "${name}", which is not registered in components.js. `
              + `slice.build("${name}") throws when that route is visited.`
          });
        }
      }
    });
  } catch { /* the syntax check above already reported it */ }

  return { routeErrors, routeWarnings, routeCount };
}

/**
 * `api/index.js` is the deployment entrypoint. `slice build` bundles `src/` and
 * never executes it, so a syntax error there survived every check and surfaced
 * as a 500 in production.
 */
export async function validateServerEntry({ projectRoot }) {
  const file = path.join(projectRoot, 'api', 'index.js');

  let source;
  try {
    source = await fs.readFile(file, 'utf8');
  } catch {
    return { serverErrors: [], serverWarnings: [], hasServer: false }; // static app
  }

  const syntax = describeSyntaxError(source, file);
  if (!syntax.ok) {
    return {
      serverErrors: [{ component: 'api/index.js', message: `Syntax error at ${syntax.message}` }],
      serverWarnings: [],
      hasServer: true
    };
  }

  return { serverErrors: [], serverWarnings: [], hasServer: true };
}

/** Config, components and routes in one result. Both commands start here. */
export async function validateProject({ projectRoot, skipComponents = false }) {
  const config = readConfig(projectRoot);
  const registry = readRegistry(projectRoot);

  let components;
  if (skipComponents) {
    components = {
      errors: [], warnings: [], sourceErrors: [], sourceWarnings: [], checkedCount: 0, registeredCount: registry.names.size
    };
  } else {
    try {
      components = await validateComponentProps({ projectRoot });
    } catch (error) {
      // A registry that does not parse used to escape as a stack trace from
      // build and as a vague warning from doctor. It is a blocking finding.
      components = {
        errors: [],
        warnings: [],
        sourceErrors: [{ component: 'components.js', message: error.message }],
        sourceWarnings: [],
        checkedCount: 0,
        registeredCount: 0
      };
    }
  }

  if (registry.error && !components.sourceErrors.some((issue) => issue.component === 'components.js')) {
    components.sourceErrors.push({ component: 'components.js', message: registry.error });
  }

  const routes = await validateRoutes({ projectRoot, registeredNames: registry.names });

  return {
    configErrors: validateConfigRules(config),
    ...components,
    routeErrors: routes.routeErrors,
    routeWarnings: routes.routeWarnings,
    routeCount: routes.routeCount
  };
}

function readConfig(projectRoot) {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(import.meta.url, projectRoot), 'utf8'));
  } catch {
    // A missing or invalid config is the Configuration row's finding, not a
    // silent "no rules to apply".
    return null;
  }
}

function readRegistry(projectRoot) {
  const file = getComponentsJsPath(import.meta.url, projectRoot);
  try {
    const map = parseComponentsRegistry(fs.readFileSync(file, 'utf8'), file);
    return { names: new Set(Object.keys(map)), error: null };
  } catch (error) {
    // No registry at all is not an error: a project may have no components yet.
    return { names: new Set(), error: fs.existsSync(file) ? error.message : null };
  }
}

/**
 * Split a component validation result into what blocks a build and what is only
 * advice. A single place, so `slice doctor` and `slice build` cannot classify
 * the same problem differently.
 */
export function classifyValidation(result = {}) {
  const blocking = [
    ...(result.serverErrors || []).map((issue) => ({
      kind: 'server',
      component: issue.component,
      message: issue.message
    })),
    ...(result.sourceErrors || []).map((issue) => ({
      kind: 'source',
      component: issue.component,
      message: issue.message
    })),
    ...(result.routeErrors || []).map((issue) => ({
      kind: 'route',
      component: issue.component,
      message: issue.message
    })),
    ...(result.errors || []).map((issue) => ({
      kind: 'prop',
      component: issue.component,
      prop: issue.prop,
      message: issue.message
    }))
  ];

  const advisory = [
    ...(result.serverWarnings || []).map((issue) => ({
      kind: 'server-warning',
      component: issue.component,
      message: issue.message
    })),
    ...(result.sourceWarnings || []).map((issue) => ({
      kind: 'source-warning',
      component: issue.component,
      message: issue.message
    })),
    ...(result.routeWarnings || []).map((issue) => ({
      kind: 'route-warning',
      component: issue.component,
      message: issue.message
    })),
    ...(result.warnings || []).map((issue) => ({
      kind: 'prop-warning',
      component: issue.component,
      prop: issue.prop,
      message: issue.message
    }))
  ];

  return { blocking, advisory };
}

/** `Component.prop — message`, or `Component — message` for source findings. */
export function describeIssue(issue) {
  return issue.prop ? `${issue.component}.${issue.prop} — ${issue.message}` : `${issue.component} — ${issue.message}`;
}
