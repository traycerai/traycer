import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TraycerApp, hostRpcRegistry } from "@traycer-clients/gui-app";
import * as Sentry from "@sentry/electron/renderer";
import { makeFetchTransport } from "@sentry/browser";
import "./index.css";
import {
  DesktopRunnerHost,
  type DesktopPreloadBridge,
} from "./desktop-runner-host";
import { composeDesktopSignInUrl, DESKTOP_REDIRECT_URI } from "./sign-in-url";
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
      // Use fetch transport so renderer events go directly to the renderer
      // Sentry project (traycer-desktop-renderer), not forwarded to main.
      transport: makeFetchTransport,
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
