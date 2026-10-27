// Lifecycle conventions that are statically visible in a component file. All
// three are advisories: the app still runs, but the cleanup is not what the
// author thinks it is.

import { parse } from '@babel/parser';
import traverse from '@babel/traverse';

const DEAD_TEARDOWN_NAMES = new Set(['destroy', 'dispose', 'teardown']);

/**
 * @returns {{
 *   asyncBeforeDestroy: boolean,
 *   deadTeardown: string|null,
 *   globalListener: number|null
 * }}
 */
export function auditComponentLifecycle(source) {
  let ast;
  try {
    ast = parse(source, { sourceType: 'module', plugins: ['classProperties'] });
  } catch {
    return { asyncBeforeDestroy: false, deadTeardown: null, globalListener: null };
  }

  let extendsHTMLElement = false;
  let beforeDestroy = null;
  const methods = [];
  let addsWithoutOptions = 0;
  let removes = 0;

  const visit = typeof traverse === 'function' ? traverse : traverse.default;

  visit(ast, {
    Class(path) {
      if (path.node.superClass?.name === 'HTMLElement') extendsHTMLElement = true;
    },
    ClassMethod(path) {
      const name = path.node.key?.name;
      if (!name) return;
      methods.push({ name, params: path.node.params.length });
      if (name === 'beforeDestroy') beforeDestroy = path.node;
    },
    CallExpression(path) {
      const callee = path.node.callee;
      if (callee?.type !== 'MemberExpression' || callee.computed) return;
      const property = callee.property?.name;
      const receiver = callee.object?.name;

      if (property === 'removeEventListener') {
        removes += 1;
        return;
      }

      if (property !== 'addEventListener') return;
      if (receiver !== 'window' && receiver !== 'document') return;

      // `{ once: true }` and `{ signal }` clean themselves up.
      const options = path.node.arguments?.[2];
      if (options?.type !== 'ObjectExpression') addsWithoutOptions += 1;
    }
  });

  if (!extendsHTMLElement) {
    return { asyncBeforeDestroy: false, deadTeardown: null, globalListener: null };
  }

  const dead = methods.find((method) => DEAD_TEARDOWN_NAMES.has(method.name) && method.params === 0);

  return {
    asyncBeforeDestroy: Boolean(beforeDestroy?.async),
    deadTeardown: dead && !beforeDestroy ? dead.name : null,
    globalListener: addsWithoutOptions > 0 && removes === 0 ? addsWithoutOptions : null
  };
}
