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
   * addressing: a non-`production` build is debug-signed (`aps-environment:
   * development`), so its push tokens are only valid on the sandbox gateway.
   */
  readonly environment: "dev" | "staging" | "production";
  readonly authnBaseUrl: string;
  readonly signInUrl: string;
  /** The relay's WS attach endpoint, baked the way the desktop bakes its own. */
  readonly relayBaseUrl: string;
  /** Device-flow display label authn shows on the sign-in approval page. */
  readonly hostLabel: string;
  /** Dev host scaffolding, or `null` in shipped (staging/production) builds. */
  readonly devHost: TraycerMobileDevHost | null;
}

declare const __TRAYCER_MOBILE_CONFIG__: TraycerMobileBakedConfig;
