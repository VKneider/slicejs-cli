import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(__dirname, '..', 'client.js');
const clientSource = fs.readFileSync(clientPath, 'utf-8');
const ast = parse(clientSource, {
  sourceType: 'module'
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

function isUpdateManagerCall(node, methodName) {
  return (
    node &&
    node.type === 'CallExpression' &&
    node.callee &&
    node.callee.type === 'MemberExpression' &&
    node.callee.object &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'updateManager' &&
    node.callee.property &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === methodName
  );
}

function isCommandUpdateExpression(node) {
  if (!node || node.type !== 'CallExpression') {
    return false;
  }

  if (
    node.callee &&
    node.callee.type === 'MemberExpression' &&
    node.callee.property &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === 'command' &&
    node.arguments[0] &&
    node.arguments[0].type === 'StringLiteral' &&
    node.arguments[0].value === 'update'
  ) {
    return true;
  }

  if (node.callee && node.callee.type === 'MemberExpression') {
    return isCommandUpdateExpression(node.callee.object);
  }

  return false;
}

test('runWithVersionCheck uses non-blocking update notifications', () => {
  let runWithVersionCheckNode = null;

  walk(ast, (node) => {
    if (
      node.type === 'FunctionDeclaration' &&
      node.id &&
      node.id.type === 'Identifier' &&
      node.id.name === 'runWithVersionCheck'
    ) {
      runWithVersionCheckNode = node;
    }
  });

  assert.ok(runWithVersionCheckNode, 'runWithVersionCheck function should exist');

  let hasAwaitedNotifyCall = false;
  let hasPromptCall = false;

  walk(runWithVersionCheckNode.body, (node) => {
    if (
      node.type === 'AwaitExpression' &&
      isUpdateManagerCall(node.argument, 'notifyAvailableUpdates')
    ) {
      hasAwaitedNotifyCall = true;
    }
    if (isUpdateManagerCall(node, 'checkAndPromptUpdates')) {
      hasPromptCall = true;
    }
  });

  assert.equal(
    hasAwaitedNotifyCall,
    true,
    'runWithVersionCheck must await updateManager.notifyAvailableUpdates()'
  );
  assert.equal(hasPromptCall, false, 'runWithVersionCheck must not call updateManager.checkAndPromptUpdates()');
});

test('update command remains explicitly interactive', () => {
  let foundAwaitedInteractiveUpdateAction = false;

  walk(ast, (node) => {
    if (
      node.type === 'CallExpression' &&
      node.callee &&
      node.callee.type === 'MemberExpression' &&
      node.callee.property &&
      node.callee.property.type === 'Identifier' &&
      node.callee.property.name === 'action' &&
      isCommandUpdateExpression(node.callee.object)
    ) {
      const actionHandler = node.arguments[0];
      if (!actionHandler || actionHandler.type !== 'ArrowFunctionExpression' || actionHandler.async !== true) {
        return;
      }

      const handlerParam = actionHandler.params[0];
      if (!handlerParam || handlerParam.type !== 'Identifier') {
        return;
      }

      walk(actionHandler.body, (actionNode) => {
        if (
          actionNode.type !== 'AwaitExpression' ||
          !isUpdateManagerCall(actionNode.argument, 'checkAndPromptUpdates')
        ) {
          return;
        }

        const arg = actionNode.argument.arguments[0];
        if (arg && arg.type === 'Identifier' && arg.name === handlerParam.name) {
          foundAwaitedInteractiveUpdateAction = true;
        }
      });
    }
  });

  assert.equal(
    foundAwaitedInteractiveUpdateAction,
    true,
    'update command action must await updateManager.checkAndPromptUpdates(handlerParam)'
  );
});
