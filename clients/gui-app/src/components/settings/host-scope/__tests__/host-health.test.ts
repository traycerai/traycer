import { describe, expect, it } from "vitest";
import type {
  HostConnectivity,
  HostListItem,
} from "@traycer/protocol/host/host-status";
import type { ServiceStatusSnapshot } from "@traycer-clients/shared/platform/runner-host";
import type {
  HostLeaseDeadState,
  HostLeaseSnapshot,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  HOST_UPDATE_REQUIRED_DETAIL,
  deriveHostHealth,
  hostRowHealth,
  type DeriveHostHealthOptions,
  type HostHealth,
  type HostHealthState,
} from "@/components/settings/host-scope/host-health";

/**
 * `stopped` and `not-installed` are the two health states that name what this
 * machine's own host is doing about itself — being restarted, or being
 * installed — and for a long time nothing could produce them: `useHostScope`
 * passed `undefined` for the installed record, so `deriveStatus` could only
 * answer `running` or nothing, and a stopped local host fell through to its
 * registry connectivity and read "Offline · last seen 3h ago". True about the
 * cloud's answer, useless to someone whose host is sitting right there.
 *
 * Nothing covered `deriveHostHealth` at all, which is how that shipped.
 */

const NOW_MS = 3 * 60 * 60 * 1000;

function registryItem(connectivity: HostConnectivity): HostListItem {
  return {
    hostId: "host-a",
    displayName: "host-a",
    platform: "darwin-arm64",
    kind: "personal",
    publicKey: "pk",
    createdAt: new Date(0).toISOString(),
    updatePolicy: "manual",
    status: {
      connectivity,
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.4.2",
      lastSeenAt: new Date(0).toISOString(),
    },
  };
}

/**
 * No lease, authority not attached — i.e. the DTO is the only evidence there
 * is. That is deliberately the base for this file: everything below is about
 * the LOCAL-SERVICE and CLOUD-DTO steps of the precedence, which are only
 * reached once the lease step has declined. The lease step's own behaviour
 * (including that these two values must never be read as death) is covered in
 * `host-health-lease.test.ts`.
 */
const BASE = {
  item: registryItem("offline"),
  hasLiveSession: false,
  lease: null,
  authorityAttached: false,
  nowMs: NOW_MS,
};

describe("deriveHostHealth — the two actionable local states", () => {
  it("says update-required, not Online, for a RUNNING local host whose lease is dead(incompatible)", () => {
    // The process being right here answers LIVENESS - but incompatibility is
    // not a liveness claim: the host runs AND this app cannot speak to it.
    // Reading it as Online hid the one affordance that fixes it (the update
    // action gates on `update-required`).
    const health = deriveHostHealth({
      ...BASE,
      isLocalMachine: true,
      authorityAttached: true,
      lease: {
        hostId: "host-local",
        status: "dead",
        dead: {
          reason: "incompatible",
          detail: {
            code: "HOST_INCOMPATIBLE",
            hostVersion: "1.0.0",
            minSupportedVersion: "2.0.0",
            clientCompatibility: null,
          },
        },
      },
      service: {
        state: "running",
        version: "1.0.0",
        listenUrl: "ws://127.0.0.1:1",
        pid: 4242,
      },
    });

    expect(health.state).toBe("update-required");
  });

  it("says Stopped, not Offline, for an installed local host that is not running", () => {
    const health = deriveHostHealth({
      ...BASE,
      isLocalMachine: true,
      service: {
        state: "stopped",
        version: "1.4.2",
        listenUrl: null,
        pid: null,
      },
    });

    expect(health.state).toBe("stopped");
    expect(health.label).toBe("Stopped");
    // The distinction that matters: an offline registry row would have said
    // "Offline" and left the reader with nothing to do about it.
    expect(health.label).not.toBe("Offline");
    expect(health.live).toBe(false);
  });

  it("says Not installed when the local machine has no host at all", () => {
    const health = deriveHostHealth({
      ...BASE,
      isLocalMachine: true,
      service: {
        state: "not-installed",
        version: null,
        listenUrl: null,
        pid: null,
      },
    });

    expect(health.state).toBe("not-installed");
    expect(health.label).toBe("Not installed");
  });

  it("lets the local service snapshot outrank a registry saying offline", () => {
    // Firsthand read of the process on this box beats the cloud's connectivity
    // read, even when the cloud thinks the host is offline.
    const health = deriveHostHealth({
      ...BASE,
      isLocalMachine: true,
      service: {
        state: "running",
        version: "1.4.2",
        listenUrl: "ws://127.0.0.1:1/rpc",
        pid: 1,
      },
    });

    expect(health.state).toBe("online");
    expect(health.live).toBe(true);
  });

  it("falls back to the registry while the local snapshot is unresolved", () => {
    // `undefined` means "not answered yet", which must not be read as
    // "not installed" — the registry answer is still better than a guess.
    const health = deriveHostHealth({
      ...BASE,
      isLocalMachine: true,
      service: undefined,
    });

    expect(health.state).not.toBe("not-installed");
    expect(health.state).not.toBe("stopped");
  });

  it("never claims a local-only-machine state for a remote host", () => {
    // `stopped` / `not-installed` describe a service on THIS computer. A
    // remote host has none to inspect, so the snapshot must be ignored.
    const health = deriveHostHealth({
      ...BASE,
      isLocalMachine: false,
      service: {
        state: "stopped",
        version: "1.4.2",
        listenUrl: null,
        pid: null,
      },
    });

    expect(health.state).not.toBe("stopped");
    expect(health.state).not.toBe("not-installed");
  });
});

