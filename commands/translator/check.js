// `slice translator check` — the strict gate: every key a template or a `slice.t()` call
// needs must exist in every locale (a missing key ships as the key on screen).
//
// The scan reuses the framework's template rules and the dictionaries the app ships, so
// this command and the browser cannot disagree about what a `data-t` element needs.

import Print from '../Print.js';
import { checkProject } from './scan.js';

export default async function checkCommand(options = {}, projectRoot) {
  try {
    const result = await checkProject(projectRoot, options);

    for (const warning of result.warnings) Print.warning(warning);

    if (result.errors.length) {
      for (const error of result.errors) Print.error(error);
      Print.error(`Translator check failed: ${result.errors.length} problem(s).`);
      process.exitCode = 1;
      return;
    }

    Print.success(
      `Translator OK: ${result.entries.length} key reference(s) across ${result.locales.length} locale(s)` +
      ` (${result.dictionaryCount} dictionaries).`
    );
  } catch (error) {
    Print.error('slice translator check failed:', error.message);
    process.exitCode = 1;
  }
}
