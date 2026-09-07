/**
 * Dev-only backend URL overrides for `make dev-desktop` multi-run stacks, shared so the CLI and Desktop `config.ts` can never diverge on the env contract (names + validation).
 * The override is honored only when the build's baked `environment` is `"dev"` - for staging/production builds the lookup is dead code, so a hostile or stray runtime environment cannot repoint a shipped build.
 */

export const DEV_AUTHN_BASE_URL_ENV = "TRAYCER_DEV_AUTHN_BASE_URL";
export const DEV_CLOUD_UI_BASE_URL_ENV = "TRAYCER_DEV_CLOUD_UI_BASE_URL";
// Remote Host Support (ticket T14): the relay worker's local WebSocket attach endpoint, only read by the desktop build (the CLI never dials the relay itself).
export const DEV_RELAY_BASE_URL_ENV = "TRAYCER_DEV_RELAY_BASE_URL";

const ALLOWED_DEV_BACKEND_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
]);

export const DEV_ALLOW_LAN_BACKEND_ENV = "TRAYCER_DEV_ALLOW_LAN_BACKEND";

const PRIVATE_IPV4_PATTERN =
  /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

function isAllowedDevBackendHost(
  hostname: string,
  env: NodeJS.ProcessEnv,
): boolean {
  if (ALLOWED_DEV_BACKEND_HOSTS.has(hostname)) {
    return true;
  }
  return (
    env[DEV_ALLOW_LAN_BACKEND_ENV] === "1" &&
    PRIVATE_IPV4_PATTERN.test(hostname)
  );
}

// Resolve one backend base URL: the baked literal unless this is a dev build and the env var carries a valid loopback origin.
// Malformed values throw (loudly, at module init) rather than silently falling back - a half-set override that "works" against the wrong backend is much harder to notice than a startup crash naming the bad variable.
export function devBackendUrlFromEnv(
  environment: string,
  envVar: string,
  bakedUrl: string,
  env: NodeJS.ProcessEnv,
): string {
  if (environment !== "dev") return bakedUrl;
  const raw = env[envVar];
  if (raw === undefined || raw.trim().length === 0) return bakedUrl;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${envVar} must be a valid URL`);
  }
  if (url.protocol !== "http:") {
    throw new Error(`${envVar} must use http`);
  }
  if (!isAllowedDevBackendHost(url.hostname, env)) {
    throw new Error(
      `${envVar} must use a loopback host (or a private LAN IPv4 with ${DEV_ALLOW_LAN_BACKEND_ENV}=1)`,
    );
  }
  if (url.port.length === 0) {
    throw new Error(`${envVar} must include a port`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error(`${envVar} must not include credentials`);
  }
  if (url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0) {
    throw new Error(`${envVar} must be an origin URL`);
  }
  return url.origin;
}

export function devRelayBaseUrlFromEnv(
  environment: string,
  envVar: string,
  bakedUrl: string,
  env: NodeJS.ProcessEnv,
): string {
  if (environment !== "dev") return bakedUrl;
  const raw = env[envVar];
  if (raw === undefined || raw.trim().length === 0) return bakedUrl;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${envVar} must be a valid URL`);
  }
  if (url.protocol !== "ws:") {
    throw new Error(`${envVar} must use ws`);
  }
  if (!ALLOWED_DEV_BACKEND_HOSTS.has(url.hostname)) {
    throw new Error(`${envVar} must use a loopback host`);
  }
  if (url.port.length === 0) {
    throw new Error(`${envVar} must include a port`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error(`${envVar} must not include credentials`);
  }
  return url.toString();
}
