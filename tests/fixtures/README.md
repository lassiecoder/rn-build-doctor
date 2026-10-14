# Fixtures

- `logs/real-*`: captured from real builds (`npx expo export`, `./gradlew`, `pod install`, `xcodebuild`) of a project created with `create-expo-app` (Expo SDK 57, React Native 0.86, Gradle 9.3.1, AGP 8.12, Xcode 26.6). The xcodebuild log keeps only the last 1,200 lines of the 53,000-line original. on 2026-10-14. Failures were introduced deliberately. Paths are anonymized to `/Users/dev`. ANSI color codes are kept on purpose to exercise normalization.
- `logs/*` (others): synthetic logs that reproduce the documented or observed format of each error. Tokens in `secrets.log` are fake. The AWS key is AWS's documented example.
- `projects/*`: minimal project layouts. `node_modules` folders inside fixtures contain only `package.json` stubs (and `bundledNativeModules.json` for Expo).

Every fixture referenced by a rule's `meta.fixtures` must exist (enforced by `tests/unit/rules-metadata.test.ts`).
