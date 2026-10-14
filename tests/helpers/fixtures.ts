import { cpSync, existsSync, mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
export const logFixture = (name: string) => join(FIXTURES, "logs", name);

/**
 * Fixture projects can't commit a file named .env (their own .gitignore hides it, and it looks like
 * a leaked secret). They commit `env.fixture` instead; such projects are copied to a temporary
 * directory once per test process with the file renamed to .env.
 */
const ENV_FIXTURE = "env.fixture";
const materialized = new Map<string, string>();

export function projectFixture(name: string): string {
  const source = join(FIXTURES, "projects", name);
  if (!existsSync(join(source, ENV_FIXTURE))) return source;
  let dir = materialized.get(name);
  if (!dir) {
    dir = join(mkdtempSync(join(tmpdir(), "rnbd-fixture-")), name);
    cpSync(source, dir, { recursive: true });
    renameSync(join(dir, ENV_FIXTURE), join(dir, ".env"));
    materialized.set(name, dir);
  }
  return dir;
}

/** A directory with no package.json, so log analysis runs without project context. */
export const NO_PROJECT = projectFixture("not-a-project");
/** Deterministic environment for tests: no shell variables, no home directory leakage. */
export const EMPTY_ENV: NodeJS.ProcessEnv = {};
export const FIXED_NOW = new Date("2026-10-14T00:00:00.000Z");
