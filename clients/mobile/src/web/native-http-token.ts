/**
 * Hands the native layer's per-launch token to Capacitor's own requests for
 * its native routes (`/_capacitor_*`, the native HTTP proxy among them).
 *
 * Those routes are reachable from any frame and any origin the WebView loads,
 * including the sandbox frames agent pages and MCP Apps run in, and a page
 * that reaches the proxy can make native HTTP requests outside CORS. So the
 * native side refuses every such request that lacks the token: the patched
 * `WebViewLocalServer` on Android, `NativeRouteTokenGuard` on iOS. The token
 * reaches only the app's top-level document - a main-frame-only document-start
 * script on both platforms - so a sandboxed page never holds it.
 *
 * It travels as a query parameter, not a header, because both platforms build
 * the outgoing request from the `u` parameter alone while forwarding every
 * request header: a header would leave the device.
 *
 * Capacitor's fetch and XHR patches call `CapacitorWebFetch` and
 * `CapacitorWebXMLHttpRequest.open` by name on every request, so wrapping
 * those two after its bridge script has run covers every proxied request.
 */
export const NATIVE_HTTP_TOKEN_GLOBAL = "__traycerNativeHttpToken";
export const NATIVE_HTTP_TOKEN_PARAM = "traycer_native_http_token";

const NATIVE_ROUTE_PREFIX = "/_capacitor_";

/**
 * `url` with the token added when it names a native route on the native
 * server - the origin Capacitor builds its proxy URLs from
 * (`Capacitor.getServerUrl()`). That is not always the document's origin:
 * under iOS live reload the document is the HTTP dev server while the native
 * routes stay on `capacitor://localhost`. A relative URL resolves against the
 * document, as the request itself would.
 */
export function withNativeHttpToken(
  url: string,
  token: string,
  nativeServerUrl: string,
  documentUrl: string,
): string {
  let parsed: URL;
  let native: URL;
  try {
    parsed = new URL(url, documentUrl);
    native = new URL(nativeServerUrl);
  } catch {
    return url;
  }
  // Compared by protocol and host: `origin` is "null" for `capacitor:`.
  const onNativeServer =
    parsed.protocol === native.protocol && parsed.host === native.host;
  if (!onNativeServer || !parsed.pathname.startsWith(NATIVE_ROUTE_PREFIX)) {
    return url;
  }
  parsed.searchParams.set(NATIVE_HTTP_TOKEN_PARAM, token);
  return parsed.href;
}

/** The native server URL Capacitor's bridge reports, or `null` without one. */
function nativeServerUrlOf(win: Window): string | null {
  const capacitor: unknown = Reflect.get(win, "Capacitor");
  if (!isRecord(capacitor)) return null;
  const getServerUrl = capacitor.getServerUrl;
  if (typeof getServerUrl !== "function") return null;
  const url: unknown = Reflect.apply(getServerUrl, capacitor, []);
  return typeof url === "string" && url.length > 0 ? url : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Returns whether the token and the native server URL were found and
 * Capacitor's request paths wrapped.
 */
export function installNativeHttpToken(win: Window): boolean {
  const token: unknown = Reflect.get(win, NATIVE_HTTP_TOKEN_GLOBAL);
  const nativeServerUrl = nativeServerUrlOf(win);
  if (typeof token !== "string" || nativeServerUrl === null) return false;
  const tokenize = (url: string): string =>
    withNativeHttpToken(url, token, nativeServerUrl, win.location.href);

  const fetchImpl: unknown = Reflect.get(win, "CapacitorWebFetch");
  if (typeof fetchImpl === "function") {
    const wrapped = (input: unknown, init: unknown): unknown => {
      let target = input;
      if (typeof input === "string") target = tokenize(input);
      else if (input instanceof URL) target = tokenize(input.href);
      else if (input instanceof Request) {
        target = new Request(tokenize(input.url), input);
      }
      return Reflect.apply(fetchImpl, win, [target, init]);
    };
    Reflect.set(win, "CapacitorWebFetch", wrapped);
  }

  const xhr: unknown = Reflect.get(win, "CapacitorWebXMLHttpRequest");
  const open: unknown = isRecord(xhr) ? xhr.open : undefined;
  if (isRecord(xhr) && typeof open === "function") {
    xhr.open = function (
      this: XMLHttpRequest,
      method: unknown,
      url: unknown,
      ...rest: unknown[]
    ): unknown {
      const target =
        typeof url === "string"
          ? tokenize(url)
          : url instanceof URL
            ? tokenize(url.href)
            : url;
      return Reflect.apply(open, this, [method, target, ...rest]);
    };
  }
  return true;
}
