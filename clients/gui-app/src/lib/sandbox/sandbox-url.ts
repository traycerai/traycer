import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { resolveDesktopPlatform } from "@/lib/windows/desktop-capabilities";

/**
 * Where the sandbox loader lives for this client. Every agent page, wireframe
 * and MCP App loads in it, on an origin of its own, inside an opaque
 * `<iframe sandbox>`.
 *
 * - Desktop: the privileged `traycer-sandbox:` scheme the main process
 *   registers (`electron-main/app/sandbox-protocol.ts`).
 * - The mobile app and any browser tab: the bundled copy at `/sandbox/` on
 *   the app's own origin (`vite/sandbox-assets.ts`). The frame is still
 *   opaque, because the `sandbox` attribute never grants `allow-same-origin`.
 */
export const DESKTOP_SANDBOX_LOADER_URL = "traycer-sandbox://page/index.html";

export function sandboxLoaderBaseUrl(runnerHost: IRunnerHost | null): string {
  if (runnerHost !== null && resolveDesktopPlatform(runnerHost) !== null) {
    return DESKTOP_SANDBOX_LOADER_URL;
  }
  return new URL("/sandbox/index.html", window.location.href).href;
}

/**
 * The permissions an MCP App may declare. The iframe `allow` attribute and
 * the desktop permission handler are both built from this enum and nothing
 * else.
 */
export const SANDBOX_PERMISSIONS = [
  "camera",
  "microphone",
  "geolocation",
  "clipboard-write",
] as const;

export type SandboxPermission = (typeof SANDBOX_PERMISSIONS)[number];

export function isSandboxPermission(
  value: unknown,
): value is SandboxPermission {
  return SANDBOX_PERMISSIONS.some((permission) => permission === value);
}

/**
 * The loader URL for one frame. Declared permissions ride in `?perm=` so the
 * desktop main process can grant exactly those to this frame's requests.
 */
export function sandboxLoaderUrl(
  baseUrl: string,
  permissions: readonly SandboxPermission[],
): string {
  if (permissions.length === 0) return baseUrl;
  const url = new URL(baseUrl);
  url.searchParams.set("perm", [...new Set(permissions)].join(","));
  return url.href;
}

/**
 * The iframe `allow` attribute for the declared permissions. Each feature is
 * delegated to `*`: the default allowlist, `'src'`, names the loader URL's
 * origin, which never matches the opaque origin a sandboxed frame actually
 * has, so the feature would stay off. `*` reaches only this frame's document;
 * a page's own iframes need an `allow` of their own.
 */
export function sandboxAllowAttribute(
  permissions: readonly SandboxPermission[],
): string {
  return [...new Set(permissions)].map((name) => `${name} *`).join("; ");
}
