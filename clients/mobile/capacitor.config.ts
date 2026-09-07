import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize } from "@capacitor/keyboard";

/**
 * Capacitor configuration for the Traycer mobile runner.
 * This client-only milestone targets the iOS Simulator and the Android emulator.
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
    // No backdrop config: an un-resized webview exposes no strip behind the keyboard.
    Keyboard: {
      resize: KeyboardResize.None,
    },
  },
};

export default config;
