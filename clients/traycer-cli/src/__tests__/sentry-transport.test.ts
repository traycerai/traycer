import { once } from "node:events";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  destroySentryTransportRequests,
  trackingHttpModule,
} from "../sentry-transport";

// int#4840. Sentry's node transport installs no request timeout and keeps its
// `http.Agent` private, so a DSN endpoint that accepts the connection and then
// goes quiet leaves a socket alive after `Sentry.close()` has already
// returned. That socket holds the event loop open, so the CLI's "let the loop
// drain" exit never completes and its watchdog force-exits with live handles -
// the exact teardown shape the win32 libuv assertion fires in.
//
// These tests drive a REAL loopback server rather than a stub: the property
// under test is whether an actual socket is released, which a fake request
// object cannot demonstrate.

/**
 * Resolve when the request is fully torn down.
 *
 * Not `events.once(request, "close")`: that installs its own `error` listener
 * and REJECTS on it, and a destroyed request always emits ECONNRESET first.
 */
function closed(request: http.ClientRequest): Promise<void> {
  return new Promise<void>((resolve) => {
    request.once("close", () => resolve());
  });
}

/** Wait until the server is actually holding a request. */
async function awaitInflight(held: readonly unknown[]): Promise<void> {
  while (held.length === 0) await new Promise((r) => setImmediate(r));
}

describe("tracking http module", () => {
  let server: http.Server;
  let origin: string;
  const stalled: http.ServerResponse[] = [];

  beforeEach(async () => {
    server = http.createServer((_req, res) => {
      // Hold every request open; individual tests end the ones they want
      // completed. This is the impaired-endpoint case.
      stalled.push(res);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    destroySentryTransportRequests();
    for (const res of stalled.splice(0)) res.destroy();
    server.close();
    await once(server, "close");
  });

  it("destroys a request the endpoint never answered", async () => {
    const request = trackingHttpModule.request(`${origin}/envelope`, undefined);
    request.on("error", () => {
      // A destroyed request emits ECONNRESET; the point is that it ends.
    });
    request.end();
    // Wait until the server has the request in hand, so "still live" is a fact
    // about a real connection rather than a race with connect().
    await awaitInflight(stalled);

    expect(destroySentryTransportRequests()).toBe(1);

    await closed(request);
    expect(request.destroyed).toBe(true);
  });

  it("does not count a request that already completed", async () => {
    const request = trackingHttpModule.request(`${origin}/envelope`, (res) => {
      // Drain it: an unread body leaves the socket busy and the request never
      // reaches `close`.
      res.resume();
    });
    request.on("error", () => {});
    request.end();
    await awaitInflight(stalled);
    stalled.shift()?.end("ok");
    await closed(request);

    // The `close` listener has to retire the entry, or a long-running command
    // (`host logs --follow`) would accumulate them for the life of the process.
    expect(destroySentryTransportRequests()).toBe(0);
  });

  it("reports nothing to destroy when no request was ever made", () => {
    expect(destroySentryTransportRequests()).toBe(0);
  });

  it("routes by protocol rather than assuming https", async () => {
    // Sentry passes one `httpModule` for both schemes and picks the native
    // module by DSN protocol itself; this wrapper has to make the same choice
    // or every http DSN would be dialled as TLS.
    const request = trackingHttpModule.request(
      {
        protocol: "http:",
        hostname: "127.0.0.1",
        port: new URL(origin).port,
        path: "/envelope",
        method: "POST",
      },
      undefined,
    );
    request.on("error", () => {});
    request.end();
    await awaitInflight(stalled);

    expect(destroySentryTransportRequests()).toBe(1);
    await closed(request);
  });
});
