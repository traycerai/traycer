import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  TraycerApp,
  hostRpcRegistry,
  setAnalyticsAppSurface,
} from "@traycer-clients/gui-app";
import "./index.css";
import { WebRunnerHost } from "./web-runner-host";
import {
  createLocalStorageCredentialStorage,
  createWebLockManager,
} from "./web-token-store";

const config = __TRAYCER_WEBAPP_CONFIG__;

function bootstrap(): void {
  // NOT `setMobileApp(true)`. That flag is the PRODUCT signal for the
  // installed phone app, and a browser tab is a desktop product: it keeps
  // multi-draft composing, shortcut hints, the keybindings settings section
  // and the "link a phone" QR surface, all of which that flag would take
  // away. The mobile CAPABILITY posture is expressed on the runner host
  // below instead - see `lib/mobile-app.ts` for why the two are separate.
  //
  // Telemetry still has to be able to name this shell, and no capability can:
  // the browser app and the in-browser dev loop are indistinguishable by
  // ability. So identity is DECLARED here, before the first render.
  setAnalyticsAppSurface("web");
  const host = new WebRunnerHost({
    signInUrl: config.signInUrl,
    authnBaseUrl: config.authnBaseUrl,
    hostLabel: config.hostLabel,
    relayBaseUrl: config.relayBaseUrl,
    credentialStorage: createLocalStorageCredentialStorage(),
    locks: createWebLockManager(),
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
        // `null` hands discovery to gui-app's default fetcher - the registry
        // list projected into relay-backed `remote` entries. This shell has
        // no local host to inject, so that is the only path.
        remoteFetcher={null}
        basepath={config.basePath}
      />
    </StrictMode>,
  );
}

bootstrap();
