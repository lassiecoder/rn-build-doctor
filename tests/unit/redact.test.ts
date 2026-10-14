import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runAnalyze } from "../../src/pipeline.js";
import { Redactor } from "../../src/reports/redact.js";
import { toMarkdown } from "../../src/reports/export.js";
import { EMPTY_ENV, NO_PROJECT, logFixture } from "../helpers/fixtures.js";

const SECRETS = [
  "ghp_1234567890abcdefghijklmnopqrstuvwxyzAB",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  "sup3rS3cret!",
  "AKIAIOSFODNN7EXAMPLE",
  "hunter2hunter2",
  "abcdefghijklmnopqrstuvwxyz123456",
  "p4ssw0rd",
];

describe("Redactor", () => {
  const r = new Redactor({ env: EMPTY_ENV, redactHome: false });

  it("redacts known token formats", () => {
    const text = readFileSync(logFixture("secrets.log"), "utf8");
    const out = r.redact(text).text;
    for (const secret of SECRETS) expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED:github-token]");
    expect(out).toContain("Authorization: Bearer [REDACTED:authorization]");
  });

  it("redacts private keys, cookies, and query tokens", () => {
    const text = [
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
      "Cookie: session=abc123def456",
      "GET https://cdn.example.com/a.zip?X-Amz-Signature=deadbeefcafe&x=1",
      '{"apiKey": "live_9f8e7d6c5b4a"}',
      "  password: correcthorsebattery",
    ].join("\n");
    const out = r.redact(text).text;
    expect(out).not.toMatch(
      /MIIEowIBAAKCAQEA|abc123def456|deadbeefcafe|live_9f8e7d6c5b4a|correcthorsebattery/,
    );
    expect(out).toContain("&x=1");
  });

  it("does not damage diagnostic text", () => {
    const text = [
      "> Task :react-native-auth0:compileDebugKotlin FAILED",
      "Could not resolve com.auth0.android:auth0:2.10.2.",
      "SyntaxError: /app/src/a.ts: Unexpected token: '<' (3:4)",
      "storePassword System.getenv('STORE_PASSWORD')",
      "MYAPP_UPLOAD_STORE_PASSWORD=${STORE_PASSWORD}",
      "token: required",
    ].join("\n");
    expect(r.redact(text).text).toBe(text);
  });

  it("redacts values of sensitive environment variables verbatim", () => {
    const redactor = new Redactor({
      env: { SENTRY_AUTH_TOKEN: "sntrys_verysecretvalue123", PATH: "/usr/bin" },
      redactHome: false,
    });
    const out = redactor.redact("uploading with sntrys_verysecretvalue123 from /usr/bin").text;
    expect(out).toBe("uploading with [REDACTED:env-value] from /usr/bin");
  });

  it("replaces the home directory", () => {
    const redactor = new Redactor({ env: EMPTY_ENV, home: "/Users/alice" });
    expect(redactor.redact("at /Users/alice/app/x.ts and /Users/alicex").text).toBe(
      "at ~/app/x.ts and /Users/alicex",
    );
  });

  it("keeps secrets out of exported reports and Markdown", () => {
    const report = runAnalyze([logFixture("secrets.log")], { cwd: NO_PROJECT, env: EMPTY_ENV });
    const json = JSON.stringify(report);
    const md = toMarkdown(report);
    for (const secret of SECRETS) {
      expect(json).not.toContain(secret);
      expect(md).not.toContain(secret);
    }
    expect(report.redaction.applied).toBe(true);
  });
});
