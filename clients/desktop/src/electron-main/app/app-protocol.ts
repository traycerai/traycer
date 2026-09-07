import { protocol, net } from "electron";
import { pathToFileURL } from "node:url";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { isDevBuild } from "../../config";
import { log } from "./logger";

export const APP_SCHEME = "app";
const APP_HOST = "renderer";

/** Must be called before `app.whenReady()` or Chromium initializes without the scheme and `protocol.handle` becomes a no-op. */
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

function resolveRendererRoot(): string {
  return isDevBuild
    ? join(__dirname, "..", "renderer")
    : join(process.resourcesPath, "renderer");
}

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
