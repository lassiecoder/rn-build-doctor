import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { findPackageDir, type ProjectContext } from "../../detection/project-type.js";

/** Folders of a package that hold its JavaScript entry points. */
const JS_DIRS = ["build", "lib", "dist", "src"];
const MAX_PACKAGES = 300;
const MAX_FILES_PER_PACKAGE = 400;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_DEPTH = 5;

export interface NativeModuleOwner {
  pkg: string;
  version?: string;
  /** File (relative to the project root) that requests the module. */
  file: string;
  line: number;
  excerpt: string;
}

/**
 * Finds the installed package whose JavaScript requests the native module `name`
 * (`requireNativeModule('X')`, `requireOptionalNativeModule('X')`,
 * `TurboModuleRegistry.get[Enforcing]('X')`). Only packages declared in package.json are searched,
 * within size limits; files are read, never executed.
 */
export function findNativeModuleOwner(
  project: ProjectContext,
  name: string,
): NativeModuleOwner | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const call = new RegExp(
    `(?:requireNativeModule|requireOptionalNativeModule|TurboModuleRegistry\\.get(?:Enforcing)?)\\s*(?:<[^>]*>)?\\(\\s*['"\`]${escaped}['"\`]`,
  );
  for (const pkg of Object.keys(project.declared).sort().slice(0, MAX_PACKAGES)) {
    const dir = findPackageDir(project.root, pkg);
    if (!dir) continue;
    let files = 0;
    const walk = (folder: string, depth: number): NativeModuleOwner | undefined => {
      if (depth > MAX_DEPTH || files >= MAX_FILES_PER_PACKAGE) return undefined;
      let entries;
      try {
        entries = readdirSync(folder, { withFileTypes: true });
      } catch {
        return undefined;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const full = join(folder, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
          const found = walk(full, depth + 1);
          if (found) return found;
          continue;
        }
        if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name) || entry.name.endsWith(".d.ts"))
          continue;
        if (++files > MAX_FILES_PER_PACKAGE) return undefined;
        try {
          if (statSync(full).size > MAX_FILE_BYTES) continue;
          const lines = readFileSync(full, "utf8").split(/\r?\n/);
          const index = lines.findIndex((l) => call.test(l));
          if (index >= 0)
            return {
              pkg,
              ...(project.installedVersion(pkg) ? { version: project.installedVersion(pkg)! } : {}),
              file: relative(project.root, full).replace(/\\/g, "/"),
              line: index + 1,
              excerpt: lines[index]!.trim().slice(0, 200),
            };
        } catch {
          // unreadable files are skipped
        }
      }
      return undefined;
    };
    for (const sub of JS_DIRS) {
      const found = walk(join(dir, sub), 0);
      if (found) return found;
    }
  }
  return undefined;
}
