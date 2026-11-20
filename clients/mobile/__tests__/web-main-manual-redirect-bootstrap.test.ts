import { afterEach, describe, expect, it, vi } from "vitest";

const boot = vi.hoisted(() => ({
  native: false,
  platform: "web",
  request: vi.fn(),
  onRender: null as (() => void) | null,
}));

vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: () => boot.onRender?.() }),
}));

vi.mock("@capacitor/app", () => ({ App: {} }));
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => boot.native,
    getPlatform: () => boot.platform,
    isPluginAvailable: () => false,
  },
  CapacitorHttp: { request: boot.request },
  SystemBars: { setStyle: vi.fn() },
  SystemBarsStyle: { Dark: "DARK", Light: "LIGHT" },
}));
vi.mock("@capacitor/keyboard", () => ({ Keyboard: {} }));
vi.mock("@capacitor/push-notifications", () => ({ PushNotifications: {} }));
vi.mock("@sentry/browser", () => ({ init: vi.fn() }));
vi.mock("capacitor-native-settings", () => ({
  AndroidSettings: {
    AppNotification: "notifications",
    ApplicationDetails: "app",
  },
  IOSSettings: { AppNotification: "notifications", App: "app" },
  NativeSettings: { openAndroid: vi.fn(), openIOS: vi.fn() },
}));
vi.mock("@traycer-clients/gui-app", () => ({
  DESKTOP_RETENTION_PROFILE: {},
  MOBILE_RETENTION_PROFILE: {},
  TraycerApp: () => null,
  hostRpcRegistry: {},
  setMobileApp: vi.fn(),
  setMobileAppPlatform: vi.fn(),
  setPhoneLayoutOnly: vi.fn(),
  setRetentionProfile: vi.fn(),
}));
vi.mock("@traycer-clients/shared/host-client/remote-fetcher", () => ({
  fetchRegisteredHostsViaHttp: vi.fn(),
}));
vi.mock("@traycer-clients/shared/auth/push-token-fetcher", () => ({
  registerDevicePushTokenViaHttp: vi.fn(),
  removeDevicePushTokenViaHttp: vi.fn(),
}));
vi.mock("../src/web/native-keyboard-bridge", () => ({
  startNativeKeyboardBridge: vi.fn(),
}));
vi.mock("../src/web/dev-host-discovery", () => ({
  buildDevHostDiscovery: vi.fn(),
  buildDevHostFetcher: vi.fn(),
  createDevHostRegistryMemory: () => ({}),
  fleetRowsOf: vi.fn(),
  readDevHostDiscovery: vi.fn(),
}));
vi.mock("../src/web/native-http-token", () => ({
  installNativeHttpToken: () => true,
}));
vi.mock("../src/auth-sheet", () => ({
  AuthSession: {},
  MobileAuthSheet: class {},
}));
vi.mock("@traycer-clients/shared/host-client/sandbox-control", () => ({
  SANDBOXES_UNAVAILABLE_IN_STAGING: "unavailable",
}));
vi.mock("../src/mobile-runner-host", () => ({
  MobileRunnerHost: class {
    readonly tokenStore = { get: async () => null };
    readonly relayBaseUrl = "relay";
    readonly listRegisteredHosts = vi.fn();
  },
}));
vi.mock("../src/sentry", () => ({ sentryInitOptions: () => null }));
vi.mock("../src/device-describer", () => ({ MobileDeviceDescriber: class {} }));
vi.mock("../src/file-save", () => ({
  MobileFileSave: class {},
  supportsDirectDownload: async () => false,
}));
vi.mock("../src/link-code-scanner", () => ({
  MobileLinkCodeScanner: class {},
}));
vi.mock("../src/link-login-deep-links", () => ({
  MobileLinkLoginDeepLinks: class {
    start(): void {}
  },
}));
vi.mock("../src/status-bar-tap", () => ({ MobileStatusBarTap: class {} }));
vi.mock("../src/system-back", () => ({ MobileSystemBack: class {} }));
vi.mock("../src/device-dictation", () => ({
  DeviceDictation: {},
  MobileDeviceDictation: class {},
}));
vi.mock("../src/voice-audio", () => ({
  MobileVoiceAudio: class {},
  VoiceAudio: {},
}));
vi.mock("../src/window-background", () => ({
  WindowBackground: {},
  cssLayersToHex: vi.fn(),
  startWindowBackgroundSync: vi.fn(),
}));
vi.mock("../src/push-registration", () => ({
  MobilePushRegistration: class {},
  pushRegistrationTarget: () => null,
}));
vi.mock("../src/web/index.css", () => ({}));
vi.mock("../src/web/index.native.css", () => ({}));

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  boot.native = false;
  boot.platform = "web";
  boot.onRender = null;
  boot.request.mockReset();
  document.head.replaceChildren();
  document.body.replaceChildren();
});

function renderSignal(): { readonly rendered: Promise<void> } {
  let markRendered: (() => void) | undefined;
  const rendered = new Promise<void>((resolve) => {
    markRendered = resolve;
  });
  boot.onRender = () => markRendered?.();
  return { rendered };
}

describe("mobile entry fetch installation", () => {
  it("wraps fetch during native bootstrap and leaves the web entry untouched", async () => {
    const originalFetch = globalThis.fetch;
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);

    try {
      boot.native = true;
      boot.platform = "ios";
      boot.request.mockResolvedValue({
        status: 307,
        headers: { location: "https://elsewhere.example.invalid/" },
        data: "redirect body",
      });
      const nativePlatformFetch = vi.fn<typeof fetch>(
        async () => new Response("platform"),
      );
      globalThis.fetch = nativePlatformFetch;
      window.fetch = nativePlatformFetch;
      const nativeRender = renderSignal();

      await import("../src/web/main");
      const installedFetch = window.fetch;
      expect(installedFetch).not.toBe(nativePlatformFetch);
      const response = await installedFetch("https://authn.example.invalid/", {
        method: "POST",
        headers: { authorization: "fake-credential" },
        body: "code=fake-code",
        redirect: "manual",
      });
      expect(response.status).toBe(307);
      expect(nativePlatformFetch).not.toHaveBeenCalled();
      expect(boot.request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://authn.example.invalid/",
          method: "POST",
          headers: { authorization: "fake-credential" },
          data: "code=fake-code",
          disableRedirects: true,
          responseType: "text",
        }),
      );
      await nativeRender.rendered;

      vi.resetModules();
      boot.native = false;
      boot.platform = "web";
      const webPlatformFetch = vi.fn<typeof fetch>(
        async () => new Response("web"),
      );
      globalThis.fetch = webPlatformFetch;
      window.fetch = webPlatformFetch;
      const webRender = renderSignal();

      await import("../src/web/main");
      expect(window.fetch).toBe(webPlatformFetch);
      await webRender.rendered;
    } finally {
      globalThis.fetch = originalFetch;
      window.fetch = originalFetch;
    }
  });
});
