import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize } from "@capacitor/keyboard";

/**
 * Capacitor configuration for the Traycer mobile runner.
 *
 * `webDir` points at `dist/web/` - the output folder produced by Vite when
 * building `src/web/index.html`. The mobile renderer consumes the `gui-app`
 * workspace library directly, so there is no separate staging step; `cap
 * sync` copies the built `dist/web/` into the native Android/iOS projects.
 *
 * This client-only milestone targets the iOS Simulator and the Android
 * emulator. The `http` scheme gives the packaged WebView an origin accepted by
 * the existing loopback WebSocket guard, while CapacitorHttp patches `fetch`
 * so auth calls are performed by the native layer rather than being decided by
 * WKWebView CORS.
 *
 * `androidScheme` matches `iosScheme` rather than keeping Capacitor's `https`
 * default, and PARITY IS THE WHOLE REASON: one packaged-build WebView origin,
 * `http://localhost`, on both platforms. Do not cite the loopback WebSocket
 * guard here - it accepts loopback `http:` and `https:` identically, so it is
 * neutral between them.
 *
 * Note how little this setting actually reaches. Under `--live-reload`
 * Capacitor sets `server.url`, so the document origin is the dev server's
 * regardless of this value; `androidScheme` governs only the packaged build,
 * which nobody has run yet. It is nevertheless settled NOW rather than later,
 * because changing the scheme once an install exists wipes everything scoped
 * to the WebView origin - localStorage, IndexedDB, cookies. Cheap today, a
 * migration afterwards.
 *
 * Debug builds separately carry a loopback-scoped cleartext exemption
 * (`android/app/src/debug/`), which the dev loop needs either way.
 */
const config: CapacitorConfig = {
  appId: "com.traycer.app",
  appName: "Traycer",
  webDir: "dist/web",
  server: {
    iosScheme: "http",
    androidScheme: "http",
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    // Without the Keyboard plugin WKWebView leaves the webview full-height
    // and overlays the soft keyboard, hiding the terminal key bar behind it.
    // "native" resizes the whole webview on show/hide, so the h-dvh app shell
    // (key bar included) tracks the visible area and the gui-app's
    // visualViewport inset fallback measures 0 here.
    Keyboard: {
      resize: KeyboardResize.Native,
      // Tint the strip iOS exposes behind the keyboard during show/hide from
      // the DOM body background; the default ("off") flashes white against a
      // dark theme on every keyboard animation.
      autoBackdropColor: "dom",
    },
  },
};

export default config;
