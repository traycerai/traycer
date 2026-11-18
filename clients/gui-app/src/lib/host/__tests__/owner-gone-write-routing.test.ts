import { beforeEach, describe, expect, it } from "vitest";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  pickLiveHostId,
  recordWriteServingHostId,
  routeOwnerGoneWrite,
} from "@/lib/host/owner-gone-write-routing";
import type { SurfacePinFleetView } from "@/stores/host/surface-host-selection-store";

function ready(hostId: string): HostLeaseSnapshot {
  return { hostId, status: "ready", dead: null };
}
function degraded(hostId: string): HostLeaseSnapshot {
  return { hostId, status: "degraded", dead: null };
}
function connecting(hostId: string): HostLeaseSnapshot {
  return { hostId, status: "connecting", dead: null };
}
function restarting(hostId: string): HostLeaseSnapshot {
  return { hostId, status: "restarting-expected", dead: null };
}
function dead(hostId: string): HostLeaseSnapshot {
  return { hostId, status: "dead", dead: { reason: "offline" } };
}

function fleet(...leases: HostLeaseSnapshot[]): SurfacePinFleetView {
  return { authorityAttached: true, leases };
}

const preferNothing = (): readonly (string | null)[] => [];
const acceptAny = (): boolean => true;

describe("routeOwnerGoneWrite", () => {
  it("keeps the owner while its lease can serve", () => {
    expect(
      routeOwnerGoneWrite({
        ownerHostId: "owner",
        fleet: fleet(ready("owner"), ready("session")),
        preferredHostIds: () => ["session"],
        fallbackAccepts: acceptAny,
      }),
    ).toEqual({ hostId: "owner", fellBack: false });
  });

  it("keeps the owner while its lease is only connecting or restarting - no evidence is not death", () => {
    for (const ownerLease of [connecting("owner"), restarting("owner")]) {
      expect(
        routeOwnerGoneWrite({
          ownerHostId: "owner",
          fleet: fleet(ownerLease, ready("session")),
          preferredHostIds: () => ["session"],
          fallbackAccepts: acceptAny,
        }),
      ).toEqual({ hostId: "owner", fellBack: false });
    }
  });

  it("does not read the preferred hosts unless the owner is down", () => {
    let read = false;
    routeOwnerGoneWrite({
      ownerHostId: "owner",
      fleet: fleet(ready("owner")),
      preferredHostIds: () => {
        read = true;
        return [];
      },
      fallbackAccepts: acceptAny,
    });
    expect(read).toBe(false);
  });

  it("sends to the session host first when the owner's lease is dead", () => {
    expect(
      routeOwnerGoneWrite({
        ownerHostId: "owner",
        fleet: fleet(dead("owner"), ready("other"), ready("session")),
        preferredHostIds: () => ["session", "local"],
        fallbackAccepts: acceptAny,
      }),
    ).toEqual({ hostId: "session", fellBack: true });
  });

  it("falls to this machine's host when the session host is down too", () => {
    expect(
      routeOwnerGoneWrite({
        ownerHostId: "owner",
        fleet: fleet(
          dead("owner"),
          dead("session"),
          ready("other"),
          degraded("local"),
        ),
        preferredHostIds: () => ["session", "local"],
        fallbackAccepts: acceptAny,
      }),
    ).toEqual({ hostId: "local", fellBack: true });
  });

  it("falls to any other live host of the fleet, in the authority's order", () => {
    expect(
      routeOwnerGoneWrite({
        ownerHostId: "owner",
        fleet: fleet(
          dead("owner"),
          connecting("first"),
          restarting("second"),
          ready("third"),
          ready("fourth"),
        ),
        preferredHostIds: () => [null, null],
        fallbackAccepts: acceptAny,
      }),
    ).toEqual({ hostId: "third", fellBack: true });
  });

  it("treats an owner missing from a known fleet as gone", () => {
    expect(
      routeOwnerGoneWrite({
        ownerHostId: "deregistered",
        fleet: fleet(ready("session")),
        preferredHostIds: () => ["session"],
        fallbackAccepts: acceptAny,
      }),
    ).toEqual({ hostId: "session", fellBack: true });
  });

  it("keeps the owner when no other host is live - today's behaviour", () => {
    expect(
      routeOwnerGoneWrite({
        ownerHostId: "owner",
        fleet: fleet(dead("owner"), connecting("session"), dead("other")),
        preferredHostIds: () => ["session"],
        fallbackAccepts: acceptAny,
      }),
    ).toEqual({ hostId: "owner", fellBack: false });
  });

  it("keeps the owner before the authority attaches, and while it has published no fleet", () => {
    expect(
      routeOwnerGoneWrite({
        ownerHostId: "owner",
        fleet: { authorityAttached: false, leases: [ready("session")] },
        preferredHostIds: () => ["session"],
        fallbackAccepts: acceptAny,
      }),
    ).toEqual({ hostId: "owner", fellBack: false });
    expect(
      routeOwnerGoneWrite({
        ownerHostId: "owner",
        fleet: { authorityAttached: true, leases: [] },
        preferredHostIds: preferNothing,
        fallbackAccepts: acceptAny,
      }),
    ).toEqual({ hostId: "owner", fellBack: false });
  });
});

