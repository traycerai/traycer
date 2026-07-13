/**
 * Dev renderer URL/origin resolution for the main process
 * (`electron-main/app/security.ts`, `electron-main/windows/window-factory.ts`).
 * Kept free of `electron`/`node:*` imports so preload-side bundles could pull
 * it in as well if one ever needs the dev origin again.
 */

export const TRAYCER_DESKTOP_DEV_URL_ENV = "TRAYCER_DESKTOP_DEV_URL";
export const DEFAULT_DEV_RENDERER_URL = "http://localhost:5173";

const ALLOWED_DEV_RENDERER_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
]);

export function devRendererUrlFromEnv(env: NodeJS.ProcessEnv): string {
  const raw = env[TRAYCER_DESKTOP_DEV_URL_ENV] ?? DEFAULT_DEV_RENDERER_URL;
  return normalizeDevRendererUrl(raw);
}

export function devRendererOriginFromEnv(env: NodeJS.ProcessEnv): string {
  return new URL(devRendererUrlFromEnv(env)).origin;
}

export function normalizeDevRendererUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${TRAYCER_DESKTOP_DEV_URL_ENV} must be a valid URL`);
  }
  if (url.protocol !== "http:") {
    throw new Error(`${TRAYCER_DESKTOP_DEV_URL_ENV} must use http`);
  }
  if (!ALLOWED_DEV_RENDERER_HOSTS.has(url.hostname)) {
    throw new Error(`${TRAYCER_DESKTOP_DEV_URL_ENV} must use a loopback host`);
  }
  if (url.port.length === 0) {
    throw new Error(`${TRAYCER_DESKTOP_DEV_URL_ENV} must include a port`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error(
      `${TRAYCER_DESKTOP_DEV_URL_ENV} must not include credentials`,
    );
  }
  if (url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0) {
    throw new Error(`${TRAYCER_DESKTOP_DEV_URL_ENV} must be an origin URL`);
  }
  return url.origin;
}
