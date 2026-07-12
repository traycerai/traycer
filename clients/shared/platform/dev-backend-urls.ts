/**
 * Dev-only backend URL overrides for `make dev-desktop` multi-run stacks,
 * shared so the CLI and Desktop `config.ts` can never diverge on the env
 * contract (names + validation). The internal host mirrors this exact
 * contract in its own `config.ts` (separate repo, no shared import).
 *
 * The override is honored ONLY when the build's baked `environment` is
 * `"dev"` - for staging/production builds the lookup is dead code, so a
 * hostile or stray runtime environment cannot repoint a shipped build.
 * Within dev builds the value is restricted to either:
 *   - a loopback http origin (local multi-run stacks), or
 *   - an origin listed in `TRAYCER_DEV_ALLOWED_BACKEND_ORIGINS` (JSON array
 *     of origin strings), which the internal orchestrator sets for
 *     `--use-staging-backend` without hardcoding remote hosts in OSS.
 *
 * Kept free of `electron`/`node:*` imports so preload bundles can pull it
 * in via `config.ts` without importing anything main-process-owned.
 */

export const DEV_AUTHN_BASE_URL_ENV = "TRAYCER_DEV_AUTHN_BASE_URL";
export const DEV_CLOUD_UI_BASE_URL_ENV = "TRAYCER_DEV_CLOUD_UI_BASE_URL";
/** JSON array of https origins the orchestrator may inject (dev builds only). */
export const DEV_ALLOWED_BACKEND_ORIGINS_ENV =
  "TRAYCER_DEV_ALLOWED_BACKEND_ORIGINS";

const ALLOWED_DEV_BACKEND_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
]);

// Parse the orchestrator-supplied allowlist once per lookup. Empty / unset
// means only loopback is permitted - the OSS default for a plain checkout.
export function allowedDevBackendOriginsFromEnv(
  env: NodeJS.ProcessEnv,
): ReadonlySet<string> {
  const raw = env[DEV_ALLOWED_BACKEND_ORIGINS_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    return new Set();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${DEV_ALLOWED_BACKEND_ORIGINS_ENV} must be a JSON array of origin strings`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `${DEV_ALLOWED_BACKEND_ORIGINS_ENV} must be a JSON array of origin strings`,
    );
  }
  const origins = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(
        `${DEV_ALLOWED_BACKEND_ORIGINS_ENV} must be a JSON array of origin strings`,
      );
    }
    let url: URL;
    try {
      url = new URL(entry.trim());
    } catch {
      throw new Error(
        `${DEV_ALLOWED_BACKEND_ORIGINS_ENV} entry must be a valid URL`,
      );
    }
    if (url.protocol !== "https:") {
      throw new Error(
        `${DEV_ALLOWED_BACKEND_ORIGINS_ENV} entries must use https`,
      );
    }
    if (url.username.length > 0 || url.password.length > 0) {
      throw new Error(
        `${DEV_ALLOWED_BACKEND_ORIGINS_ENV} entries must not include credentials`,
      );
    }
    if (url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0) {
      throw new Error(
        `${DEV_ALLOWED_BACKEND_ORIGINS_ENV} entries must be origin URLs`,
      );
    }
    origins.add(url.origin);
  }
  return origins;
}

// Resolve one backend base URL: the baked literal unless this is a dev
// build AND the env var carries a valid allowed origin. Malformed values
// throw (loudly, at module init) rather than silently falling back - a
// half-set override that "works" against the wrong backend is much harder
// to notice than a startup crash naming the bad variable.
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
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error(`${envVar} must not include credentials`);
  }
  if (url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0) {
    throw new Error(`${envVar} must be an origin URL`);
  }

  // Orchestrator-supplied allowlist (e.g. internal staging) - no hostnames
  // are hard-coded in this OSS module.
  if (
    url.protocol === "https:" &&
    allowedDevBackendOriginsFromEnv(env).has(url.origin)
  ) {
    return url.origin;
  }

  // Local multi-run stacks: loopback http with an explicit port.
  if (url.protocol !== "http:") {
    throw new Error(
      `${envVar} must use http (loopback) or an origin listed in ${DEV_ALLOWED_BACKEND_ORIGINS_ENV}`,
    );
  }
  if (!ALLOWED_DEV_BACKEND_HOSTS.has(url.hostname)) {
    throw new Error(
      `${envVar} must use a loopback host or an origin listed in ${DEV_ALLOWED_BACKEND_ORIGINS_ENV}`,
    );
  }
  if (url.port.length === 0) {
    throw new Error(`${envVar} must include a port`);
  }
  return url.origin;
}
