import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  TraycerApp,
  hostRpcRegistry,
  installTitleBarOverlayThemeSync,
} from "@traycer-clients/gui-app";
import * as Sentry from "@sentry/electron/renderer";
import { makeFetchTransport } from "@sentry/browser";
import "./index.css";
import {
  DesktopRunnerHost,
  type DesktopPreloadBridge,
} from "./desktop-runner-host";
import { composeDesktopSignInUrl, DESKTOP_REDIRECT_URI } from "./sign-in-url";
import {
  scrubDesktopBreadcrumbInPlace,
  scrubDesktopSentryEventInPlace,
} from "../shared/sentry-scrub";
import { config } from "../config";

declare global {
  interface Window {
    readonly runnerHost: DesktopPreloadBridge;
  }
}

function bootstrap(): void {
  const bridge = window.runnerHost;
  if (bridge === undefined || bridge === null) {
    throw new Error(
      "window.runnerHost is not installed - preload failed to execute",
    );
  }

  if (bridge.sentryRendererDsn.length > 0) {
    const isProd = config.environment === "production";
    const sampleRate = isProd ? 0.1 : 1.0;
    Sentry.init({
      dsn: bridge.sentryRendererDsn,
      environment: config.environment,
      tracesSampleRate: sampleRate,
      profilesSampleRate: sampleRate,
      attachStacktrace: true,
      // Stated, not inherited - see `electron-main/app/crash-reporter.ts`.
      sendDefaultPii: false,
      // Use fetch transport so renderer events go directly to the renderer
      // Sentry project (traycer-desktop-renderer), not forwarded to main.
      transport: makeFetchTransport,
      // The renderer's own egress filter, and not just a URL rewrite: an
      // unhandled error uploads its message verbatim in
      // `exception.values[].value`, and a console breadcrumb carries the
      // joined `console.*` arguments - both routinely a credential a page or
      // an RPC error rendered into text. This is the same shaping the main
      // process applies, from the same detection leaf.
      beforeSend: (event) => {
        scrubDesktopSentryEventInPlace(event);
        return event;
      },
      // The browser SDK records the full URL of every fetch/xhr/navigation.
      // Signed asset URLs carry their credential in the query string, so
      // breadcrumbs keep origin + pathname and nothing else. Recorded-time,
      // not send-time: the scope outlives the event.
      beforeBreadcrumb: (breadcrumb) => {
        scrubDesktopBreadcrumbInPlace(breadcrumb);
        return breadcrumb;
      },
    });
  }

  // Dev builds receive a runtime loopback redirect_uri from main (the
  // `traycer-dev://` scheme is unregistrable for an unpackaged app); staging/
  // prod leave it empty and fall back to the compile-time custom-scheme URI.
  const redirectUri =
    bridge.authRedirectUri.length > 0
      ? bridge.authRedirectUri
      : DESKTOP_REDIRECT_URI;
  const host = new DesktopRunnerHost({
    bridge,
    signInUrl: composeDesktopSignInUrl(redirectUri),
  });

  if (bridge.menu.platform === "win32") {
    const disposeTitleBarThemeSync = installTitleBarOverlayThemeSync(
      bridge.platform.windowEx,
      document,
    );
    window.addEventListener("beforeunload", disposeTitleBarThemeSync, {
      once: true,
    });
  }

  const container = document.getElementById("root");
  if (container === null) {
    throw new Error("#root element not found in index.html");
  }

  createRoot(container).render(
    <StrictMode>
      <TraycerApp
        runnerHost={host}
        registry={hostRpcRegistry}
        remoteFetcher={null}
        initialRoute={bridge.initialRoute}
      />
    </StrictMode>,
  );
}

bootstrap();
