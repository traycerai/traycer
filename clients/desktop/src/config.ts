/**
 * Single source of truth for this desktop build's deployment config.
 *
 * Flat config object: source always holds the dev values; the deploy
 * script (this module's scripts/set-deploy-target.cjs) rewrites the
 * `environment` field + the literal values in place for staging/production
 * builds, then reverts.
 * There is no runtime env-var lookup - packaged apps launched from
 * /Applications/ have no shell environment, so a stray `process.env` value
 * could only silently repoint the app at the wrong backend.
 *
 * Dev-vs-shipped wiring (renderer/tray/icon paths, dev URL, dev CLI wrapper,
 * updater, userData isolation, log verbosity) is derived from
 * `config.environment` via `isDevBuild` below - NOT from `app.isPackaged`.
 * `environment` is the single discriminator: the dev slot is the development
 * build, staging/production are the shipped builds. DevTools policy is a
 * separate production-only gate because staging installs need the inspector
 * even though they use shipped renderer/runtime wiring. There is no separate
 * packaged-vs-source axis (the only unpackaged build is the dev one), and
 * keeping it on `environment` means behaviour is identical for a given slot
 * whether or not the build happens to be packaged.
 */

export type Environment = string;

export const config = {
  environment: "dev" as Environment,
  // Concrete per-build identity, stamped at install time by the deploy
  // script (alongside `environment`). `0.0.0-dev` in source / after
  // `--restore`; a real install bakes `<target>.<epochMs>.<gitSha>` into the
  // Desktop and bundled CLI from the same release. Desktop bundles only the
  // CLI; the CLI subprocess owns host install/update/restart decisions.
  version: "staging.1783581575647.bb8c937d9",
  authnBaseUrl: "https://authn.dev.traycer.ai",
  cloudUiBaseUrl: "https://platform.dev.traycer.ai",
  // Sentry crash-reporting DSN for the main process. Empty for local
  // (reporting disabled); the deploy script bakes the staging/production DSN.
  sentryDsn: "",
  // Sentry DSN for the renderer process (separate project). Empty for local;
  // the deploy script bakes the staging/production DSN.
  sentryRendererDsn: "",
  // Per-environment app identity. Drives the Electron app name (and therefore
  // the userData directory + single-instance lock), the OAuth deep-link scheme,
  // and the Windows AppUserModelId. Source holds the dev values so a
  // `make dev-desktop` shell stays isolated from an installed build; the deploy
  // script stamps the shipped values for a packaged build. Keeping each slot's
  // identity distinct is what lets separate builds coexist without stealing one
  // another's lock/state.
  appName: "Traycer Staging",
  protocolScheme: "traycer-staging",
  appId: "ai.traycer.desktop.staging",
};

// Single derived discriminator for "development build vs shipped build",
// constructed from `environment` (the same pattern as the CLI's derived
// `hostRegistryUrl`). Every dev-vs-shipped decision reads this: the dev
// slot loads the Vite dev server, resolves assets/CLI from the workspace,
// isolates userData, and skips the auto-updater/login-item; staging/production
// are the shipped behaviours.
export const isDevBuild = config.environment === "dev";

// DevTools are available in dev + staging and disabled only for production.
export const canOpenDevTools = config.environment !== "production";

// The sign-in flow opens the Cloud UI's sign-in route.
export const DESKTOP_SIGN_IN_BASE_URL = config.cloudUiBaseUrl;

// Custom URL scheme for the OAuth deep-link callback. Each build registers its
// own scheme (dev `traycer-dev://`, production `traycer://`) so the cloud's
// `${scheme}://auth/callback` redirect is routed by the OS to THIS app and not
// a sibling install sharing a scheme. The value is per-environment in `config`
// (`protocolScheme`); packaged builds register it via the bundle's Info.plist
// (`protocols`), and the unpackaged dev build registers it at runtime via
// `setAsDefaultProtocolClient`.
export const DESKTOP_PROTOCOL_SCHEME = config.protocolScheme;

// App display name - used as the Electron app name (which derives the userData
// directory + single-instance lock) and for the Dock/menu/About panel - plus
// the Windows AppUserModelId. Both are per-environment via `config` so each
// build's identity is stamped at build time, not hardcoded per slot.
export const DESKTOP_APP_NAME = config.appName;
export const DESKTOP_APP_USER_MODEL_ID = config.appId;