describe("deriveHostHealth — connectivity mapping for a remote row", () => {
  /**
   * `connectable` is a cloud lease with a 15-minute TTL and nothing in
   * this app has dialled the machine, so the row states the report rather than
   * asserting liveness — and, more importantly, draws NO green dot.
   *
   * The dot is the part this pins hardest. `deriveHostPresence` has always
   * carried the invariant "no green dot without live evidence", and its own
   * `connectable` arm violated it by naming the stale lease as live evidence.
   * A host that died dirty therefore kept a green Online for up to a quarter of
   * an hour, extended further by the 60s keep-warm linger.
   */
  it("maps a never-dialled connectable host to Reported reachable, with NO live dot", () => {
    const health = deriveHostHealth({
      ...BASE,
      item: registryItem("connectable"),
      isLocalMachine: false,
      service: undefined,
    });

    expect(health.state).toBe("reported-reachable");
    expect(health.label).toBe("Reported reachable");
    // The overclaim, in both of its forms.
    expect(health.label).not.toBe("Online");
    expect(health.live).toBe(false);
    // Not a fault either — nothing is wrong, we simply have not looked.
    expect(health.tone).toBe("idle");
  });

  it("maps an offline host with a recent check-in to Offline — there is no Local only state", () => {
    const item = registryItem("offline");
    const health = deriveHostHealth({
      ...BASE,
      item: {
        ...item,
        status: {
          ...item.status,
          lastSeenAt: new Date(NOW_MS - 20 * 60 * 1000).toISOString(),
        },
      },
      isLocalMachine: false,
      service: undefined,
    });

    expect(health.state).toBe("offline");
    expect(health.label).toBe("Offline");
    expect(health.live).toBe(false);
  });

  it("maps the retired local-only wire value to Status unknown, and never Offline", () => {
    const health = deriveHostHealth({
      ...BASE,
      item: registryItem("local-only"),
      isLocalMachine: false,
      service: undefined,
    });

    expect(health.state).toBe("unknown");
    expect(health.label).toBe("Status unknown");
    expect(health.label).not.toBe("Offline");
    expect(health.live).toBe(false);
  });

  it("maps unknown to Status unknown, and never Offline", () => {
    const health = deriveHostHealth({
      ...BASE,
      item: registryItem("unknown"),
      isLocalMachine: false,
      service: undefined,
    });

    expect(health.state).toBe("unknown");
    expect(health.label).toBe("Status unknown");
    expect(health.label).not.toBe("Offline");
  });

  it("maps offline to Offline, with last-seen in the detail", () => {
    const health = deriveHostHealth({
      ...BASE,
      item: registryItem("offline"),
      isLocalMachine: false,
      service: undefined,
    });

    expect(health.state).toBe("offline");
    expect(health.label).toBe("Offline");
    expect(health.live).toBe(false);
  });

  it("lets live-session evidence outrank a connectivity of offline", () => {
    const health = deriveHostHealth({
      ...BASE,
      item: registryItem("offline"),
      isLocalMachine: false,
      hasLiveSession: true,
      service: undefined,
    });

    expect(health.state).toBe("online");
    expect(health.live).toBe(true);
  });
});

function service(state: ServiceStatusSnapshot["state"]): ServiceStatusSnapshot {
  return {
    state,
    version: state === "not-installed" ? null : "1.4.2",
    listenUrl: state === "running" ? "ws://127.0.0.1:1" : null,
    pid: state === "running" ? 4242 : null,
  };
}

function deadLease(dead: HostLeaseDeadState): HostLeaseSnapshot {
  return { hostId: "host-a", status: "dead", dead };
}

/** A remote computer, the DTO the only evidence, with `overrides` added. */
function ownHealth(overrides: Partial<DeriveHostHealthOptions>): HostHealth {
  return deriveHostHealth({
    ...BASE,
    item: registryItem("connectable"),
    isLocalMachine: false,
    service: undefined,
    ...overrides,
  });
}

