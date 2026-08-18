import { describe, expect, it } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { resolveSurfaceReadiness } from "@/components/layout/host-readiness-controller-context";

/**
 * The DEFAULT-HOST arm's lease input (redesign P4.3, ruling D).
 *
 * `resolveSurfaceReadiness` had no direct coverage at all before this file,
 * which is how the arm below kept its proxy for as long as it did: with the
 * active host present but not dialable, the choice between "still loading" and
 * "cannot be reached" was made by asking *is there an id* — a question that
 * knows nothing about the host. A definitively dead host answered
 * `loading-host` whenever no id had resolved, and a host that was merely
 * connecting answered `unavailable-host` whenever one had.
 *
 * The authority knows which. So where it has a verdict, it decides; where it
 * does not, the old proxy still answers, because the alternative is closing a
 * window on absence of evidence.
 *
 * SCOPE, stated because the omission is deliberate: only the `default-host`
 * arm reads leases. A tab is bound to its host for life and asks a
 * window-local question — "does a route to my host exist" — which §1b keeps
 * distinct from the app-wide lease. The tab-host arm is asserted below to be
 * untouched by lease state, so that distinction cannot erode silently.
 */

/** Present in the directory but NOT dialable — the state that reaches the arm. */
function undialableEntry(hostId: string): HostDirectoryEntry {
  return {
    hostId,
    label: hostId,
    kind: "remote",
    websocketUrl: null,
    version: null,
    transportDialability: "not-dialable",
  };
}

function resolve(input: {
  readonly activeHostId: string | null;
  readonly leases: readonly HostLeaseSnapshot[];
  readonly authorityAttached: boolean;
  readonly scope?: "default-host" | "tab-host";
  readonly tabHostId?: string | null;
}) {
  return resolveSurfaceReadiness({
    scope: input.scope ?? "default-host",
    tabHostId: input.tabHostId ?? null,
    authStatus: "signed-in",
    activeHostId: input.activeHostId,
    requestContextUserId: "user-1",
    directoryEntries: [undialableEntry("host-a")],
    hasLocalHost: true,
    hasMobileNoHost: false,
    hasReadySessionFor: () => false,
    leases: input.leases,
    authorityAttached: input.authorityAttached,
  });
}

const dead = (hostId: string): HostLeaseSnapshot => ({
  hostId,
  status: "dead",
  dead: { reason: "offline" },
});

describe("resolveSurfaceReadiness — the default-host arm reads the lease", () => {
  /**
   * The first of the two corrections. Before, a null active id meant
   * `loading-host` unconditionally — so a host the authority had already
   * declared dead rendered as a window still starting up, indefinitely.
   */
  it("calls a dead host unavailable even with no active id resolved", () => {
    expect(
      resolve({
        activeHostId: null,
        leases: [dead("host-a")],
        authorityAttached: true,
      }),
    ).toEqual({ kind: "loading-host" });

    // With the id present, the lease and the proxy agree — which is why the
    // case above is the one that measures the change.
    expect(
      resolve({
        activeHostId: "host-a",
        leases: [dead("host-a")],
        authorityAttached: true,
      }),
    ).toEqual({ kind: "unavailable-host" });
  });

  /**
   * The second correction, and the one a user feels. A host the authority is
   * SERVING — or deliberately restarting — is not "unavailable" merely because
   * its directory row is not dialable this instant.
   */
  it.each([["ready"], ["degraded"], ["restarting-expected"]] as const)(
    "calls a %s host loading, not unavailable",
    (status) => {
      expect(
        resolve({
          activeHostId: "host-a",
          leases: [{ hostId: "host-a", status, dead: null }],
          authorityAttached: true,
        }),
      ).toEqual({ kind: "loading-host" });
    },
  );
});

describe("resolveSurfaceReadiness — absence of evidence keeps the old answer", () => {
  /**
   * The fail-closed guard, at the gate rather than at the row. Every host has
   * no lease before the kernel attaches, and a window that read that as a
   * verdict would close on every cold start.
   */
  it("ignores leases entirely until the authority has attached", () => {
    expect(
      resolve({
        activeHostId: "host-a",
        leases: [{ hostId: "host-a", status: "ready", dead: null }],
        authorityAttached: false,
      }),
    ).toEqual({ kind: "unavailable-host" });
  });

  it("treats a connecting lease as no verdict at all", () => {
    // `connecting` is the contract's non-committal state, and what an unknown
    // status parses to at the raw boundary. It must not decide anything.
    expect(
      resolve({
        activeHostId: null,
        leases: [{ hostId: "host-a", status: "connecting", dead: null }],
        authorityAttached: true,
      }),
    ).toEqual({ kind: "loading-host" });
  });

  /**
   * Looked up BY ID. Seeded with another host's death, this window must not
   * inherit it — the P12 shape, at the gate.
   */
  it("does not borrow another host's lease", () => {
    expect(
      resolve({
        activeHostId: "host-a",
        leases: [dead("host-b")],
        authorityAttached: true,
      }),
    ).toEqual({ kind: "unavailable-host" });

    expect(
      resolve({
        activeHostId: null,
        leases: [dead("host-b")],
        authorityAttached: true,
      }),
    ).toEqual({ kind: "loading-host" });
  });
});

describe("resolveSurfaceReadiness — the tab-host arm stays a ROUTE question", () => {
  /**
   * §1b, pinned so it cannot erode. A tab bound to a host asks whether a route
   * to that host exists; the app-wide lease is a different question about a
   * different subject, and answering the first with the second is the
   * layering this epic removes.
   */
  it("is unmoved by lease state, alive or dead", () => {
    for (const leases of [
      [] as readonly HostLeaseSnapshot[],
      [{ hostId: "host-a", status: "ready", dead: null }] as const,
      [dead("host-a")],
    ]) {
      expect(
        resolve({
          scope: "tab-host",
          tabHostId: "host-a",
          activeHostId: "host-a",
          leases,
          authorityAttached: true,
        }),
      ).toEqual({ kind: "unavailable-host" });
    }
  });
});
