import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import {
  AndroidSettings,
  IOSSettings,
  NativeSettings,
} from "capacitor-native-settings";
import {
  TraycerApp,
  hostRpcRegistry,
  setMobileApp,
  setMobileAppPlatform,
} from "@traycer-clients/gui-app";
import type {
  RemoteHostFetcher,
  RemoteHostFetchOutcome,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  registerDevicePushTokenViaHttp,
  removeDevicePushTokenViaHttp,
} from "@traycer-clients/shared/auth/push-token-fetcher";
import "./index.css";
import { MobileRunnerHost } from "../mobile-runner-host";
import { MobileDeviceDescriber } from "../device-describer";
import { MobileFileSave } from "../file-save";
import { MobileLinkCodeScanner } from "../link-code-scanner";
import { MobileLinkLoginDeepLinks } from "../link-login-deep-links";
import {
  MobilePushRegistration,
  pushRegistrationTarget,
} from "../push-registration";

/**
 * OS push exists only inside the native shells - the dev web entry has no
 * push plugin, so `pushRegistrationTarget` returns `null` for it and the
 * runner host's click sink stays the familiar no-op. The per-platform
 * `(platform, environment)` rule, including why Android is always
 * `production`, lives with that function.
 */
function buildPushRegistration(
  authnBaseUrl: string,
  isDevSignedBuild: boolean,
): MobilePushRegistration | null {
  const target = pushRegistrationTarget(
    Capacitor.getPlatform(),
    isDevSignedBuild,
  );
  if (target === null) {
    return null;
  }
  return new MobilePushRegistration({
    plugin: PushNotifications,
    authnBaseUrl,
    platform: target.platform,
    environment: target.environment,
    registerToken: registerDevicePushTokenViaHttp,
    removeToken: removeDevicePushTokenViaHttp,
  });
}

/**
 * How the Settings row's "Open Settings" button leaves the app, or `null` on
 * the dev web entry, which has no OS page to open (and no push permission to
 * repair - `pushRegistration` is `null` there too, so the row never renders).
 *
 * Both platforms land on the app's NOTIFICATION screen, one tap from the
 * switch: `AppNotification` resolves iOS 15.4+'s notification-settings URL and
 * falls back to the app page (`UIApplication.openSettingsURLString`, the one
 * screen Apple supports opening) below that, where Notifications is one row
 * down anyway.
 */
function buildOpenPushSettings(): (() => Promise<void>) | null {
  const platform = Capacitor.getPlatform();
  if (platform === "ios") {
    return async (): Promise<void> => {
      await NativeSettings.openIOS({ option: IOSSettings.AppNotification });
    };
  }
  if (platform === "android") {
    return async (): Promise<void> => {
      await NativeSettings.openAndroid({
        option: AndroidSettings.AppNotification,
      });
    };
  }
  return null;
}

const config = __TRAYCER_MOBILE_CONFIG__;

// The baked dev host captures the port as of Vite startup, which goes stale
// whenever the dev host restarts; the dev-server endpoint re-reads the host's
// pid.json per request, so each directory refresh gets the live port.
// BROWSER-TESTING SCAFFOLDING (dev entry only): a shipped build carries no
// `devHost` and uses real remote-host discovery instead (see below).
function buildDevHostFetcher(
  devHost: TraycerMobileDevHost,
): () => Promise<RemoteHostFetchOutcome> {
  // The baked config predates the directory's dialability field; the dev
  // host is a loopback WebSocket, which is the definition of dialable.
  const bakedHost: RemoteHostFetchOutcome = {
    kind: "hosts",
    entries: [{ ...devHost.host, transportDialability: "dialable" }],
  };
  return async () => {
    try {
      const response = await fetch(devHost.devHostPath);
      if (!response.ok) return bakedHost;
      const parsed: unknown = await response.json();
      if (parsed === null || typeof parsed !== "object") return bakedHost;
      const record = parsed as Record<string, unknown>;
      const { hostId, version, websocketUrl } = record;
      if (
        typeof hostId !== "string" ||
        typeof version !== "string" ||
        typeof websocketUrl !== "string"
      ) {
        return bakedHost;
      }
      return {
        kind: "hosts",
        entries: [
          {
            ...devHost.host,
            hostId,
            version,
            websocketUrl,
            transportDialability: "dialable",
          },
        ],
      };
    } catch {
      // The baked entry, not `failed`: this scaffolding's whole point is that
      // the dev host is reachable at a known port even when the pid re-read
      // misses.
      return bakedHost;
    }
  };
}

// `null` hands discovery to gui-app's default fetcher — the registry list
// (`GET /api/v3/hosts` through `MobileRunnerHost.listRegisteredHosts`)
// projected into relay-backed `remote` entries. The same production path the
// desktop shell is on.
const devHostFetch: (() => Promise<RemoteHostFetchOutcome>) | null =
  config.devHost === null ? null : buildDevHostFetcher(config.devHost);