function attached(lease: HostLeaseSnapshot): Partial<DeriveHostHealthOptions> {
  return { authorityAttached: true, lease };
}

/** Every health a computer can have when Settings shows it from its row. */
const OWN_HEALTH: readonly {
  readonly evidence: string;
  readonly state: HostHealthState;
  readonly own: HostHealth;
}[] = [
  {
    evidence: "this machine's running service",
    state: "online",
    own: ownHealth({ isLocalMachine: true, service: service("running") }),
  },
  {
    evidence: "a ready lease",
    state: "online",
    own: ownHealth(attached({ hostId: "host-a", status: "ready", dead: null })),
  },
  {
    evidence: "a degraded lease",
    state: "online",
    own: ownHealth(
      attached({ hostId: "host-a", status: "degraded", dead: null }),
    ),
  },
  {
    evidence: "a live session",
    state: "online",
    own: ownHealth({ hasLiveSession: true }),
  },
  {
    evidence: "an account that heard from it",
    state: "reported-reachable",
    own: ownHealth({}),
  },
  {
    evidence: "an expected restart",
    state: "restarting",
    own: ownHealth(
      attached({
        hostId: "host-a",
        status: "restarting-expected",
        dead: null,
      }),
    ),
  },
  {
    evidence: "no account record",
    state: "unknown",
    own: ownHealth({ item: null }),
  },
  {
    evidence: "a blind account read",
    state: "unknown",
    own: ownHealth({ item: registryItem("unknown") }),
  },
  {
    evidence: "an account that says offline",
    state: "offline",
    own: ownHealth({ item: registryItem("offline") }),
  },
  {
    evidence: "a lease dead offline",
    state: "offline",
    own: ownHealth(attached(deadLease({ reason: "offline" }))),
  },
  {
    evidence: "an incompatible lease",
    state: "update-required",
    own: ownHealth(
      attached(
        deadLease({
          reason: "incompatible",
          detail: {
            code: "PROTOCOL_MAJOR_MISMATCH",
            hostVersion: "1.1.4",
            minSupportedVersion: "1.2.0",
            clientCompatibility: null,
          },
        }),
      ),
    ),
  },
  {
    evidence: "a lease dead removed",
    state: "removed",
    own: ownHealth(attached(deadLease({ reason: "removed" }))),
  },
  {
    evidence: "this machine's stopped service",
    state: "stopped",
    own: ownHealth({ isLocalMachine: true, service: service("stopped") }),
  },
  {
    evidence: "this machine with no service",
    state: "not-installed",
    own: ownHealth({ isLocalMachine: true, service: service("not-installed") }),
  },
  {
    evidence: "this client offline",
    state: "viewer-offline",
    own: ownHealth({
      item: {
        ...registryItem("connectable"),
        status: { ...registryItem("connectable").status, clientCloud: "down" },
      },
    }),
  },
];

const NOTHING_FIRSTHAND: ReadonlySet<HostHealthState> = new Set([
  "online",
  "reported-reachable",
  "unknown",
]);

const ROWS = (["refused", "needs-update"] as const).flatMap((demotion) =>
  OWN_HEALTH.map((row) => ({ ...row, demotion })),
);

describe("hostRowHealth — every own health under each demotion", () => {
  it.each(ROWS)(
    "$demotion, own $state from $evidence",
    ({ demotion, state, own }) => {
      expect(own.state).toBe(state);
      const item = registryItem("connectable");
      const health = hostRowHealth({
        demotion,
        health: own,
        item,
        nowMs: NOW_MS,
      });

      if (demotion === "refused" && state === "online") {
        // The account's answer, with no live session vouching for it.
        expect(health).toEqual(ownHealth({ item }));
        expect(health.label).toBe("Reported reachable");
      } else if (demotion === "needs-update" && NOTHING_FIRSTHAND.has(state)) {
        expect(health.state).toBe("update-required");
        expect(health.label).toBe("Update required");
        expect(health.detail).toBe(HOST_UPDATE_REQUIRED_DETAIL);
        expect(health.live).toBe(false);
      } else {
        expect(health).toBe(own);
      }
    },
  );

  it.each([
    { account: "connectable", label: "Reported reachable" },
    { account: "offline", label: "Offline" },
    { account: "unknown", label: "Status unknown" },
  ] as const)(
    "refused, own online: reads $label when the account says $account",
    ({ account, label }) => {
      const health = hostRowHealth({
        demotion: "refused",
        health: ownHealth({ hasLiveSession: true }),
        item: registryItem(account),
        nowMs: NOW_MS,
      });

      expect(health.label).toBe(label);
      expect(health.live).toBe(false);
    },
  );
});
