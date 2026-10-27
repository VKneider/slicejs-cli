// Component CSS is loaded globally: a selector that does not start with the
// component's own tag leaks into every page that uses the bundle. The framework
// documents this as a convention (component-styles.md), and it is the one class
// of invariant neither ESLint (no CSS) nor `slice build` ever looked at.
//
// Advisory, not a blocker: a `.about` class is ugly but harmless, and portaled
// widgets legitimately style nodes they append to <body>. `/* slice:unscoped */`
// opts a file out when that is deliberate.

/** The tag a component registers, or null for JS-only components. */
export function componentTagFromSource(source) {
  const match = String(source).match(/customElements\.define\(\s*['"]([^'"]+)['"]/);
  return match ? match[1] : null;
}

const AT_RULE_WITH_RULES = /^@(media|supports|layer|container|document)\b/i;

/**
 * Top-level selectors that are not scoped under `tag` (or `:host`).
 * At-rules that contain rules are walked; `@keyframes`/`@font-face` are skipped.
 */
export function findUnscopedSelectors(css, tag) {
  const source = String(css);
  if (/\/\*[\s\S]*?slice:unscoped[\s\S]*?\*\//.test(source)) return [];
  if (!tag) return [];

  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const unscoped = [];

  const isScoped = (selector) => {
    const first = selector.split(',')[0].trim();
    return first.startsWith(tag) || first.startsWith(':host');
  };

  const walk = (text) => {
    let index = 0;
    let selectorStart = 0;

    while (index < text.length) {
      const char = text[index];

      if (char === '{') {
        const selector = text.slice(selectorStart, index).trim();
        const close = findClosingBrace(text, index);
        const body = text.slice(index + 1, close);

        if (selector.startsWith('@')) {
          if (AT_RULE_WITH_RULES.test(selector)) walk(body);
          // @keyframes / @font-face / @page: nothing to check inside
        } else if (selector && !isScoped(selector)) {
          unscoped.push(selector.replace(/\s+/g, ' '));
        }

        index = close + 1;
        selectorStart = index;
        continue;
      }

      if (char === '}') {
        index += 1;
        selectorStart = index;
        continue;
      }

      index += 1;
    }
  };

  walk(clean);
  return unscoped;
}

function findClosingBrace(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length; // unbalanced CSS: treat the rest as the body
}
