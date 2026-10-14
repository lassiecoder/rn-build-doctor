import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allRuleMeta } from "../../src/engine/registry.js";
import { FIXTURES } from "../helpers/fixtures.js";

const CATALOG = readFileSync(new URL("../../docs/supported-checks.md", import.meta.url), "utf8");

describe("rule catalog", () => {
  const rules = allRuleMeta();

  it("has unique, well-formed ids", () => {
    const ids = rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+(\.[a-z0-9-]+)+$/);
  });

  for (const rule of rules) {
    it(`${rule.id} has complete metadata, fixtures, and documentation`, () => {
      expect(rule.title.length).toBeGreaterThan(5);
      expect(rule.trigger.length).toBeGreaterThan(10);
      expect(rule.evidence.length).toBeGreaterThan(5);
      expect(rule.versionScope.length).toBeGreaterThan(0);
      expect(rule.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(rule.fixtures.length).toBeGreaterThan(0);
      for (const f of rule.fixtures) expect(existsSync(join(FIXTURES, f)), f).toBe(true);
      if (!rule.id.startsWith("common.no-") && rule.id !== "common.project-not-detected") {
        expect(rule.references.length, "diagnostic rules cite a source").toBeGreaterThan(0);
      }
      for (const ref of rule.references) expect(ref).toMatch(/^https:\/\//);
      expect(CATALOG, "documented in docs/supported-checks.md").toContain(`\`${rule.id}\``);
    });
  }
});
