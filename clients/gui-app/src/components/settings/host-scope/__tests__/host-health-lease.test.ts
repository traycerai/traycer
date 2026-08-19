import { describe, expect, it } from "vitest";
import type {
  HostConnectivity,
  HostListItem,
} from "@traycer/protocol/host/host-status";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { deriveHostHealth } from "@/components/settings/host-scope/host-health";

/**
 * The lease step of `deriveHostHealth`'s precedence — the half this pass added,
 * and the half whose failure modes are asymmetric.
 *
 * Getting it wrong in the OPTIMISTIC direction costs a stale word on a row.
 * Getting it wrong in the PESSIMISTIC direction empties the fleet: every host
 * has a null lease before this window's kernel attaches, and every host reads
 * `connecting` while evidence producers warm up, so a derivation that treats
 * either as failure renders the whole account dead on every cold start — and,
 * because these same rows are the pickers a person would use to do something
 * about it, suppresses the surfaces that could clear it. That is the
 * fail-closed-gate class: the gate suppresses the producer that would reopen
 * it. Hence the first two tests.
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
 * A REMOTE row whose cloud lease says `connectable`. Chosen as the base on
 * purpose: it is the arm that, absent a lease, answers `reported-reachable` —
 * so every test below can tell "the lease decided this" from "the DTO decided
 * this" by the answer alone, with no mocking and no ambiguity.
 */
const BASE = {
  item: registryItem("connectable"),
  isLocalMachine: false,
  hasLiveSession: false,
  service: undefined,
  nowMs: NOW_MS,
};

function lease(
  status: "connecting" | "ready" | "degraded" | "restarting-expected",
): HostLeaseSnapshot {
  return { hostId: "host-a", status, dead: null };
}

describe("deriveHostHealth — absence of evidence is not death", () => {
  /**
   * Seeded with a lease PRESENT and `attached: false`, deliberately.
   *
   * The obvious way to write this — `lease: null, authorityAttached: false` —
   * cannot fail for the reason it is named after: with no lease there is
   * nothing for the attach flag to gate, so the test passes identically
   * whether `authorityAttached` is consulted or ignored entirely. It would be
   * an assertion about an input the code never reaches, which is the same
   * vacuity that let sealed probe P12 survive. A ready lease that must NOT be
   * believed is what makes the flag load-bearing.
   */
  it("ignores even a READY lease until the authority has attached", () => {
    // The bridge mounts in a parent effect and React runs child effects first,
    // so EVERY consumer renders at least once in this state.
    const health = deriveHostHealth({
      ...BASE,
      lease: lease("ready"),
      authorityAttached: false,
    });

    expect(health.state).toBe("reported-reachable");
    expect(health.state).not.toBe("online");
    expect(health.live).toBe(false);
  });

  it("falls through to the DTO when there is no lease and nothing has attached", () => {
    const health = deriveHostHealth({
      ...BASE,
      lease: null,
      authorityAttached: false,
    });

    expect(health.state).toBe("reported-reachable");
    expect(health.state).not.toBe("offline");
  });

  it("falls through to the DTO for a connecting lease, rather than calling it dead", () => {
    // `connecting` is the contract's non-committal state — neither usable nor
    // dead — and it is also what an unknown `status` parses to at the raw
    // boundary. Reading it as failure turns "we have not found out yet" into
    // "it is broken", for the whole fleet at once.
    const health = deriveHostHealth({
      ...BASE,
      lease: lease("connecting"),
      authorityAttached: true,
    });

    expect(health.state).toBe("reported-reachable");
    expect(health.state).not.toBe("offline");
  });

  it("ignores a lease the authority has not published for this host", () => {
    const health = deriveHostHealth({
      ...BASE,
      lease: null,
      authorityAttached: true,
    });

    expect(health.state).toBe("reported-reachable");
  });
});

describe("deriveHostHealth — the lease outranks the cloud DTO", () => {
  it("says Online with a live dot for a ready lease", () => {
    const health = deriveHostHealth({
      ...BASE,
      lease: lease("ready"),
      authorityAttached: true,
    });

    expect(health.state).toBe("online");
    expect(health.label).toBe("Online");
    expect(health.live).toBe(true);
  });

  /**
   * The direction the DTO can never produce. The cloud still holds a
   * `connectable` lease — it has up to 15 minutes to notice — while this app's
   * own transports have concluded the host is gone. F26's window, narrowed by
   * evidence instead of waited out.
   */
  it("says Offline for a dead lease even while the cloud still reports connectable", () => {
    const health = deriveHostHealth({
      ...BASE,
      lease: { hostId: "host-a", status: "dead", dead: { reason: "offline" } },
      authorityAttached: true,
    });

    expect(health.state).toBe("offline");
    expect(health.label).toBe("Offline");
    expect(health.live).toBe(false);
  });

  /**
   * `degraded` is a live SERVING state, not a demotion (P3.2's disambiguation:
   * `HostCompatibility.degraded` died as user-facing, `HostLeaseSnapshot`'s
   * `degraded` is a lease that still works). Rendering it as a failure would
   * put a fault on a host that is answering.
   */
  it("keeps a degraded lease Online, with the impairment as nuance", () => {
    const health = deriveHostHealth({
      ...BASE,
      lease: lease("degraded"),
      authorityAttached: true,
    });

    expect(health.state).toBe("online");
    expect(health.live).toBe(true);
    expect(health.detail).toBe("Connection is unstable.");
  });

  it("narrates an expected restart as a restart, not an outage", () => {
    const health = deriveHostHealth({
      ...BASE,
      lease: lease("restarting-expected"),
      authorityAttached: true,
    });

    expect(health.state).toBe("restarting");
    expect(health.label).toBe("Restarting…");
    expect(health.live).toBe(false);
    // Not a fault in progress.
    expect(health.tone).toBe("idle");
  });
});

