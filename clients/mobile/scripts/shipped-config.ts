/** Mirrors the desktop's baked value (`clients/desktop/src/config.ts`). */
export const RELAY_BASE_URL = "wss://relay.traycer.ai/attach";

/**
 * Deployed backend sets for shipped bundles, selected with
 * `TRAYCER_MOBILE_ENV=staging|production` (default: `dev`, the loopback
 * scaffolding in `vite.config.ts`). The values mirror the desktop's
 * `config.ts` and the host's `set-deploy-target` targets — these endpoints
 * move together. A shipped bundle bakes its environment as a literal, so a
 * stray env var cannot repoint an installed app; only the dev config reads
 * `TRAYCER_DEV_*` overrides.
 *
 * `poolBaseUrl` is the server pool's session endpoint, the staging release
 * target's `cloud.poolUrl`. Staging only: production has no pool, and its
 * empty value keeps a production build on today's routing and screens.
 */
const SHIPPED_ENVIRONMENTS = {
  staging: {
    authnBaseUrl: "https://authn.dev.traycer.ai",
    // The host's staging `traycerServerBaseUrl`. Fronted by IAP, so a call
    // carrying only the user bearer is refused there: a staging build turns
    // its sandbox surfaces off (`SANDBOXES_UNAVAILABLE_IN_STAGING`, set in
    // `src/web/main.tsx`) rather than sending calls that cannot pass.
    serverBaseUrl: "https://server.dev.traycer.ai",
    cloudUiBaseUrl: "https://dev.traycer.ai",
    relayBaseUrl: "wss://relay.dev.traycer.ai/attach",
    poolBaseUrl: "wss://pool.sandbox.dev.traycer.ai/v1/session",
  },
  production: {
    authnBaseUrl: "https://authn.traycer.ai",
    serverBaseUrl: "https://server.traycer.ai",
    cloudUiBaseUrl: "https://traycer.ai",
    relayBaseUrl: RELAY_BASE_URL,
    poolBaseUrl: "",
  },
} as const;

/**
 * Per-lane sign-in return scheme. The iOS release workflow stamps the staging
 * app into a SEPARATE identity (bundle id `ai.traycer.app.ios.staging` + this
 * URL scheme) so both lanes install side by side and the browser's sign-in
 * return reopens the right app; the baked value and the stamped scheme move
 * together - change one, change both (release-mobile-ios.yaml, "Stamp staging
 * app identity"). A staging bundle built locally in Xcode keeps the
 * checked-in `traycer` scheme, so its sign-in return cannot come back - use
 * the dev loop for local work.
 */
const SHIPPED_RETURN_SCHEMES = {
  staging: "traycer-staging",
  production: "traycer",
} as const;

export type ShippedMobileEnvironment = keyof typeof SHIPPED_ENVIRONMENTS;

/** The baked config of a shipped (staging or production) bundle. */
export function shippedConfig(
  environment: ShippedMobileEnvironment,
  sentryDsn: string,
): TraycerMobileBakedConfig {
  const backends = SHIPPED_ENVIRONMENTS[environment];
  return {
    environment,
    authnBaseUrl: backends.authnBaseUrl,
    serverBaseUrl: backends.serverBaseUrl,
    signInUrl: new URL("/sign-in", backends.cloudUiBaseUrl).toString(),
    relayBaseUrl: backends.relayBaseUrl,
    poolBaseUrl: backends.poolBaseUrl,
    // Authn shows this on the device-flow approval page as who is asking.
    hostLabel: "Traycer Mobile",
    returnScheme: SHIPPED_RETURN_SCHEMES[environment],
    sentryDsn,
    // No loopback host to dial: the shipped client discovers hosts through
    // the registry (`remoteFetcher={null}` → gui-app's default fetcher).
    devHost: null,
  };
}
