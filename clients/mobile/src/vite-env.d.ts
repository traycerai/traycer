/// <reference types="vite/client" />

/**
 * The dev loopback scaffolding, baked only when the config's environment is
 * `dev`: a 127.0.0.1 host entry plus the dev-server endpoint that re-reads its
 * CURRENT pid.json. Shipped (staging/production) builds carry `null` and use
 * real remote-host discovery instead.
 */
interface TraycerMobileDevHost {
  /** Dev-server endpoint returning the host's CURRENT pid.json contents. */
  readonly devHostPath: string;
  readonly host: {
    readonly hostId: string;
    readonly label: string;
    readonly kind: "local";
    readonly websocketUrl: string;
    readonly version: string;
    readonly status: "available";
  };
}

interface TraycerMobileBakedConfig {
  /**
   * Which backend set this bundle is baked against. Also decides APNs
   * addressing: only `dev` builds are debug-signed (`aps-environment:
   * development`, tokens valid on the sandbox gateway alone) - staging and
   * production both ship distribution-signed through TestFlight / the App
   * Store and register against the production gateway.
   */
  readonly environment: "dev" | "staging" | "production";
  readonly authnBaseUrl: string;
  readonly signInUrl: string;
  /** The relay's WS attach endpoint, baked the way the desktop bakes its own. */
  readonly relayBaseUrl: string;
  /** Device-flow display label authn shows on the sign-in approval page. */
  readonly hostLabel: string;
  /**
   * Custom URL scheme the OS routes back to THIS app after browser sign-in.
   * Must equal the scheme the native shell actually registers: the checked-in
   * Info.plist value for dev and production, the CI-stamped one for staging
   * (`vite.config.ts` SHIPPED_RETURN_SCHEMES has the pairing rules).
   */
  readonly returnScheme: string;
  /** Dev host scaffolding, or `null` in shipped (staging/production) builds. */
  readonly devHost: TraycerMobileDevHost | null;
}

declare const __TRAYCER_MOBILE_CONFIG__: TraycerMobileBakedConfig;
