/**
 * Version-sensitive JavaScript tooling data. Every entry records its source and the date it was
 * checked; update both together. Do not add rows from memory.
 */

/**
 * The Hermes compiler (hermesc) that compiles release bundles rejects async arrow functions whose
 * rest parameter is a destructuring pattern (`async (...[a, b]) => {}`) with "invalid destructuring
 * target" (meta/hermes#2260, open). babel-preset-expo stopped transforming the pattern when expo/expo
 * #51687 dropped the Hermes v1 fix-up transforms (merged 2026-10-18, babel-preset-expo 58.0.18 per
 * expo/expo#52983). Workaround from the issue: add @babel/plugin-transform-parameters. Checked
 * 2026-11-05: both issues open.
 */
export const HERMES_ASYNC_REST_DESTRUCTURING = {
  sources: [
    "https://github.com/meta/hermes/issues/2260",
    "https://github.com/expo/expo/issues/52983",
    "https://github.com/expo/expo/pull/51687",
  ],
  lastVerified: "2026-11-05",
  message: "invalid destructuring target",
};

/**
 * npm 11 checks package.json `devEngines` "before install, ci, and run commands"; onFail defaults to
 * error, and a packageManager or runtime name other than npm/node fails within npm (npm docs,
 * package.json > devEngines, v11). eas-cli 27.1.0 runs `npm config get userconfig` at the monorepo
 * root in PREPARE_PROJECT when NPM_TOKEN is set, which fails on a pnpm devEngines.packageManager
 * (expo/eas-cli#4779, open on 2026-11-05; the reporter's builds worked with eas-cli 26.0.0).
 */
export const NPM_DEV_ENGINES = {
  sources: [
    "https://docs.npmjs.com/cli/v11/configuring-npm/package-json#devengines",
    "https://github.com/expo/eas-cli/issues/4779",
  ],
  lastVerified: "2026-11-05",
  easCliRegressionIn: "27.1.0",
};

/**
 * In SDK 55 and later `eas update` requires --environment and uses only the EAS environment's
 * variables, not .env files; a build profile's env in eas.json applies to builds (Expo docs,
 * EAS environment variables > usage and FAQ, checked 2026-11-05).
 */
export const EAS_UPDATE_ENV = {
  sources: [
    "https://docs.expo.dev/eas/environment-variables/usage/",
    "https://docs.expo.dev/eas/environment-variables/faq/",
  ],
  lastVerified: "2026-11-05",
  requiredFromSdk: 55,
};
