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
  sourceType: 'module',
  errorRecovery: true,
  loc: true,
  ranges: true
});

function lineOf(node) {
  return node && node.loc && node.loc.start ? node.loc.start.line : null;
}

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

function getRunWithVersionCheckNode() {
  let foundNode = null;

  walk(ast, (node) => {
    if (
      node.type === 'FunctionDeclaration' &&
      node.id &&
      node.id.type === 'Identifier' &&
      node.id.name === 'runWithVersionCheck'
    ) {
      foundNode = node;
      return;
    }

    if (node.type !== 'VariableDeclarator') {
      return;
    }

    if (!node.id || node.id.type !== 'Identifier' || node.id.name !== 'runWithVersionCheck') {
      return;
    }

    if (
      node.init &&
      (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression')
    ) {
      foundNode = node.init;
    }
  });

  return foundNode;
}

function getFunctionBodyNode(fnNode) {
  if (!fnNode) {
    return null;
  }

  if (fnNode.type === 'FunctionDeclaration' || fnNode.type === 'FunctionExpression' || fnNode.type === 'ArrowFunctionExpression') {
    return fnNode.body;
  }

  return null;
}

test('runWithVersionCheck uses non-blocking update notifications', () => {
  const runWithVersionCheckNode = getRunWithVersionCheckNode();
  const runWithVersionCheckBody = getFunctionBodyNode(runWithVersionCheckNode);

  assert.ok(
    runWithVersionCheckNode,
    'runWithVersionCheck function should exist as a declaration or function-valued variable'
  );
  assert.ok(runWithVersionCheckBody, 'runWithVersionCheck should have a traversable function body');

  let hasAwaitedNotifyCall = false;
  let hasPromptCall = false;
  let promptCallLine = null;

  walk(runWithVersionCheckBody, (node) => {
    if (
      node.type === 'AwaitExpression' &&
      isUpdateManagerCall(node.argument, 'notifyAvailableUpdates')
    ) {
      hasAwaitedNotifyCall = true;
    }
    if (isUpdateManagerCall(node, 'checkAndPromptUpdates')) {
      hasPromptCall = true;
      promptCallLine = promptCallLine ?? lineOf(node);
    }
  });

  assert.equal(
    hasAwaitedNotifyCall,
    true,
    `runWithVersionCheck must await updateManager.notifyAvailableUpdates() (related checkAndPromptUpdates at line ${promptCallLine ?? 'unknown'})`
  );
  assert.equal(
    hasPromptCall,
    false,
    `runWithVersionCheck must not call updateManager.checkAndPromptUpdates() (found at line ${promptCallLine ?? 'unknown'})`
  );
});

test('update command remains explicitly interactive', () => {
  let foundAwaitedInteractiveUpdateAction = false;
  let updateActionHandlerLine = null;
  let relatedPromptCallLine = null;

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
      if (
        !actionHandler ||
        actionHandler.async !== true ||
        (actionHandler.type !== 'ArrowFunctionExpression' && actionHandler.type !== 'FunctionExpression')
      ) {
        return;
      }

      updateActionHandlerLine = updateActionHandlerLine ?? lineOf(actionHandler);

      walk(actionHandler.body, (actionNode) => {
        if (isUpdateManagerCall(actionNode, 'checkAndPromptUpdates')) {
          relatedPromptCallLine = relatedPromptCallLine ?? lineOf(actionNode);
        }

        if (
          actionNode.type !== 'AwaitExpression' ||
          !isUpdateManagerCall(actionNode.argument, 'checkAndPromptUpdates')
        ) {
          return;
        }

        foundAwaitedInteractiveUpdateAction = true;
      });
    }
  });

  assert.equal(
    foundAwaitedInteractiveUpdateAction,
    true,
    `update command action must await updateManager.checkAndPromptUpdates(...) (action line ${updateActionHandlerLine ?? 'unknown'}, related call line ${relatedPromptCallLine ?? 'unknown'})`
  );
});
