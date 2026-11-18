import type { ClientRequest, IncomingMessage } from "node:http";
import * as http from "node:http";
import type { RequestOptions as HttpRequestOptions } from "node:http";
import * as https from "node:https";
import type { RequestOptions as HttpsRequestOptions } from "node:https";

// Sentry's node transport owns an `http.Agent` we cannot reach, and its request
// path installs no timeout - `req.on("error", reject)` is the only listener
// (see @sentry/node-core transports/http.js). So an endpoint that accepts the
// TCP connection and then never answers leaves a live socket behind FOREVER.
//
// That matters here because of int#4840. `Sentry.close(timeout)` reads as
// "shut the client down", but in Sentry 10.x it is `flush(timeout)` followed by
// `enabled = false`: it drains the event QUEUE and returns, leaving in-flight
// HTTP requests running. Measured on the real SEA against a stalling loopback
// DSN: `close(2000)` returned `false` with two transport sockets still live,
// and they were still live 5s later. Those sockets hold the event loop open,
// so "let the loop drain" never completes and the drain watchdog force-exits
// with live handles - which is the exact abrupt-teardown shape the win32 libuv
// assertion fires in. The fix would have reintroduced the bug on the error
// path.
//
// `httpModule` is the supported injection point (`NodeTransportOptions`), so
// the CLI hands Sentry a module that remembers the requests it opens and can
// destroy the ones still outstanding when the process is ready to end.

const liveRequests = new Set<ClientRequest>();

// Narrowed to the one member used here. `typeof http` and `typeof https` are
// not mutually assignable - they differ in their `Agent`/`Server` exports - so
// a shared return type has to name what is actually called.
interface RequestCapableModule {
  request(
    options: HttpRequestOptions | HttpsRequestOptions | string | URL,
    callback: ((res: IncomingMessage) => void) | undefined,
  ): ClientRequest;
}

function moduleForProtocol(
  protocol: string | null | undefined,
): RequestCapableModule {
  return protocol === "http:" ? http : https;
}

function protocolOf(
  options: HttpRequestOptions | HttpsRequestOptions | string | URL,
): string | null {
  if (typeof options === "string") return new URL(options).protocol;
  if (options instanceof URL) return options.protocol;
  return options.protocol ?? null;
}

/**
 * Drop-in for the native `http`/`https` module that records every request it
 * opens, so teardown can retire sockets Sentry itself will not.
 *
 * Deliberately NOT a general-purpose http wrapper: it is passed only to
 * `Sentry.init`'s `transportOptions.httpModule` and therefore only ever sees
 * envelope POSTs to the DSN.
 */
export const trackingHttpModule = {
  request(
    options: HttpRequestOptions | HttpsRequestOptions | string | URL,
    // Explicit `| undefined` rather than `?:` (repo lint rule). Sentry's
    // `HTTPModule` declares it optional and always passes one, so this stays
    // structurally assignable there.
    callback: ((res: IncomingMessage) => void) | undefined,
  ): ClientRequest {
    const request = moduleForProtocol(protocolOf(options)).request(
      options,
      callback,
    );
    liveRequests.add(request);
    // `close` fires for success, error, and destroy alike, so the set cannot
    // leak entries for a long-lived process (`host logs --follow`).
    request.once("close", () => {
      liveRequests.delete(request);
    });
    return request;
  },
};

/**
 * Destroy any Sentry envelope request still outstanding, releasing the sockets
 * that would otherwise hold the event loop open past `Sentry.close()`.
 *
 * Returns how many were still live, so the caller can report a teardown that
 * needed forcing rather than swallowing it.
 */
export function destroySentryTransportRequests(): number {
  const outstanding = liveRequests.size;
  for (const request of liveRequests) {
    try {
      request.destroy();
    } catch {
      // Already torn down by the runtime; nothing left to release.
    }
  }
  liveRequests.clear();
  return outstanding;
}
