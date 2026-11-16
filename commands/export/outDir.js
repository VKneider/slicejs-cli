// commands/export/outDir.js
import fs from 'fs-extra';
import path from 'path';

const PROTECTED_OUT_DIRS = new Set([
  'src',
  'dist',
  'api',
  'node_modules',
  '.git',
  'public',
  'locales',
  'components',
  'app',
  'bundles',
  'slice'
]);

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function nearestExistingAncestor(target) {
  let current = target;
  while (!await fs.pathExists(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/**
 * `slice export --out` runs `fs.remove()` on the target. Validate it before any
 * write, so a typo like `--out .` or `--out src` cannot delete the project.
 */
export async function resolveSafeOutDir(projectRoot, outOption) {
  const requested = outOption == null || outOption === '' ? 'dist-static' : String(outOption);
  const outDir = path.resolve(projectRoot, requested);
  const relative = path.relative(projectRoot, outDir);

  if (relative === '') {
    throw new Error('Refusing to export into the project root. Use a dedicated folder such as dist-static.');
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to export outside the project: ${outDir}`);
  }
  if (isInside(outDir, projectRoot)) {
    throw new Error(`Refusing to export into an ancestor of the project: ${outDir}`);
  }

  const topLevel = relative.split(path.sep)[0];
  if (PROTECTED_OUT_DIRS.has(topLevel.toLowerCase())) {
    throw new Error(
      `Refusing to export into ${topLevel}/: it holds source, build or runtime files. Use a dedicated folder such as dist-static.`
    );
  }

  if (await fs.pathExists(outDir)) {
    const stat = await fs.lstat(outDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing to overwrite ${outDir}: the output path is not a directory.`);
    }

    // Existing folders are only overwritten when they look like a previous
    // export. This protects `docs/`, `tests/`, `.github/` and any other real
    // project folder from a mistyped `--out`.
    const markers = await Promise.all([
      fs.pathExists(path.join(outDir, 'index.html')),
      fs.pathExists(path.join(outDir, 'bundles', 'bundle.config.json')),
      fs.pathExists(path.join(outDir, 'slice-env.json'))
    ]);
    if (!markers.some(Boolean)) {
      throw new Error(
        `Refusing to overwrite ${outDir}: it exists but does not look like a previous export. Remove it or choose a new --out folder.`
      );
    }
  }

  // A parent folder can be a symlink that points outside the project even when
  // the textual path is inside it. Resolve the nearest existing ancestor before
  // allowing `fs.remove()` to run.
  const realProject = await fs.realpath(projectRoot);
  const realExisting = await fs.realpath(await nearestExistingAncestor(outDir));
  if (!isInside(realProject, realExisting)) {
    throw new Error(`Refusing to export through a symlink that leaves the project: ${outDir}`);
  }

  return outDir;
}
