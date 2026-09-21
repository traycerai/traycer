// Test-only N-API addon for reload-focus-diagnostic.cjs (macOS). Never
// packaged. Posts a Cocoa key-down straight to this process's main menu, so
// it needs no Accessibility permission and touches no other app:
//
//   clang -bundle -undefined dynamic_lookup -framework Cocoa -framework ApplicationServices \
//     -I <node-or-electron-headers>/include/node \
//     -o /tmp/reload-focus-native-key.node scripts/dev/reload-focus-native-key.m
//
// Exports performReloadKeyEquivalent(ignoreCache: boolean): boolean, true when
// a menu item claimed Command+R (or Shift+Command+R). Main thread only.
#include <node_api.h>
#import <Cocoa/Cocoa.h>

static napi_value PerformReloadKeyEquivalent(napi_env env,
                                             napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  bool ignoreCache = false;
  if (argc > 0) napi_get_value_bool(env, argv[0], &ignoreCache);

  // Let macOS derive the keyboard-layout-dependent character fields. Building
  // NSEvent by hand can select ordinary Reload for the shifted shortcut.
  CGEventRef key = CGEventCreateKeyboardEvent(NULL, 15, true);
  CGEventSetFlags(key, kCGEventFlagMaskCommand |
                          (ignoreCache ? kCGEventFlagMaskShift : 0));
  NSEvent *event = [NSEvent eventWithCGEvent:key];
  CFRelease(key);
  BOOL handled = [[NSApp mainMenu] performKeyEquivalent:event];

  napi_value result;
  napi_get_boolean(env, handled, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "performReloadKeyEquivalent", NAPI_AUTO_LENGTH,
                       PerformReloadKeyEquivalent, NULL, &fn);
  napi_set_named_property(env, exports, "performReloadKeyEquivalent", fn);
  return exports;
}

NAPI_MODULE(reload_focus_native_key, Init)
