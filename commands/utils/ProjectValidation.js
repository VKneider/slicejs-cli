// One validation pass, two consumers.
//
// `slice build` blocks the bundle on it; `slice doctor` reports it. They used to
// disagree because each one picked different fields out of the same result:
// build blocked on source errors and prop errors, doctor showed only props and
// demoted everything to a warning. The rules live in `validateComponentProps`
// and `validateConfigRules`; this module owns the classification, so callers
// only decide how to print it and which exit code to use.

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
 * Split a component validation result into what blocks a build and what is only
 * advice. A single place, so `slice doctor` and `slice build` cannot classify
 * the same problem differently.
 */
export function classifyValidation(result = {}) {
  const blocking = [
    ...(result.sourceErrors || []).map((issue) => ({
      kind: 'source',
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
    ...(result.sourceWarnings || []).map((issue) => ({
      kind: 'source-warning',
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
