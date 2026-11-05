/**
 * Version-sensitive iOS data. Every entry records its source and the date it was checked; update
 * both together. Do not add rows from memory.
 */

/**
 * React Native 0.87 ships its iOS headers in header-only XCFrameworks, so a React Native header
 * imported without its namespace no longer resolves. Observed on 2026-10-20 with React Native 0.87.0
 * (prebuilt core), Xcode 26.6, and a pod in node_modules: both `#import "RCTBridge.h"` and
 * `#import <RCTBridge.h>` fail with "'RCTBridge.h' file not found", and `#import <React/RCTBridge.h>`
 * compiles.
 */
export const RN_NAMESPACED_HEADERS = {
  source: "https://reactnative.dev/blog/2026/08/11/react-native-0.87#headers-breaking-changes",
  lastVerified: "2026-10-20",
  minReactNative: "0.87.0",
  namespace: "React",
};

/**
 * expo-modules-autolinking's precompiled-modules hook broke React header lookup for pods built as
 * frameworks (`useFrameworks`), surfacing as "'React/RCTBridge.h' file not found (in target
 * 'EXUpdates' from project 'Pods')" or "'React/RCTSurfaceTouchHandler.h' file not found" in @expo/ui.
 * Two bugs: a dynamic-framework linkage guard (fixed by #48869) and corrupted HEADER_SEARCH_PATHS
 * (fixed by #48665). Checked on 2026-10-25 by inspecting the published
 * scripts/ios/precompiled_modules.rb: the guard is in 57.0.9 and 56.0.21 and gone in 57.0.10 and
 * 56.0.22; the search-path fix is in 57.0.10+ and 58.x but in no 56.x release up to 56.0.24.
 */
export const EXPO_AUTOLINKING_FRAMEWORK_HEADERS = {
  sources: [
    "https://github.com/expo/expo/issues/48781",
    "https://github.com/expo/expo/issues/48664",
    "https://github.com/expo/expo/pull/48869",
    "https://github.com/expo/expo/pull/48665",
  ],
  lastVerified: "2026-10-25",
  /** First release with both fixes, per SDK major. */
  fixedIn: { 57: "57.0.10" } as Record<number, string>,
  /** SDK majors where only the linkage-guard fix shipped, and from which release. */
  partialFixIn: { 56: "56.0.22" } as Record<number, string>,
  checkedThrough: { 56: "56.0.24" } as Record<number, string>,
};

/**
 * Xcode 27 replaces Simulator.app with DeviceHub.app (com.apple.dt.Devices), so tools that look up
 * the "Simulator" app fail with "Can't determine id of Simulator app". Checked on 2026-10-25:
 * @expo/cli 56.1.27, 57.0.32 and 58.1.15 contain DeviceHub support (expo/expo#46757); 54.0.28 and
 * 55.0.37 (the latest of those lines) don't. EAS CLI fixed it in 24.4.2 (expo/eas-cli#4403).
 */
export const XCODE27_DEVICEHUB = {
  sources: [
    "https://github.com/expo/expo/pull/46757",
    "https://github.com/expo/eas-cli/issues/4403",
    "https://github.com/expo/expo/issues/52063",
  ],
  lastVerified: "2026-10-25",
  expoCliFirstSupportedMajor: 56,
  easCliFixedIn: "24.4.2",
};

/**
 * Under Xcode 27, the "[CP-User] Build ExpoModulesJSI xcframework" phase fails archives with
 * "error: the following command failed with exit code 0 but produced no further output" although
 * the nested build succeeds. Fixed by expo/expo#50587; checked on 2026-10-25 that the fix's
 * changelog entry is in expo-modules-jsi 58.0.4+ and not in 57.1.1 or 57.1.2.
 */
export const EXPO_JSI_XCODE27_ARCHIVE = {
  sources: ["https://github.com/expo/expo/issues/50482", "https://github.com/expo/expo/pull/50587"],
  lastVerified: "2026-10-25",
  fixedIn: "58.0.4",
  notFixedThrough57: "57.1.2",
};

/**
 * Precompiled ExpoModulesCore in expo 58.0.8 imports _swift_allocateMetadataPack and
 * _swift_allocateWitnessTablePack from an ExpoModulesJSI that, built with Xcode 27, doesn't export
 * them, so dyld stops the app at launch (expo/expo#51454). Maintainer: fixed by expo/expo#51463;
 * update to expo 58.0.9 and run `npx expo install --fix`.
 */
export const EXPO_SWIFT_PACK_SYMBOLS = {
  sources: ["https://github.com/expo/expo/issues/51454", "https://github.com/expo/expo/pull/51463"],
  lastVerified: "2026-10-25",
  symbols: ["_swift_allocateMetadataPack", "_swift_allocateWitnessTablePack"],
  fixedInExpo: "58.0.9",
};

/**
 * Apps built with the iOS 27 SDK (Xcode 27) must adopt the UIScene life cycle or they fail to
 * launch. React Native 0.88's template and Expo SDK 58's prebuild adopt it; SDK 57 has an opt-in
 * `ios.enableSceneSupport` flag in expo-build-properties. Checked on 2026-10-25.
 */
export const IOS27_UISCENE = {
  sources: [
    "https://reactnative.dev/blog/2026/10/19/react-native-0.88",
    "https://expo.dev/changelog/sdk-58",
    "https://github.com/expo/fyi/blob/main/ios-scene-lifecycle.md",
  ],
  lastVerified: "2026-10-25",
  minReactNative: "0.88.0",
  minExpoSdk: 58,
};

/**
 * Minimum Xcode per Expo SDK ("Support for Android and iOS versions" table, checked on 2026-10-25).
 * Older Xcode versions fail to compile Expo's Swift sources (for example expo-modules-jsi's
 * "type of expression is ambiguous" on Xcode 26.3; expo/expo#48802: "sdk 57 requires xcode 26.4+").
 */
export const EXPO_SDK_MIN_XCODE = {
  sources: ["https://docs.expo.dev/versions/latest/", "https://github.com/expo/expo/issues/48802"],
  lastVerified: "2026-10-25",
  table: { 56: "26.4", 57: "26.4", 58: "26.4" } as Record<number, string>,
};

/**
 * With Xcode 27.2 (macOS 27.2), AppleScript's `id of app "Simulator"` returns com.apple.dt.Xcode, so
 * @expo/cli's lookup (Simulator first, DeviceHub second) stops with "Device Hub or Simulator is
 * installed but is identified as 'com.apple.dt.Xcode'". Reported with @expo/cli 58.1.18
 * (expo/expo#52721, closed for a missing reproduction without a fix; no fix PR found on 2026-11-05).
 */
export const XCODE272_SIMULATOR_ID = {
  sources: ["https://github.com/expo/expo/issues/52721"],
  lastVerified: "2026-11-05",
  reportedWithExpoCli: "58.1.18",
};
