/// <reference types="vite/client" />

interface TraycerWebappBakedConfig {
  /** Which backend set this bundle is baked against. */
  readonly environment: "dev" | "staging" | "production";
  readonly authnBaseUrl: string;
  readonly signInUrl: string;
  /** The relay's WS attach endpoint, baked the way the desktop bakes its own. */
  readonly relayBaseUrl: string;
  /** Device-flow display label authn shows on the sign-in approval page. */
  readonly hostLabel: string;
  /**
   * Path prefix this bundle is served under, without a trailing slash. The
   * router parses the URL bar against it; Vite's `base` writes asset URLs
   * under the same prefix. `vite.config.ts` owns the single source both read.
   */
  readonly basePath: string;
}

declare const __TRAYCER_WEBAPP_CONFIG__: TraycerWebappBakedConfig;
