import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(__dirname, '..', 'client.js');
const source = fs.readFileSync(clientPath, 'utf-8');
const ast = parse(source, {
  sourceType: 'module',
  plugins: []
});

function walk(node, visit) {
  if (!node || typeof node !== 'object') {
    return;
  }

  visit(node);

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, visit);
      }
      continue;
    }

    walk(value, visit);
  }
}

function getImportedLocalNames(fromSource) {
  const localNames = new Set();

  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration') {
      continue;
    }

    if (statement.source.value !== fromSource) {
      continue;
    }

    for (const specifier of statement.specifiers) {
      if (
        specifier.type === 'ImportSpecifier' ||
        specifier.type === 'ImportDefaultSpecifier' ||
        specifier.type === 'ImportNamespaceSpecifier'
      ) {
        localNames.add(specifier.local.name);
      }
    }
  }

  return localNames;
}

function getIdentifierCallPositions(name) {
  const positions = [];

  walk(ast.program, (node) => {
    if (node.type !== 'CallExpression') {
      return;
    }

    if (node.callee.type === 'Identifier' && node.callee.name === name) {
      positions.push(node.start);
    }
  });

  return positions;
}

function getFirstCommandRegistrationPosition() {
  let first = Infinity;

  walk(ast.program, (node) => {
    if (node.type !== 'CallExpression') {
      return;
    }

    if (
      node.callee.type === 'MemberExpression' &&
      !node.callee.computed &&
      node.callee.property.type === 'Identifier' &&
      node.callee.property.name === 'command'
    ) {
      first = Math.min(first, node.start);
    }
  });

  return first;
}

const firstCommandRegistrationPos = getFirstCommandRegistrationPosition();

test('client imports LocalCliDelegation utility', () => {
  const importedFromModule = getImportedLocalNames('./commands/utils/LocalCliDelegation.js');

  assert.ok(
    importedFromModule.size > 0,
    'Contract clause failed: client.js must import launcher helpers from ./commands/utils/LocalCliDelegation.js'
  );
});

test('client checks SLICE_NO_LOCAL_DELEGATION behavior before command runtime', () => {
  const isDisabledCalls = getIdentifierCallPositions('isLocalDelegationDisabled');

  assert.ok(
    isDisabledCalls.length > 0,
    'Contract clause failed: client.js must call isLocalDelegationDisabled() in launcher path'
  );

  assert.ok(
    isDisabledCalls.some((pos) => pos < firstCommandRegistrationPos),
    'Contract clause failed: isLocalDelegationDisabled() must be evaluated before command registration/runtime wiring'
  );
});

test('client performs local candidate resolution and delegation decision', () => {
  const findNearestCalls = getIdentifierCallPositions('findNearestLocalCliEntry');
  const shouldDelegateCalls = getIdentifierCallPositions('shouldDelegateToLocalCli');

  assert.ok(
    findNearestCalls.length > 0,
    'Contract clause failed: client.js must call findNearestLocalCliEntry() to resolve local CLI candidate in launcher path'
  );

  assert.ok(
    shouldDelegateCalls.length > 0,
    'Contract clause failed: client.js must call shouldDelegateToLocalCli() to gate delegation in launcher path'
  );

  assert.ok(
    findNearestCalls.some((pos) => pos < firstCommandRegistrationPos),
    'Contract clause failed: findNearestLocalCliEntry() must execute before command registration/runtime wiring'
  );

  assert.ok(
    shouldDelegateCalls.some((pos) => pos < firstCommandRegistrationPos),
    'Contract clause failed: shouldDelegateToLocalCli() must execute before command registration/runtime wiring'
  );
});