describe("deriveHostHealth — every dead reason gets its own answer", () => {
  /**
   * THE regression this file exists for. Rendering `plan-restricted` as
   * "offline" is the months-long defect that sent free-tier users to debug a
   * network fault they did not have, while the one remedy that works — an
   * upgrade — went unmentioned. The two arms must differ in REMEDY, not just
   * in wording, which is why the detail is asserted and not only the state.
   */
  it("says Local only for plan-restricted — never Offline — and names the upgrade", () => {
    const health = deriveHostHealth({
      ...BASE,
      lease: {
        hostId: "host-a",
        status: "dead",
        dead: { reason: "plan-restricted" },
      },
      authorityAttached: true,
    });

    expect(health.state).toBe("local-only");
    expect(health.label).toBe("Local only");
    expect(health.label).not.toBe("Offline");
    expect(health.state).not.toBe("offline");
    expect(health.detail).toBe(
      "Not reachable from here — remote access needs a paid plan.",
    );
    // Not a fault: the host is healthy and running on its own computer.
    expect(health.tone).toBe("idle");
  });

  it("words plan-restricted differently for THIS machine, where the host is reachable", () => {
    const health = deriveHostHealth({
      ...BASE,
      isLocalMachine: true,
      lease: {
        hostId: "host-a",
        status: "dead",
        dead: { reason: "plan-restricted" },
      },
      authorityAttached: true,
    });

    expect(health.detail).toBe(
      "Reachable on this computer. Remote access needs a paid plan.",
    );
  });

  it("says Removed for a host that left the account", () => {
    const health = deriveHostHealth({
      ...BASE,
      lease: { hostId: "host-a", status: "dead", dead: { reason: "removed" } },
      authorityAttached: true,
    });

    expect(health.state).toBe("removed");
    expect(health.label).toBe("Removed");
  });

  /**
   * An incompatible host ANSWERED — it is up, and it disagreed. It must not
   * read as an outage: the remedy is an update, not a wait, and this is the
   * row that carries the update affordance.
   */
  it("says Update required for an incompatible host, not Offline", () => {
    const health = deriveHostHealth({
      ...BASE,
      lease: {
        hostId: "host-a",
        status: "dead",
        dead: {
          reason: "incompatible",
          detail: {
            code: "PROTOCOL_MAJOR_MISMATCH",
            hostVersion: "1.1.4",
            minSupportedVersion: "1.2.0",
          },
        },
      },
      authorityAttached: true,
    });

    expect(health.state).toBe("update-required");
    expect(health.label).toBe("Update required");
    expect(health.state).not.toBe("offline");
    // Actionable, so it is allowed to draw attention.
    expect(health.tone).toBe("warn");
  });

  /**
   * Totality, asserted as behaviour to back up the type-level guarantee.
   *
   * `DEAD_HEALTH` is keyed on `HostLeaseDeadState["reason"]`, so a fifth reason
   * added to the contract fails to COMPILE here rather than routing silently to
   * a generic arm — the same construction as `tile-host-load-copy.ts`. This
   * test adds the runtime half: no two reasons may collapse onto one answer,
   * which a compiler cannot see.
   */
  it("gives the four dead reasons four distinct states", () => {
    const deadStates = (
      [
        { reason: "offline" },
        { reason: "plan-restricted" },
        { reason: "removed" },
        {
          reason: "incompatible",
          detail: {
            code: "PROTOCOL_MAJOR_MISMATCH",
            hostVersion: "1.1.4",
            minSupportedVersion: "1.2.0",
          },
        },
      ] as const
    ).map(
      (dead) =>
        deriveHostHealth({
          ...BASE,
          lease: { hostId: "host-a", status: "dead", dead },
          authorityAttached: true,
        }).state,
    );

    expect(new Set(deadStates).size).toBe(4);
  });
});

describe("deriveHostHealth — precedence above the lease", () => {
  it("lets this machine's own running process outrank a dead lease", () => {
    // A direct read of the process on this box beats an aggregate of what
    // transports observed, including one that concluded it was gone.
    const health = deriveHostHealth({
      ...BASE,
      isLocalMachine: true,
      service: {
        state: "running",
        version: "1.4.2",
        listenUrl: "ws://127.0.0.1:1/rpc",
        pid: 1,
      },
      lease: { hostId: "host-a", status: "dead", dead: { reason: "offline" } },
      authorityAttached: true,
    });

    expect(health.state).toBe("online");
    expect(health.detail).toBe("Running on this computer.");
  });

  it("still reports a stopped local service over a ready lease", () => {
    const health = deriveHostHealth({
      ...BASE,
      isLocalMachine: true,
      service: {
        state: "stopped",
        version: "1.4.2",
        listenUrl: null,
        pid: null,
      },
      lease: lease("ready"),
      authorityAttached: true,
    });

    expect(health.state).toBe("stopped");
  });
});
