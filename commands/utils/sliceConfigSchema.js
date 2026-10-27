// Validates sliceConfig.json against the schema the framework publishes
// (`sliceConfig.schema.json`). The schema shipped since 4.x and nothing ever read
// it, so `"port": "3001"` (a string is a pipe path for listen()) or
// `"enabled": "false"` (truthy) went through unnoticed.
//
// Only what the schema actually declares is checked: type, required and nested
// properties. Unknown keys are not flagged, because the schema is deliberately
// open (`additionalProperties: true`) and lags behind new options.

import fs from 'fs-extra';
import path from 'node:path';

const TYPES = {
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  array: Array.isArray,
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  null: (value) => value === null
};

/** The schema from the installed framework, or null when it is not available. */
export async function loadConfigSchema(projectRoot) {
  const file = path.join(projectRoot, 'node_modules', 'slicejs-web-framework', 'sliceConfig.schema.json');
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** @returns {{path: string, message: string}[]} */
export function validateAgainstSchema(value, schema, at = 'sliceConfig') {
  const issues = [];

  if (schema?.type) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = expected.some((type) => (TYPES[type] ? TYPES[type](value) : true));
    if (!matches) {
      issues.push({ path: at, message: `is ${describe(value)}, expected ${expected.join(' or ')}` });
      return issues; // a wrong type makes every nested check meaningless
    }
  }

  if (Array.isArray(schema?.enum) && !schema.enum.some((option) => option === value)) {
    issues.push({ path: at, message: `must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}` });
  }

  for (const required of schema?.required || []) {
    if (value?.[required] === undefined) issues.push({ path: `${at}.${required}`, message: 'is required' });
  }

  if (TYPES.object(value)) {
    for (const [key, child] of Object.entries(schema?.properties || {})) {
      if (value[key] !== undefined) issues.push(...validateAgainstSchema(value[key], child, `${at}.${key}`));
    }
  }

  if (Array.isArray(value) && schema?.items) {
    value.forEach((item, index) => issues.push(...validateAgainstSchema(item, schema.items, `${at}[${index}]`)));
  }

  return issues;
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'an integer' : 'a number';
  return `a ${typeof value} (${JSON.stringify(value)})`;
}
