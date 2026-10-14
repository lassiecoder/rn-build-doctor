/** An error caused by user input (missing file, invalid report, bad option). Exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

export const EXIT = {
  ok: 0,
  findings: 1,
  usage: 2,
  internal: 3,
} as const;
