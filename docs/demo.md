# Demo: "works in development, crashes in production"

This walkthrough reproduces a common Expo failure. The production build crashes on launch because a public API URL exists only in a git-ignored `.env` file, which EAS Build never receives.

**What is real and what is simulated:** the project files and the analysis are real and run locally. The production crash log in `tests/fixtures/logs/runtime-missing-supabase-url.log` is a _synthetic_ logcat capture that reproduces the format and message of this failure (`Error: supabaseUrl is required.` from `@supabase/supabase-js`). For a fully live demo, replace it with `adb logcat` output from your own EAS production build.

## 1. The project

`tests/fixtures/projects/expo-env-missing-in-eas` contains:

- `lib/supabase.ts` reads `process.env.EXPO_PUBLIC_SUPABASE_URL`
- `env.fixture` defines it (placeholder values; it becomes `.env` when copied, see below), and `.gitignore` ignores `.env`
- the `eas.json` `production` profile defines only `EXPO_PUBLIC_SUPABASE_ANON_KEY`

Locally, `npx expo start` reads `.env`, so everything works.

## 2. Scan the project

```sh
cp -R tests/fixtures/projects/expo-env-missing-in-eas /tmp/envdemo && cd /tmp/envdemo
mv env.fixture .env   # stored under another name so the repo never contains a .env file
npx rn-build-doctor scan
```

Expected finding (medium confidence, because EAS environment variables can't be read locally):

```text
WARN  F4 EXPO_PUBLIC_SUPABASE_URL is defined only in .env, which EAS Build doesn't receive
      expo.env-file-not-available-in-eas · confidence medium · expo
```

The finding includes evidence (the reference in `lib/supabase.ts:3`, the `.env` definition with its value not read, the `.gitignore` rule, and the `eas.json` profile), plus how to verify with `eas env:list --environment production`.

## 3. Analyze the crash log

```sh
cp <repo>/tests/fixtures/logs/runtime-missing-supabase-url.log crash.log
npx rn-build-doctor analyze crash.log
```

You get three findings: the JavaScript exception, the Android fatal exception it caused, and `runtime.missing-configuration-suspected`. The last one is a hypothesis, explicitly labeled as such, that links the error message to missing configuration.

## 4. Share the combined report

```sh
npx rn-build-doctor report --output report.md
```

## 5. Fix and verify

```sh
eas env:set --name EXPO_PUBLIC_SUPABASE_URL --value https://<project>.supabase.co --environment production --visibility plaintext
eas env:list --environment production   # verify
eas build --profile production           # EXPO_PUBLIC_ values are inlined at build time
```

After the variable is set (or added to the profile's `env`), re-running `scan` no longer reports it as missing from the `production` profile when it's in `eas.json`. A variable set only in EAS stays outside what a local scan can see, and the finding says so.
