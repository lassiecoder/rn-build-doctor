import { existsSync } from "node:fs";
import { findLine, readProjectFile } from "../../collectors/project-files.js";
import { finding, type Rule } from "../../engine/rule.js";

/**
 * `export NODE_BINARY=/absolute/path/node` in ios/.xcode.env.local. The file is read as text and
 * never sourced; only an absolute literal path (no `$(...)` or variables) is checked.
 */
const PINNED_NODE = /^\s*export\s+NODE_BINARY=(["']?)(\/[^"'$`\s]+)\1\s*$/;

export const xcodeEnvStaleNode: Rule = {
  meta: {
    id: "ios.xcode-env-stale-node",
    title: "ios/.xcode.env.local points NODE_BINARY at a node that doesn't exist",
    platforms: ["ios"],
    scope: "project",
    trigger:
      "ios/.xcode.env.local sets NODE_BINARY to an absolute path (a literal, not $(command -v node)) and no file exists at that path.",
    evidence: "The NODE_BINARY line in ios/.xcode.env.local.",
    versionScope: "React Native 0.69+ (.xcode.env.local)",
    references: [
      "https://github.com/react/react-native/issues/59538",
      "https://github.com/react/react-native/blob/main/packages/react-native/scripts/xcode/with-environment.sh",
    ],
    lastVerified: "2026-11-05",
    fixtures: ["projects/rn088-stale-xcode-env"],
  },
  run({ project }) {
    if (!project?.hasIos) return [];
    const local = readProjectFile(project.root, "ios/.xcode.env.local");
    if (!local.ok) return [];
    const line = findLine(local.text, PINNED_NODE);
    if (!line) return [];
    const path = PINNED_NODE.exec(line.excerpt)![2]!;
    // The scan may run on a different machine than the one that wrote the file (a committed file).
    if (existsSync(path)) return [];
    return [
      finding(this.meta, {
        title: `ios/.xcode.env.local pins NODE_BINARY to ${path}, which doesn't exist`,
        severity: "warning",
        confidence: "high",
        explanation:
          "Xcode's React Native script phases source ios/.xcode.env and then ios/.xcode.env.local, so the path in .xcode.env.local wins. `pod install` writes it once with the node it ran under and never updates it, so after a node version manager removes that version every iOS build fails in the first script phase that runs node. The file is checked on this machine; if it was committed from another one, the path may only exist there.",
        evidence: [
          {
            source: "project",
            file: "ios/.xcode.env.local",
            line: line.line,
            excerpt: line.excerpt,
          },
        ],
        nextSteps: [
          "With the node version you want active, delete ios/.xcode.env.local (or set NODE_BINARY to the output of `command -v node`), then run `cd ios && pod install`.",
          "Keep ios/.xcode.env.local out of git (it's machine-specific).",
        ],
        verification:
          "The path NODE_BINARY names in ios/.xcode.env.local exists, and the iOS build passes its script phases.",
      }),
    ];
  },
};

export const iosProjectRules: Rule[] = [xcodeEnvStaleNode];