describe("routeOwnerGoneWrite fallbackAccepts", () => {
  it("passes over a live host the write cannot use for a later one that can", () => {
    expect(
      routeOwnerGoneWrite({
        ownerHostId: "owner",
        fleet: fleet(dead("owner"), ready("session"), ready("other")),
        preferredHostIds: () => ["session"],
        fallbackAccepts: (hostId) => hostId === "other",
      }),
    ).toEqual({ hostId: "other", fellBack: true });
  });

  it("keeps the owner when no live host is accepted", () => {
    expect(
      routeOwnerGoneWrite({
        ownerHostId: "owner",
        fleet: fleet(dead("owner"), ready("session")),
        preferredHostIds: () => ["session"],
        fallbackAccepts: () => false,
      }),
    ).toEqual({ hostId: "owner", fellBack: false });
  });
});

describe("recordWriteServingHostId", () => {
  beforeEach(() => {
    resetNegotiatedManifests();
  });

  function negotiated(hostId: string, method: string, minor: number): void {
    recordNegotiatedHostManifest(hostId, {
      [method]: { major: 1, minor, supportedMajors: [1] },
    });
  }

  it("skips a live stand-in that negotiated only the owner-only minor, in a mixed-version fleet", () => {
    negotiated("session", "epic.setChatArchived", 0);
    negotiated("other", "epic.setChatArchived", 1);
    expect(
      recordWriteServingHostId({
        ownerHostId: "owner",
        method: "epic.setChatArchived",
        fleet: fleet(dead("owner"), ready("session"), ready("other")),
        preferredHostIds: () => ["session"],
      }),
    ).toBe("other");
  });

  it("holds each method to its own minor: delete of a chat needs 1.2", () => {
    negotiated("session", "epic.deleteChat", 1);
    negotiated("other", "epic.deleteChat", 2);
    expect(
      recordWriteServingHostId({
        ownerHostId: "owner",
        method: "epic.deleteChat",
        fleet: fleet(dead("owner"), ready("session"), ready("other")),
        preferredHostIds: () => ["session"],
      }),
    ).toBe("other");
  });

  it("fails closed for a stand-in with no handshake yet, keeping the owner", () => {
    expect(
      recordWriteServingHostId({
        ownerHostId: "owner",
        method: "epic.deleteTuiAgent",
        fleet: fleet(dead("owner"), ready("session")),
        preferredHostIds: () => ["session"],
      }),
    ).toBe("owner");
  });

  it("answers a stand-in when the owner is down and never handshook with this renderer", () => {
    // The owner has no manifest here at all; only the stand-in's matters.
    negotiated("session", "epic.setChatArchived", 1);
    expect(
      recordWriteServingHostId({
        ownerHostId: "owner",
        method: "epic.setChatArchived",
        fleet: fleet(dead("owner"), ready("session")),
        preferredHostIds: () => ["session"],
      }),
    ).toBe("session");
  });

  it("keeps a serving owner whatever the manifests say", () => {
    negotiated("session", "epic.setChatArchived", 1);
    expect(
      recordWriteServingHostId({
        ownerHostId: "owner",
        method: "epic.setChatArchived",
        fleet: fleet(ready("owner"), ready("session")),
        preferredHostIds: () => ["session"],
      }),
    ).toBe("owner");
  });
});

describe("pickLiveHostId", () => {
  it("never answers the excluded host, even when it is preferred and ready", () => {
    expect(
      pickLiveHostId(
        ["owner"],
        fleet(ready("owner"), ready("b")),
        "owner",
        acceptAny,
      ),
    ).toBe("b");
  });

  it("answers null with no live host", () => {
    expect(
      pickLiveHostId(
        ["a"],
        fleet(connecting("a"), dead("b")),
        "owner",
        acceptAny,
      ),
    ).toBeNull();
  });
});
