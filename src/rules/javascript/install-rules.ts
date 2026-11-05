import { readJsonFile, readProjectFile } from "../../collectors/project-files.js";
import { finding, type Rule } from "../../engine/rule.js";
import { NPM_DEV_ENGINES } from "./compat.js";
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
    {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    }
  >;
}

/**
 * The project's legacy-peer-deps setting from .npmrc. Only that key is read: .npmrc files can hold
 * registry tokens, so no other line is kept.
 */
function npmrcLegacyPeerDeps(root: string): string | undefined {
  const npmrc = readProjectFile(root, ".npmrc");
  if (!npmrc.ok) return undefined;
  for (const line of npmrc.text.split(/\r?\n/)) {
    const m = /^\s*legacy-peer-deps\s*=\s*(true|false)\s*$/i.exec(line);
    if (m) return m[1]!.toLowerCase();
  }
  return undefined;
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
      "https://docs.npmjs.com/cli/v11/using-npm/config#legacy-peer-deps",
    ],
    lastVerified: "2026-11-05",
    fixtures: [
      "logs/real-npm11-ci-out-of-sync.log",
      "logs/real-yarn1-frozen-lockfile.log",
      "logs/real-pnpm10-outdated-lockfile.log",
      "logs/real-bun14-frozen-lockfile.log",
      "logs/npm-ci-missing-peer-dep.log",
      "projects/npm-peer-deps-lockfile",
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
        let peerNote = "";
        let peerSteps: string[] = [];
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
            // Missing entries that another locked package lists as a peer dependency.
            const missingNames = details
              .filter((d) => d.startsWith("Missing: "))
              .map((d) => /^Missing: ((?:@[^@\s/]+\/)?[^@\s]+)/.exec(d)?.[1])
              .filter((n): n is string => !!n);
            const peerOf = new Map<string, string>();
            for (const [path, entry] of Object.entries(
              lock.ok ? (lock.value.packages ?? {}) : {},
            )) {
              for (const name of missingNames)
                if (entry.peerDependencies?.[name] && !peerOf.has(name))
                  peerOf.set(name, path.replace(/^.*node_modules\//, ""));
            }
            if (peerOf.size) {
              const legacy = npmrcLegacyPeerDeps(project.root);
              evidence.push({
                source: "project",
                file: "package-lock.json",
                detail: `Peer dependencies: ${[...peerOf].map(([n, p]) => `${n} (peer of ${p})`).join(", ")}`,
              });
              evidence.push({
                source: "project",
                file: ".npmrc",
                detail:
                  legacy === undefined
                    ? "The project has no .npmrc setting for legacy-peer-deps"
                    : `legacy-peer-deps=${legacy}`,
              });
              peerNote =
                ` ${[...peerOf.keys()].join(", ")} ${peerOf.size === 1 ? "is a peer dependency" : "are peer dependencies"} of locked packages. A lockfile written with \`npm install --legacy-peer-deps\` (from a flag, a user-level ~/.npmrc, or an npm_config_legacy_peer_deps variable) leaves peer dependencies out, and \`npm ci\` without the same setting then finds them missing; npm's docs say the flags used to create the lockfile must also be given to \`npm ci\`.` +
                (legacy === "true"
                  ? " This project's .npmrc sets legacy-peer-deps=true, so check that the machine that failed uses it (the file is committed and the install runs in this folder)."
                  : "");
              peerSteps = [
                legacy === "true"
                  ? "Commit the project's .npmrc so CI and EAS use legacy-peer-deps too, or remove the setting and regenerate the lockfile with a plain `npm install`."
                  : "Either regenerate the lockfile without legacy-peer-deps (`npm install` with no flag and no user-level setting) so peers are recorded, or, if you need legacy-peer-deps, set it for the project with `npm config set legacy-peer-deps=true --location=project` and commit .npmrc so `npm ci` uses it too.",
              ];
            }
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
                : "") +
              peerNote,
            evidence,
            nextSteps: [
              ...peerSteps,
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

const DEV_ENGINES = /EBADDEVENGINES\s+(.+?)\s*$/;

export const devEnginesMismatch: Rule = {
  meta: {
    id: "javascript.dev-engines-mismatch",
    title: "npm refused to run because package.json devEngines doesn't match",
    platforms: ["javascript"],
    scope: "log",
    trigger: "npm output 'npm error EBADDEVENGINES <reason>'.",
    evidence:
      "The EBADDEVENGINES line, whether the log shows EAS Build, and with the project, the devEngines field of package.json.",
    versionScope: "npm 11 (devEngines); EAS Build PREPARE_PROJECT since eas-cli 27.1.0",
    references: NPM_DEV_ENGINES.sources,
    lastVerified: NPM_DEV_ENGINES.lastVerified,
    fixtures: ["logs/eas-issue-npm-ebaddevengines.log"],
  },
  run(ctx) {
    const out: DraftFinding[] = [];
    for (const log of ctx.logs) {
      const index = log.doc.lines.findIndex((l) => DEV_ENGINES.test(l));
      if (index < 0) continue;
      const reason = DEV_ENGINES.exec(log.doc.lines[index]!)![1]!;
      const declared = /Invalid name "([^"]+)" does not match "([^"]+)" for "(\w+)"/.exec(reason);
      const eas = log.doc.lines.some((l) =>
        /PREPARE_PROJECT|NPM_TOKEN environment variable|eas-build/.test(l),
      );
      const evidence: Evidence[] = [logEvidence(log.doc, { start: index, end: index })];
      const pkg = ctx.project?.packageJsonText;
      const at = pkg ? pkg.split(/\r?\n/).findIndex((l) => /"devEngines"\s*:/.test(l)) : -1;
      if (pkg && at >= 0)
        evidence.push({
          source: "project",
          file: "package.json",
          line: at + 1,
          detail: "devEngines is declared",
        });
      out.push(
        finding(this.meta, {
          title: declared
            ? `package.json devEngines asks for ${declared[1]}, but ${declared[2]} ran`
            : `npm stopped on devEngines: ${reason.slice(0, 100)}`,
          severity: "error",
          confidence: "high",
          explanation:
            `npm checks package.json devEngines before install, ci and run commands, and stops when the tool or runtime doesn't match (onFail defaults to "error"). ${declared ? `This project declares ${declared[3]} "${declared[1]}", and the command was run by ${declared[2]}.` : reason}` +
            (eas
              ? ` On EAS Build this happens in PREPARE_PROJECT since eas-cli ${NPM_DEV_ENGINES.easCliRegressionIn}: with NPM_TOKEN set, EAS runs \`npm config get userconfig\` at the project root even when the project uses another package manager (expo/eas-cli#4779).`
              : ""),
          evidence,
          nextSteps: eas
            ? [
                'Set "onFail": "warn" on devEngines.packageManager in the root package.json so npm only warns; this is the workaround from expo/eas-cli#4779. Pinning an older eas-cli locally doesn\'t help, because the build worker runs its own build tools.',
                "Remove the workaround once expo/eas-cli#4779 is fixed.",
              ]
            : [
                declared
                  ? `Run the command with ${declared[1]} (for example \`${declared[1]} install\`), not ${declared[2]}.`
                  : "Run the command with the tool and runtime versions package.json declares in devEngines.",
                'If a tool has to run npm in this folder (a CI step or script), set "onFail": "warn" for that devEngines entry.',
              ],
          verification: "The command runs without EBADDEVENGINES.",
        }),
      );
    }
    return out;
  },
};

export const installRules: Rule[] = [lockfileOutOfSync, devEnginesMismatch];
