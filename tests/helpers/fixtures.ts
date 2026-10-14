import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
export const logFixture = (name: string) => join(FIXTURES, "logs", name);
export const projectFixture = (name: string) => join(FIXTURES, "projects", name);
/** A directory with no package.json, so log analysis runs without project context. */
export const NO_PROJECT = projectFixture("not-a-project");
/** Deterministic environment for tests: no shell variables, no home directory leakage. */
export const EMPTY_ENV: NodeJS.ProcessEnv = {};
export const FIXED_NOW = new Date("2026-10-14T00:00:00.000Z");
