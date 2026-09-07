import { describe, expect, it } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { resolveSurfaceReadiness } from "@/components/layout/host-readiness-controller-context";

/** The tab-host arm is asserted below to be untouched by lease state, so that distinction cannot erode
 * silently. */

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
  /** Before, a null active id meant `loading-host` unconditionally - so a host the authority had already declared
   * dead rendered as a window still starting up, indefinitely. */
  it("calls a dead host unavailable even with no active id resolved", () => {
    expect(
      resolve({
        activeHostId: null,
        leases: [dead("host-a")],
        authorityAttached: true,
      }),
    ).toEqual({ kind: "loading-host" });

    // With the id present, the lease and the proxy agree - which is why the case above is the one that measures
    // the change.
    expect(
      resolve({
        activeHostId: "host-a",
        leases: [dead("host-a")],
        authorityAttached: true,
      }),
    ).toEqual({ kind: "unavailable-host" });
  });

  /** A host the authority is serving - or deliberately restarting - is not "unavailable" merely because its
   * directory row is not dialable this instant. */
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
  /** The fail-closed guard, at the gate rather than at the row. Every host has no lease before the kernel
   * attaches, and a window that read that as a verdict would close on every cold start. */
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

  /** Seeded with another host's death, this window must not inherit it - the P12 shape, at the gate. */
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
  /** §1b, pinned so it cannot erode. */
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
