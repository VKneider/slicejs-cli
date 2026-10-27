// Minimal semver range check for the ranges this project actually uses:
// `^`, `~`, exact, `>=`/`<=`/`>`/`<`, `||`, and `*`/`x`/`latest`.
//
// It exists because a published CLI declared `slicejs-web-framework@^3.5.0`
// while shipping a 4.x feature set: installing it gave users a 3.x runtime and
// nothing complained. `release-check` uses it for the CLI, `slice doctor` uses
// it for whatever a project declares.
//
// An unknown comparator returns true on purpose: a form we do not understand is
// not evidence of a mismatch.

const parse = (value) => {
  const match = String(value ?? '').trim().replace(/^[~^<>=v\s]+/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
};

const compare = (a, b) => (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);

export function parseVersion(value) {
  return parse(value);
}

export function satisfies(range, version) {
  const target = parse(version);
  if (!target) return false;

  return String(range).split('||').some((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean);
    if (!comparators.length) return true;

    return comparators.every((comparator) => {
      if (comparator === '*' || comparator === 'x' || comparator === 'latest') return true;

      const operator = (comparator.match(/^(\^|~|>=|<=|>|<|=)?/) || [])[1] || '';
      const base = parse(comparator.slice(operator.length));
      if (!base) return true;

      if (operator === '^') {
        if (target.major !== base.major) return false;
        if (base.major === 0 && target.minor !== base.minor) return false;
        return compare(target, base) >= 0;
      }
      if (operator === '~') {
        return target.major === base.major && target.minor === base.minor && compare(target, base) >= 0;
      }

      const diff = compare(target, base);
      if (operator === '>=') return diff >= 0;
      if (operator === '>') return diff > 0;
      if (operator === '<=') return diff <= 0;
      if (operator === '<') return diff < 0;
      return diff === 0;
    });
  });
}

/**
 * `null` when the range accepts the version or the range is not a plain semver
 * range (git/file/link specs, `workspace:*`), which callers must skip.
 */
export function rangeMismatch(range, version) {
  const spec = String(range ?? '').trim();
  if (!spec || /^(file:|link:|workspace:|git|https?:|npm:)/.test(spec)) return null;
  if (!parse(version)) return null;
  return satisfies(spec, version) ? null : spec;
}
