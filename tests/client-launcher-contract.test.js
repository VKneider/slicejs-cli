import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import babelTraverse from '@babel/traverse';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(__dirname, '..', 'client.js');
const source = fs.readFileSync(clientPath, 'utf-8');
const ast = parse(source, {
  sourceType: 'module',
  plugins: []
});
const traverse = babelTraverse.default || babelTraverse;

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

function getImportedBindings(fromSource) {
  const bindings = new Map();

  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration') {
      continue;
    }

    if (statement.source.value !== fromSource) {
      continue;
    }

    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier') {
        bindings.set(specifier.imported.name, specifier.local.name);
      }
    }
  }

  return bindings;
}

function getBoundImportedCallPositions(fromSource, importedName) {
  const positions = [];
  const importedBindings = getImportedBindings(fromSource);
  const localName = importedBindings.get(importedName);

  if (!localName) {
    return positions;
  }

  traverse(ast, {
    CallExpression(callPath) {
      if (callPath.node.callee.type !== 'Identifier') {
        return;
      }

      if (callPath.node.callee.name !== localName) {
        return;
      }

      const binding = callPath.scope.getBinding(localName);
      if (!binding) {
        return;
      }

      if (binding.path.node.type !== 'ImportSpecifier') {
        return;
      }

      if (binding.path.parent.type !== 'ImportDeclaration') {
        return;
      }

      if (binding.path.parent.source.value !== fromSource) {
        return;
      }

      if (binding.path.node.imported.type !== 'Identifier') {
        return;
      }

      if (binding.path.node.imported.name !== importedName) {
        return;
      }

      positions.push(callPath.node.start);
    }
  });

  return positions;
}

function getCommandRegistrationPositions() {
  const positions = [];

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
      positions.push(node.start);
    }
  });

  return positions;
}

const launcherModulePath = './commands/utils/LocalCliDelegation.js';
const commandRegistrationPositions = getCommandRegistrationPositions();
const firstCommandRegistrationPos = Math.min(...commandRegistrationPositions);

test('client imports LocalCliDelegation utility', () => {
  const importedBindings = getImportedBindings(launcherModulePath);

  assert.ok(
    importedBindings.size > 0,
    'Contract clause failed: client.js must import launcher helpers from ./commands/utils/LocalCliDelegation.js'
  );

  for (const requiredImport of [
    'isLocalDelegationDisabled',
    'findNearestLocalCliEntry',
    'shouldDelegateToLocalCli'
  ]) {
    assert.ok(
      importedBindings.has(requiredImport),
      `Contract clause failed: client.js must import ${requiredImport} from ${launcherModulePath}`
    );
  }
});

test('client checks SLICE_NO_LOCAL_DELEGATION behavior before command runtime', () => {
  const isDisabledCalls = getBoundImportedCallPositions(
    launcherModulePath,
    'isLocalDelegationDisabled'
  );

  assert.ok(
    isDisabledCalls.length > 0,
    'Contract clause failed: client.js must call imported isLocalDelegationDisabled() in launcher path'
  );

  assert.ok(
    commandRegistrationPositions.length > 0,
    'Contract clause failed: client.js must define at least one .command(...) registration before launcher ordering checks'
  );

  assert.ok(
    isDisabledCalls.some((pos) => pos < firstCommandRegistrationPos),
    'Contract clause failed: isLocalDelegationDisabled() must be evaluated before command registration/runtime wiring'
  );
});

test('client performs local candidate resolution and delegation decision', () => {
  const findNearestCalls = getBoundImportedCallPositions(
    launcherModulePath,
    'findNearestLocalCliEntry'
  );
  const shouldDelegateCalls = getBoundImportedCallPositions(
    launcherModulePath,
    'shouldDelegateToLocalCli'
  );

  assert.ok(
    findNearestCalls.length > 0,
    'Contract clause failed: client.js must call imported findNearestLocalCliEntry() to resolve local CLI candidate in launcher path'
  );

  assert.ok(
    shouldDelegateCalls.length > 0,
    'Contract clause failed: client.js must call imported shouldDelegateToLocalCli() to gate delegation in launcher path'
  );

  assert.ok(
    commandRegistrationPositions.length > 0,
    'Contract clause failed: client.js must define at least one .command(...) registration before launcher ordering checks'
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
