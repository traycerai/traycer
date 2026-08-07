import { describe, expect, it } from "vitest";
import { defineVersionedRpcRegistry } from "@traycer/protocol/framework/index";
import { defineVersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { OpenFrameBearerSource } from "../../../auth/bearer-source";
import { createRemoteHostTransport } from "../create-remote-transport";

const emptyRpcRegistry: VersionedRpcRegistry = defineVersionedRpcRegistry({});
const emptyStreamRegistry: VersionedStreamRpcRegistry =
  defineVersionedStreamRpcRegistry({});

// 32 bytes of hex - a well-formed host static key, so the bearer gate under
// test is what decides the outcome, not key parsing.
const VALID_PUBLIC_KEY = "ab".repeat(32);

function transportFor(bearerSource: OpenFrameBearerSource | null) {
  return createRemoteHostTransport<
    VersionedRpcRegistry,
    VersionedStreamRpcRegistry
  >({
    hostId: "host-null-bearer-test",
    userId: "user-null-bearer-test",
    relayAttachUrl: "wss://relay.invalid/attach",
    authnBaseUrl: "https://authn.invalid",
    hostPublicKey: VALID_PUBLIC_KEY,
    bearer: () => bearerSource,
    auth: null,
    rpcRegistry: emptyRpcRegistry,
    streamRegistry: emptyStreamRegistry,
    webSocketFactory: {
      create: () => {
        throw new Error("never dialed by this test");
      },
    },
    requestId: () => "req-1",
  });
}

describe("createRemoteHostTransport bearer gate", () => {
  it("refuses to build - and so to cache - a session with no auth context", () => {
    // The bearer thunk is a live read, so a session built while it is null
    // could later dial once a context appears, while keyed under an epoch
    // label divorced from that context. Building must degrade to the same
    // `null` as an unconnectable target, not mint a cache entry.
    expect(transportFor(null)).toBeNull();

    // Non-vacuity contrast: the identical options WITH an auth context build
    // fine - the null verdict above came from the bearer gate, not from some
    // other option being malformed.
    const bearerSource: OpenFrameBearerSource = {
      getBearerToken: () => "bearer-token",
      identity: { userId: "user-null-bearer-test" },
    };
    const built = transportFor(bearerSource);
    expect(built).not.toBeNull();
    built?.session.close();
  });
});
