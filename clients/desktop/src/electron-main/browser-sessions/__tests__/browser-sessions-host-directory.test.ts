import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListFetchResult } from "@traycer-clients/shared/host-client/remote-fetcher";
import { createBrowserSessionsHostDirectory } from "../browser-sessions-transport";

/**
 * Main resolves a host id itself (H10 ruling 1).
 *
 * The renderer passes an ID and nothing else, because a directory row carries
 * the host's static Noise key: a renderer-supplied row would let a compromised
 * renderer aim main's jar stream at a host it controls, which is the whole
 * ticket. These pin that the resolution happens here, off main's own local-host
 * snapshot and main's own bearer.
 */

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

function remoteResponse(hostId: string): HostListFetchResult {
  return {
    kind: "ok",
    response: {
      hosts: [
        {
          hostId,
          displayName: "Remote",
          platform: "linux",
          kind: "personal",
          publicKey: "cHVibGljS2V5",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatePolicy: "auto",
          status: {
            connectivity: "connectable",
            viewerReachability: "ok",
            clientCloud: "ok",
            updateState: "current",
            appVersion: "1.2.3",
            lastSeenAt: null,
          },
        },
      ],
    },
  };
}

let now = 0;

describe("main resolves the browser.sessions host itself", () => {
  beforeEach(() => {
    now = 1_000_000;
  });

  it("answers this machine's own host from the live local snapshot", async () => {
    const listRegisteredHosts = vi.fn(() =>
      Promise.resolve<HostListFetchResult>({ kind: "network-error" }),
    );
    let websocketUrl = "ws://127.0.0.1:1111";
    const directory = createBrowserSessionsHostDirectory({
      authnBaseUrl: () => "https://authn.test",
      relayBaseUrl: "wss://relay.test/attach",
      localHost: () => ({ hostId: "host-1", websocketUrl, version: "1.0.0" }),
      bearerToken: () => "bearer",
      listRegisteredHosts,
      now: () => now,
    });

    const entry = await directory.resolve("host-1");

    expect(entry?.kind).toBe("local");
    expect(entry?.websocketUrl).toBe("ws://127.0.0.1:1111");
    // The registry is not consulted for this machine's own host.
    expect(listRegisteredHosts).not.toHaveBeenCalled();

    // The address is re-read on every dial: a host that respawns on a new port
    // is followed instead of retried forever at the dead one.
    websocketUrl = "ws://127.0.0.1:2222";
    expect(directory.endpoint("host-1")).toEqual({
      hostId: "host-1",
      websocketUrl: "ws://127.0.0.1:2222",
    });
  });

  it("reads the registry with main's own bearer, once, and caches the row", async () => {
    const listRegisteredHosts = vi.fn(() =>
      Promise.resolve(remoteResponse("host-2")),
    );
    const directory = createBrowserSessionsHostDirectory({
      authnBaseUrl: () => "https://authn.test",
      relayBaseUrl: "wss://relay.test/attach",
      localHost: () => null,
      bearerToken: () => "bearer",
      listRegisteredHosts,
      now: () => now,
    });

    const first = await directory.resolve("host-2");
    const second = await directory.resolve("host-2");

    expect(first?.kind).toBe("remote");
    expect(first?.websocketUrl).toBe("wss://relay.test/attach");
    expect(second).toBe(first);
    expect(listRegisteredHosts).toHaveBeenCalledTimes(1);
    expect(listRegisteredHosts).toHaveBeenCalledWith(
      "https://authn.test",
      "bearer",
    );
  });

  it("answers null for a host the account does not have, without dialing anything", async () => {
    const directory = createBrowserSessionsHostDirectory({
      authnBaseUrl: () => "https://authn.test",
      relayBaseUrl: "wss://relay.test/attach",
      localHost: () => null,
      bearerToken: () => "bearer",
      listRegisteredHosts: () => Promise.resolve(remoteResponse("host-2")),
      now: () => now,
    });

    expect(await directory.resolve("host-impostor")).toBeNull();
    expect(directory.endpoint("host-impostor")).toBeNull();
  });

  it("declines to read the registry while signed out", async () => {
    const listRegisteredHosts = vi.fn(() =>
      Promise.resolve(remoteResponse("host-2")),
    );
    const directory = createBrowserSessionsHostDirectory({
      authnBaseUrl: () => "https://authn.test",
      relayBaseUrl: "wss://relay.test/attach",
      localHost: () => null,
      bearerToken: () => null,
      listRegisteredHosts,
      now: () => now,
    });

    expect(await directory.resolve("host-2")).toBeNull();
    expect(listRegisteredHosts).not.toHaveBeenCalled();
  });

  it("re-reads the registry for a host whose row was invalidated", async () => {
    const listRegisteredHosts = vi.fn(() =>
      Promise.resolve(remoteResponse("host-2")),
    );
    const directory = createBrowserSessionsHostDirectory({
      authnBaseUrl: () => "https://authn.test",
      relayBaseUrl: "wss://relay.test/attach",
      localHost: () => null,
      bearerToken: () => "bearer",
      listRegisteredHosts,
      now: () => now,
    });
    await directory.resolve("host-2");

    // A rotated Noise key and a deregistered host both look like a stream that
    // will not come back, and the row that produced it is frozen into the
    // transport - so an invalidation must re-read even inside the cooldown.
    directory.invalidate("host-2");
    await directory.resolve("host-2");

    expect(listRegisteredHosts).toHaveBeenCalledTimes(2);
  });

  it("drops the whole cache AND the cooldown when the identity changes", async () => {
    const listRegisteredHosts = vi.fn(() =>
      Promise.resolve(remoteResponse("host-2")),
    );
    const directory = createBrowserSessionsHostDirectory({
      authnBaseUrl: () => "https://authn.test",
      relayBaseUrl: "wss://relay.test/attach",
      localHost: () => null,
      bearerToken: () => "bearer",
      listRegisteredHosts,
      now: () => now,
    });
    await directory.resolve("host-2");
    expect(listRegisteredHosts).toHaveBeenCalledTimes(1);

    // The rows are per ACCOUNT but the cache is keyed by host id alone, so a
    // sign-out or an account switch would otherwise let the next account dial
    // the previous account's row for the same id. The cooldown goes with the
    // rows - the clock has not moved here - because a fresh identity is
    // exactly the moment one read is owed rather than deferred.
    directory.reset();
    await directory.resolve("host-2");

    expect(listRegisteredHosts).toHaveBeenCalledTimes(2);
  });

  it("answers a looped unknown id from cache instead of amplifying it to authn", async () => {
    const listRegisteredHosts = vi.fn(() =>
      Promise.resolve(remoteResponse("host-2")),
    );
    const directory = createBrowserSessionsHostDirectory({
      authnBaseUrl: () => "https://authn.test",
      relayBaseUrl: "wss://relay.test/attach",
      localHost: () => null,
      bearerToken: () => "bearer",
      listRegisteredHosts,
      now: () => now,
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await directory.resolve(`unknown-${attempt}`)).toBeNull();
    }
    expect(listRegisteredHosts).toHaveBeenCalledTimes(1);

    // Past the window the registry is read again, so a host that genuinely
    // appeared since is still learned about.
    now += 30_001;
    expect(await directory.resolve("unknown-late")).toBeNull();
    expect(listRegisteredHosts).toHaveBeenCalledTimes(2);
  });

  it("keeps the floor while the registry is unhealthy", async () => {
    // The failure a rate limit is most needed for: authn is down, every id is
    // a miss, and a renderer looping them would otherwise be one request each.
    const listRegisteredHosts = vi.fn(() =>
      Promise.resolve<HostListFetchResult>({ kind: "network-error" }),
    );
    const directory = createBrowserSessionsHostDirectory({
      authnBaseUrl: () => "https://authn.test",
      relayBaseUrl: "wss://relay.test/attach",
      localHost: () => null,
      bearerToken: () => "bearer",
      listRegisteredHosts,
      now: () => now,
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await directory.resolve(`unknown-${attempt}`)).toBeNull();
    }

    expect(listRegisteredHosts).toHaveBeenCalledTimes(1);
  });

  it("spends one forced read on an invalidation, even when it fails", async () => {
    const listRegisteredHosts = vi.fn(() =>
      Promise.resolve<HostListFetchResult>({ kind: "network-error" }),
    );
    const directory = createBrowserSessionsHostDirectory({
      authnBaseUrl: () => "https://authn.test",
      relayBaseUrl: "wss://relay.test/attach",
      localHost: () => null,
      bearerToken: () => "bearer",
      listRegisteredHosts,
      now: () => now,
    });
    await directory.resolve("host-2");
    expect(listRegisteredHosts).toHaveBeenCalledTimes(1);

    directory.invalidate("host-2");
    await directory.resolve("host-2");
    expect(listRegisteredHosts).toHaveBeenCalledTimes(2);

    // The forced read is SPENT whether or not it succeeded: an invalidation
    // asks for one fresh read, not a standing exemption from the floor.
    await directory.resolve("host-2");
    expect(listRegisteredHosts).toHaveBeenCalledTimes(2);
  });
});
