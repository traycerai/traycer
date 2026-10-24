import type { SandboxArtifactServer } from "./sandbox-artifact-server";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol, type CustomScheme } from "electron";
import { isDevBuild } from "../../config";
import { devRendererOriginFromEnv } from "../../ipc-contracts/dev-renderer-origin";
import { log } from "./logger";

/**
 * The sandbox origin. Every agent page, wireframe and MCP App the renderer
 * shows loads `traycer-sandbox://page/index.html` inside an opaque
 * `<iframe sandbox="allow-scripts allow-forms">`, and the loader there writes
 * the page over itself (gui-app `lib/sandbox/`).
 *
 * The `page` host serves only the loader. Artifact hosts serve bounded spans
 * supplied by the renderer that mounted them. The loader fetches nothing: its script and the Figtree face pages are offered (as a
 * `data:` URL) are inlined into it. It is the file gui-app's
 * `vite/sandbox-assets.ts` emits into `dist/renderer/sandbox/`; in dev it
 * comes from the Vite dev server that plugin also serves it from.
 */
export const SANDBOX_SCHEME = "traycer-sandbox";
export const SANDBOX_HOST = "page";
export const SANDBOX_LOADER_PATH = "/index.html";

/**
 * Registered in the same `registerSchemesAsPrivileged` call as `app://`
 * (Electron keeps only the last raw call). `standard` gives the scheme
 * ordinary URL parsing and `secure` keeps pages a secure context. No
 * `bypassCSP` or service workers. Ranges stream, and artifact pages fetch their
 * own files from an opaque origin. The end-to-end proof must also check that
 * these scheme-wide privileges leave the loader unchanged.
 */
export const SANDBOX_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: SANDBOX_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    stream: true,
    supportFetchAPI: true,
    corsEnabled: true,
  },
};

/**
 * The base policy every sandbox document runs under, sent as a header named
 * exactly `Content-Security-Policy` so a future header hook that writes the
 * same key REPLACES it visibly instead of intersecting it silently. The
 * loader's own `<meta>` carries the same text, and a page's stricter policy
 * is added on top as another meta.
 */
export const SANDBOX_CONTENT_SECURITY_POLICY =
  "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'none'; base-uri 'none'";

/**
 * Permissions a sandbox loader URL may declare in `?perm=`, mapped to the
 * Electron permission each one is requested as. Mirrors gui-app's
 * `SANDBOX_PERMISSIONS`.
 */
export const SANDBOX_PERMISSION_GRANTS: ReadonlyMap<string, string> = new Map([
  ["camera", "media:video"],
  ["microphone", "media:audio"],
  ["geolocation", "geolocation"],
  ["clipboard-write", "clipboard-sanitized-write"],
]);

export function isSandboxUrl(url: string): boolean {
  return url.startsWith(`${SANDBOX_SCHEME}:`);
}

export interface SandboxArtifactHost {
  readonly artifactId: string;
  readonly mountId: string;
}

export function parseSandboxArtifactHost(
  host: string,
): SandboxArtifactHost | null {
  if (!host.startsWith("artifact-")) return null;
  const separator = host.lastIndexOf("--");
  if (separator < "artifact-".length) return null;
  const artifactId = host.slice("artifact-".length, separator);
  const mountId = host.slice(separator + 2);
  return /^[a-z0-9_-]+$/.test(artifactId) && /^[a-z0-9]+$/.test(mountId)
    ? { artifactId, mountId }
    : null;
}

export function isSandboxArtifactUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === `${SANDBOX_SCHEME}:` &&
      parsed.username === "" &&
      parsed.password === "" &&
      parseSandboxArtifactHost(parsed.host) !== null
    );
  } catch {
    return false;
  }
}

/** The loader URL exactly, with any `?perm=` query. */
export function isSandboxLoaderUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === `${SANDBOX_SCHEME}:` &&
    parsed.host === SANDBOX_HOST &&
    parsed.pathname === SANDBOX_LOADER_PATH &&
    parsed.hash === "" &&
    [...parsed.searchParams.keys()].every((key) => key === "perm")
  );
}

/**
 * The permission grants a sandbox loader URL declared, as
 * `SANDBOX_PERMISSION_GRANTS` values. Unknown names grant nothing.
 */
export function sandboxDeclaredGrants(url: string): ReadonlySet<string> {
  if (!isSandboxLoaderUrl(url)) return new Set();
  const declared = new URL(url).searchParams.get("perm") ?? "";
  const grants = new Set<string>();
  for (const name of declared.split(",")) {
    const grant = SANDBOX_PERMISSION_GRANTS.get(name);
    if (grant !== undefined) grants.add(grant);
  }
  return grants;
}

function sandboxFileUrl(fileName: string): string {
  if (isDevBuild) {
    return `${devRendererOriginFromEnv(process.env)}/sandbox/${fileName}`;
  }
  return pathToFileURL(
    join(process.resourcesPath, "renderer", "sandbox", fileName),
  ).toString();
}

/** Post-`whenReady`: loader and mounted artifact files share the sandbox scheme. */
export function installSandboxProtocolHandler(
  server: SandboxArtifactServer,
): void {
  protocol.handle(SANDBOX_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    if (isSandboxArtifactUrl(request.url)) return server.fetch(request);
    if (url.host !== SANDBOX_HOST || url.pathname !== SANDBOX_LOADER_PATH) {
      return new Response("not found", { status: 404 });
    }
    const fileName = url.pathname.slice(1);
    let body: ArrayBuffer;
    try {
      const upstream = await net.fetch(sandboxFileUrl(fileName));
      if (!upstream.ok) throw new Error(`status ${upstream.status}`);
      body = await upstream.arrayBuffer();
    } catch (err) {
      log.warn("[sandbox-protocol] read failed", { fileName, err });
      return new Response("not found", { status: 404 });
    }
    return new Response(body, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": SANDBOX_CONTENT_SECURITY_POLICY,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
      },
    });
  });
  log.debug("[sandbox-protocol] handler installed");
}
