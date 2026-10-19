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