const remoteFetcher: RemoteHostFetcher | null =
  devHostFetch === null ? null : () => devHostFetch();

function bootstrap(): void {
  document.documentElement.classList.add("traycer-mobile-client");
  // PRODUCT flag, not layout: unlocks mobile-app-only UX policy such as the
  // single-composer draft model and the link-code sign-in entry. See gui-app's
  // `src/lib/mobile-app.ts` for how this differs from the viewport signal.
  // Platform-derived, not unconditional: this same bundle is ALSO the dev
  // stack's browser surface (`make dev-gui-app` serves it as the "gui-app"
  // stream), and a browser tab is not the installed mobile app — it must not
  // inherit phone-only affordances like "Scan from desktop", which on the
  // desktop side of that loop is a nonsense offer.
  setMobileApp(Capacitor.isNativePlatform());
  // The shell's platform, for copy that must name the right update channel
  // (TestFlight / the App Store vs Google Play). Gated on the same native
  // check as the flag above: the dev browser tab reports platform "web" and
  // stays `null`, which gui-app answers with store-neutral copy.
  const nativePlatform = Capacitor.getPlatform();
  setMobileAppPlatform(
    nativePlatform === "ios" || nativePlatform === "android"
      ? nativePlatform
      : null,
  );
  // APNs addressing follows code signing, not the backend set: staging and
  // production both ship distribution-signed (TestFlight / App Store rewrite
  // `aps-environment` to "production" at export), so only `dev` - the one
  // debug-signed path - registers against the sandbox gateway. A staging
  // bundle built locally in Xcode is debug-signed and mismatches; use the
  // dev loop for local work.
  const pushRegistration = buildPushRegistration(
    config.authnBaseUrl,
    config.environment === "dev",
  );
  // Started FIRST, before anything else in bootstrap: a QR scanned by the
  // system camera launches this app, and that launch URL is readable exactly
  // once. Native-only for the same reason as the scheme registration below -
  // a browser tab is never opened by the OS with a `traycer://` or
  // universal-link URL, and has no plugin to read one from.
  const linkLoginDeepLinks = Capacitor.isNativePlatform()
    ? new MobileLinkLoginDeepLinks(App)
    : null;
  linkLoginDeepLinks?.start();
  const host = new MobileRunnerHost({
    signInUrl: config.signInUrl,
    authnBaseUrl: config.authnBaseUrl,
    hostLabel: config.hostLabel,
    relayBaseUrl: config.relayBaseUrl,
    pushRegistration,
    openPushSettings: buildOpenPushSettings(),
    // The scheme registration ships with the NATIVE shell (Info.plist /
    // AndroidManifest; the iOS staging release lane re-stamps its own), and
    // the baked config names that same scheme. Platform still decides whether
    // ANY scheme exists: the dev web entry registers nothing and must not
    // name a scheme some other installed app would answer.
    returnScheme: Capacitor.isNativePlatform() ? config.returnScheme : null,
    // The selection authority's fleet rides the same dev-slot source the
    // directory's fetcher uses, so a loopback dev host (never registered in
    // the cloud) is still a derivation candidate. `null` = registry list.
    fleetHostIds:
      devHostFetch === null
        ? null
        : async () => {
            const outcome = await devHostFetch();
            return outcome.kind === "hosts"
              ? outcome.entries.map((entry) => entry.hostId)
              : null;
          },
    // `@capacitor/barcode-scanner` has no web implementation, so the camera
    // capability exists only on a native install; the browser entry keeps the
    // manual code-entry path alone.
    linkCodeScanner: Capacitor.isNativePlatform()
      ? new MobileLinkCodeScanner()
      : null,
    // Same native-only gate: the Device plugin has web fallbacks, but the
    // browser entry has nothing better than its own UA to report.
    deviceDescriber: Capacitor.isNativePlatform()
      ? new MobileDeviceDescriber()
      : null,
    linkLoginDeepLinks,
    // Native-only, like the two above: the share sheet is the OS surface a
    // phone user saves through, and neither plugin has a web implementation
    // worth preferring over the browser save APIs gui-app already falls back
    // to in a tab.
    fileSave: Capacitor.isNativePlatform() ? new MobileFileSave() : null,
  });
  // After the host exists: registration follows the token store (sign-in,
  // app start while signed in, sign-out) and the host's resume edge (a
  // permission granted later in the OS Settings app), and the plugin
  // listeners attach now so a cold-start tap is captured before the GUI
  // mounts.
  pushRegistration?.start(host.tokenStore, host);
  const container = document.getElementById("root");
  if (container === null) {
    throw new Error("#root element not found in index.html");
  }
  createRoot(container).render(
    <StrictMode>
      <TraycerApp
        runnerHost={host}
        registry={hostRpcRegistry}
        remoteFetcher={remoteFetcher}
      />
    </StrictMode>,
  );
}

bootstrap();
