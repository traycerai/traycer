import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
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
    evidence: NO_TRANSPORT_EVIDENCE,
  });
}

describe("createRemoteHostTransport bearer gate", () => {
  it("refuses to build - and so to cache - a session with no auth context", () => {
    // The bearer thunk is a live read, so a session built while it is null
    // could later dial once a context appears, while keyed under an epoch
    // label divorced from that context. Building must degrade to the same
    // `null` as an unconnectable target, not mint a cache entry.
    expect(transportFor(null)).toBeNull();

    // A RELEASED lease is the same verdict through a different shape: the
    // source object survives (still labelling the retired epoch) but its
    // bearer read throws. Letting it into the cache would present the stale
    // epoch as newest and supersede the live context's entry, while the
    // session it builds could never mint.
    const releasedSource: OpenFrameBearerSource = {
      getBearerToken: () => {
        throw new Error("credential lease released");
      },
      identity: { userId: "user-null-bearer-test" },
    };
    expect(transportFor(releasedSource)).toBeNull();

    // The third enumerated refusal: a source that reads fine but holds an
    // EMPTY token. It cannot authorize a grant mint any more than a released
    // lease can - only the failure would come later, from authn, after the
    // session was already cached under that epoch.
    const emptyTokenSource: OpenFrameBearerSource = {
      getBearerToken: () => "",
      identity: { userId: "user-null-bearer-test" },
    };
    expect(transportFor(emptyTokenSource)).toBeNull();

    // Non-vacuity contrast: the identical options WITH a live auth context
    // build fine - the null verdicts above came from the bearer gate, not
    // from some other option being malformed.
    const bearerSource: OpenFrameBearerSource = {
      getBearerToken: () => "bearer-token",
      identity: { userId: "user-null-bearer-test" },
    };
    const built = transportFor(bearerSource);
    expect(built).not.toBeNull();
    built?.session.close();
  });
});
