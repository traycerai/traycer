import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  TraycerApp,
  hostRpcRegistry,
  setAnalyticsAppSurface,
} from "@traycer-clients/gui-app";
import "./index.css";
import {
  createSessionScratchpad,
  createWindowMintLocation,
  exchangeAppCode,
  probeAppIdentity,
  runAppSessionMint,
  webCryptoPkce,
} from "./app-session-mint";
import { RetireBootSurface } from "./boot-surface";
import { NotFoundSurface } from "./not-found-surface";
import { WebRunnerHost } from "./web-runner-host";
import {
  createLocalStorageCredentialStorage,
  createWebLockManager,
} from "./web-token-store";

const config = __TRAYCER_WEBAPP_CONFIG__;

// Hoisted out of the render call so the reference is stable: the router is
// memoized on its arguments, and a fresh closure per render would rebuild it.
function notFoundSurface(): ReactNode {
  return <NotFoundSurface homeHref={`${config.basePath}/`} />;
}

async function bootstrap(): Promise<void> {
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
  // Before the first render, not inside it. A signed-in visitor of the
  // dashboard is entitled to this app with no clicks, and the way they get it
  // is a same-origin bounce through `/login/app` - so the boot either commits
  // a credential first, or leaves the document entirely. Mounting the app
  // ahead of that decision would flash a sign-in screen at someone who is
  // already signed in, and would tear a mounting React tree down mid-paint.
  //
  // Every other outcome renders normally: a stored credential rehydrates, and
  // a mint that could not complete leaves the store empty, which is the shell's
  // signed-out state - the device flow, reachable with no dashboard session at
  // all.
  const mint = await runAppSessionMint({
    location: createWindowMintLocation(),
    scratchpad: createSessionScratchpad(),
    tokenStore: host.tokenStore,
    authnBaseUrl: config.authnBaseUrl,
    exchange: exchangeAppCode(config.authnBaseUrl),
    probeIdentity: probeAppIdentity(config.authnBaseUrl),
    pkce: webCryptoPkce,
  });
  if (mint.kind === "navigating") {
    // The boot surface stays up: this document is leaving, and clearing the
    // screen first would flash a blank page on the way out.
    return;
  }
  if (mint.kind === "device-flow-fallback") {
    console.warn("[web] silent sign-in unavailable", { reason: mint.reason });
  }

  const container = document.getElementById("root");
  if (container === null) {
    throw new Error("#root element not found in index.html");
  }
  createRoot(container).render(
    <StrictMode>
      {/* Retires the boot surface, and does it from INSIDE the tree: this
          call only schedules a render, so anything that clears the screen
          beside it clears it before the app is on screen. */}
      <RetireBootSurface />
      <TraycerApp
        runnerHost={host}
        registry={hostRpcRegistry}
        // `null` hands discovery to gui-app's default fetcher - the registry
        // list projected into relay-backed `remote` entries. This shell has
        // no local host to inject, so that is the only path.
        remoteFetcher={null}
        basepath={config.basePath}
        // An address bar can be sent anywhere, so this shell owns the answer
        // for a URL that matches nothing. The home target is composed from
        // the same baked prefix the router parses against, so the two cannot
        // point at different roots.
        notFoundComponent={notFoundSurface}
      />
    </StrictMode>,
  );
}

void bootstrap();
