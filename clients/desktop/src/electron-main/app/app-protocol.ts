import { protocol, net } from "electron";
import { pathToFileURL } from "node:url";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { isDevBuild } from "../../config";
import { log } from "./logger";

export const APP_SCHEME = "app";
const APP_HOST = "renderer";

/**
 * Pre-`whenReady` registration of the `app://` scheme as privileged. Must
 * be called before `app.whenReady()` or Chromium initializes without the
 * scheme and `protocol.handle` becomes a no-op.
 *
 * `standard: true` is required for relative path resolution to work like
 * `https://` does. `secure: true` exempts the scheme from mixed-content
 * blocking. `supportFetchAPI` and `corsEnabled` keep fetch/import paths
 * inside the renderer working. `stream: true` enables ReadableStream
 * responses (required for large assets to stream).
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        bypassCSP: false,
      },
    },
  ]);
}

/**
 * Resolves the on-disk root that `app://renderer/...` serves out of.
 *
 *   - Shipped (staging/production): `<process.resourcesPath>/renderer`,
 *     populated by electron-builder's `extraResources` mapping.
 *   - Dev slot: the bundle runs from `dist/main`, so the renderer build
 *     sits at `../renderer` relative to it.
 */
function resolveRendererRoot(): string {
  return isDevBuild
    ? join(__dirname, "..", "renderer")
    : join(process.resourcesPath, "renderer");
}

/**
 * Post-`whenReady` registration of the `app://` handler. Serves files
 * under the renderer dist root. Path-traversal defense: every requested
 * path is resolved and rejected if it escapes the renderer root.
 */
export function installAppProtocolHandler(): void {
  const rendererRoot = resolveRendererRoot();
  protocol.handle(APP_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    if (url.host !== APP_HOST) {
      log.warn("[app-protocol] unknown host", { url: request.url });
      return new Response("not found", { status: 404 });
    }
    const requestedPath = decodeURIComponent(url.pathname);
    const normalized = normalize(requestedPath).replace(/^[\\/]+/, "");
    const resolved = resolve(rendererRoot, normalized);
    // Path-traversal defense: use `path.relative` rather than a string
    // `startsWith` check so we correctly reject sibling-directory escapes
    // (e.g. `rendererRoot = /var/foo`, `resolved = /var/foobar/...`)
    // which prefix-match the renderer root string without being inside it.
    const rel = relative(rendererRoot, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      log.warn("[app-protocol] path traversal blocked", {
        requestedPath,
      });
      return new Response("forbidden", { status: 403 });
    }
    // Do not serve index.html for arbitrary paths. Desktop app routes travel
    // through preload bootstrap args; app:// remains a strict file server so
    // missing assets fail as real 404s instead of returning the SPA shell.
    const finalPath =
      normalized === "" || normalized === "/"
        ? resolve(rendererRoot, "index.html")
        : resolved;
    try {
      return await net.fetch(pathToFileURL(finalPath).toString());
    } catch (err) {
      log.warn("[app-protocol] fetch failed", { finalPath, err });
      return new Response("not found", { status: 404 });
    }
  });
  log.debug("[app-protocol] handler installed", { rendererRoot });
}

export function buildAppUrl(): string {
  return `app://${APP_HOST}/`;
}
