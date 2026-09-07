/** Staging/production builds have a non-`"dev"` literal baked in, so a stray `process.env` value cannot repoint a packaged app at a different backend. */

import {
  DEV_AUTHN_BASE_URL_ENV,
  DEV_CLOUD_UI_BASE_URL_ENV,
  DEV_RELAY_BASE_URL_ENV,
  devBackendUrlFromEnv,
  devRelayBaseUrlFromEnv,
} from "../../shared/platform/dev-backend-urls";

export type Environment = string;

const bakedConfig = {
  environment: "dev" as Environment,
  version: "0.0.0-dev",
  authnBaseUrl: "https://authn.traycer.ai",
  cloudUiBaseUrl: "https://platform.traycer.ai",
  relayBaseUrl: "wss://relay.traycer.ai/attach",
  // Sentry crash-reporting DSN for the main process. Empty for local
  // (reporting disabled); the deploy script bakes the staging/production DSN.
  sentryDsn: "",
  // Sentry DSN for the renderer process (separate project). Empty for local;
  // the deploy script bakes the staging/production DSN.
  sentryRendererDsn: "",
  appName: "Traycer Dev",
  protocolScheme: "traycer-dev",
  appId: "ai.traycer.desktop",
};

// The dev-gated backend URL overrides resolve once, at module init, so every
// consumer (main, preload, IPC-served desktop config) sees one consistent
// value for the process's lifetime.
export const config = {
  ...bakedConfig,
  authnBaseUrl: devBackendUrlFromEnv(
    bakedConfig.environment,
    DEV_AUTHN_BASE_URL_ENV,
    bakedConfig.authnBaseUrl,
    process.env,
  ),
  cloudUiBaseUrl: devBackendUrlFromEnv(
    bakedConfig.environment,
    DEV_CLOUD_UI_BASE_URL_ENV,
    bakedConfig.cloudUiBaseUrl,
    process.env,
  ),
  relayBaseUrl: devRelayBaseUrlFromEnv(
    bakedConfig.environment,
    DEV_RELAY_BASE_URL_ENV,
    bakedConfig.relayBaseUrl,
    process.env,
  ),
};

export const isDevBuild = config.environment === "dev";

// DevTools are available in dev + staging and disabled only for production.
export const canOpenDevTools = config.environment !== "production";

// The sign-in flow opens the Cloud UI's sign-in route.
export const DESKTOP_SIGN_IN_BASE_URL = config.cloudUiBaseUrl;

export const DESKTOP_PROTOCOL_SCHEME = config.protocolScheme;

export const DESKTOP_APP_NAME = config.appName;
export const DESKTOP_APP_USER_MODEL_ID = config.appId;
