import { readJsonFile } from "../../collectors/project-files.js";
import { finding, type Rule } from "../../engine/rule.js";
import { logEvidence } from "../../parsers/types.js";
import type { DraftFinding, Evidence } from "../../reports/schema.js";

/**
 * Frozen-lockfile failures of each package manager. Messages reproduced on 2026-10-25 with npm
 * 11.6.2, Yarn 1.22.22, pnpm 10.24.0 and Bun 1.4.3 by adding a dependency to package.json without
 * updating the lockfile.
 */
const LOCKFILE_FAILURES: {
  manager: string;
  lockfile: string;
  pattern: RegExp;
  install: string;
}[] = [
  {
    manager: "npm",
    lockfile: "package-lock.json",
    pattern:
      /`npm ci` can only install packages when your package\.json and package-lock\.json(?: or npm-shrinkwrap\.json)? are in sync/,
    install: "npm install",
  },
  {
    manager: "Yarn",
    lockfile: "yarn.lock",
    pattern: /Your lockfile needs to be updated, but yarn was run with `--frozen-lockfile`/,
    install: "yarn install",
  },
  {
    manager: "pnpm",
    lockfile: "pnpm-lock.yaml",
    pattern:
      /ERR_PNPM_OUTDATED_LOCKFILE|Cannot install with "frozen-lockfile" because pnpm-lock\.yaml is not up to date/,
    install: "pnpm install",
  },
  {
    manager: "Bun",
    lockfile: "bun.lock",
    // Older Bun versions write bun.lockb; the message is the same.
    pattern: /lockfile had changes, but lockfile is frozen/,
    install: "bun install",
  },
];

/** Package names the package manager says are missing or different ("Missing: b@2.0.0 from lock file"). */
const NPM_DETAIL = /^(?:npm (?:error|ERR!)\s+)?(Missing|Invalid): (.+?)\s*$/;
const PNPM_DETAIL = /^\*\s+\d+ dependenc(?:y was|ies were) (added|removed|updated|changed): (.+)$/;

interface NpmLock {
  packages?: Record<
    string,
    { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  >;
}

export const lockfileOutOfSync: Rule = {
  meta: {
    id: "javascript.lockfile-out-of-sync",
    title: "The lockfile doesn't match package.json",
    platforms: ["javascript"],
    scope: "log",
    trigger:
      "A frozen-lockfile install failure: npm ci's 'can only install packages when your package.json and package-lock.json … are in sync', Yarn 1's 'Your lockfile needs to be updated, but yarn was run with `--frozen-lockfile`', pnpm's ERR_PNPM_OUTDATED_LOCKFILE, or Bun's 'lockfile had changes, but lockfile is frozen'.",
    evidence:
      "The failure line and the packages the package manager lists as missing or changed; with the project, the lockfiles present and, for package-lock.json, the dependencies declared in package.json but missing from the lockfile.",
    versionScope:
      "npm 7+, Yarn 1, pnpm 8+, Bun 1.2+ (messages checked with npm 11.6, Yarn 1.22, pnpm 10.24, Bun 1.4)",
    references: [
      "https://docs.npmjs.com/cli/commands/npm-ci",
      "https://classic.yarnpkg.com/en/docs/cli/install#toc-yarn-install-frozen-lockfile",
      "https://pnpm.io/cli/install#--frozen-lockfile",
      "https://bun.sh/docs/cli/install",
    ],
    lastVerified: "2026-10-25",
    fixtures: [
      "logs/real-npm11-ci-out-of-sync.log",
      "logs/real-yarn1-frozen-lockfile.log",
      "logs/real-pnpm10-outdated-lockfile.log",
      "logs/real-bun14-frozen-lockfile.log",
    ],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const lines = log.doc.lines;
      for (const failure of LOCKFILE_FAILURES) {
        const index = lines.findIndex((l) => failure.pattern.test(l));
        if (index < 0) continue;
        const details: string[] = [];
        for (let i = index; i < Math.min(lines.length, index + 30) && details.length < 10; i++) {
          const m = NPM_DETAIL.exec(lines[i]!.trim()) ?? PNPM_DETAIL.exec(lines[i]!.trim());
          if (m && !details.includes(`${m[1]}: ${m[2]}`)) details.push(`${m[1]}: ${m[2]}`);
        }
        const evidence: Evidence[] = [logEvidence(log.doc, { start: index, end: index + 1 })];
        for (const d of details) evidence.push({ source: "log", file: log.doc.path, detail: d });

        const project = ctx.project;
        const lockfiles = project?.lockfiles ?? [];
        if (project) {
          evidence.push({
            source: "project",
            detail: lockfiles.length
              ? `Lockfiles in the project: ${lockfiles.join(", ")}`
              : "No lockfile found in the project directory",
          });
          if (failure.lockfile === "package-lock.json" && lockfiles.includes("package-lock.json")) {
            const lock = readJsonFile<NpmLock>(project.root, "package-lock.json");
            const root = lock.ok ? lock.value.packages?.[""] : undefined;
            if (root) {
              const locked = { ...root.dependencies, ...root.devDependencies };
              const missing = Object.keys(project.declared).filter((name) => !(name in locked));
              if (missing.length)
                evidence.push({
                  source: "project",
                  file: "package-lock.json",
                  detail: `Declared in package.json but not in package-lock.json: ${missing.slice(0, 8).join(", ")}`,
                });
            }
          }
        }
        const otherLockfiles = lockfiles.filter((f) => f !== failure.lockfile);
        out.push(
          finding(this.meta, {
            title: `${failure.manager} refused to install: ${failure.lockfile} is out of date with package.json`,
            severity: "error",
            confidence: "high",
            explanation:
              `The install ran with a frozen lockfile (\`npm ci\` always does; pnpm does by default in CI; Yarn and Bun do with \`--frozen-lockfile\`), and package.json asks for dependencies that ${failure.lockfile} doesn't record${details.length ? ` (${details.slice(0, 3).join("; ")})` : ""}. This usually means package.json was changed, for example by an upgrade or \`npx expo install\`, without committing the updated lockfile.` +
              (otherLockfiles.length
                ? ` The project also has ${otherLockfiles.join(", ")}; when several lockfiles exist, the build machine may pick a different package manager than the one you use locally.`
                : ""),
            evidence,
            nextSteps: [
              `Run \`${failure.install}\` locally with the same package manager${failure.manager === "npm" ? " and major version" : ""} as the build machine, then commit the updated ${failure.lockfile}.`,
              ...(otherLockfiles.length
                ? [
                    `Delete the lockfiles you don't use (${otherLockfiles.join(", ")}) so every machine uses ${failure.manager}.`,
                  ]
                : []),
              "If it works locally but fails on CI or EAS, check that the lockfile is committed and not excluded (.gitignore, .easignore), and that a monorepo installs from the folder that holds the lockfile.",
            ],
            verification: `The frozen install (\`${failure.manager === "npm" ? "npm ci" : `${failure.install} --frozen-lockfile`}\`) succeeds locally.`,
          }),
        );
        break;
      }
    }
    return out;
  },
};

export const installRules: Rule[] = [lockfileOutOfSync];
