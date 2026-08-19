import { describe, expect, it } from "vitest";
import {
  projectDefaultHostReadiness,
  resolveSurfaceReadiness,
  type DefaultHostReadinessPresentation,
} from "@/components/layout/host-readiness-controller-context";

const DEFAULT_PRESENTATION: DefaultHostReadinessPresentation = {
  targetKind: "local",
  localBootIntent: true,
  localHostState: "unknown",
  stage: "loading",
  progress: null,
  lastProgress: null,
  provisioningError: null,
  provisioning: false,
  removed: false,
  hostBusy: false,
  canManageHost: false,
  retryProvisioning: () => undefined,
  forceProvisioning: () => undefined,
  reinstall: () => undefined,
  configureShell: () => undefined,
  refreshDirectory: () => undefined,
  directoryRefreshing: false,
  openSettings: () => undefined,
  compatibility: {
    status: "compatible",
    degraded: false,
    unreachable: false,
    hostStatus: null,
  },
};

describe("projectDefaultHostReadiness", () => {
  it("holds a local default host while provisioning", () => {
    expect(
      projectDefaultHostReadiness({
        readiness: { kind: "ready" },
        presentation: { ...DEFAULT_PRESENTATION, provisioning: true },
      }),
    ).toEqual({ kind: "provisioning-host" });
  });

  it("does not project local provisioning onto a remote default host", () => {
    expect(
      projectDefaultHostReadiness({
        readiness: { kind: "ready" },
        presentation: {
          ...DEFAULT_PRESENTATION,
          targetKind: "remote",
          localBootIntent: false,
          provisioning: true,
        },
      }),
    ).toEqual({ kind: "ready" });
  });

  // D13, P3.2: the compat verdict is a SELECTION input, and this projection is
  // where it used to be a readiness input instead. Every non-compatible verdict
  // is asserted, not just `incompatible`: `checking` held the window behind a
  // full-screen probe card and `failed` behind an error card, and re-adding any
  // one of the three would put a second narrator back on screen for a fact the
  // authority's lease already owns.
  //
  // Driven through the LOCAL arm on purpose. The remote arm returns early at
  // `presentsLocalHostLifecycle`, so a compat gate reintroduced below that
  // early return would sail past a remote-target assertion - the test would
  // pass because the input never reached the code under test, which is the
  // unreachable-premise trap, not coverage.
  const nonCompatibleVerdicts = ["checking", "failed", "incompatible"] as const;
  for (const status of nonCompatibleVerdicts) {
    it(`leaves a dialable local host READY when the compat verdict is ${status}`, () => {
      expect(
        projectDefaultHostReadiness({
          readiness: { kind: "ready" },
          presentation: {
            ...DEFAULT_PRESENTATION,
            compatibility: {
              ...DEFAULT_PRESENTATION.compatibility,
              status,
              unreachable: status === "failed",
            },
          },
        }),
      ).toEqual({ kind: "ready" });
    });
  }
});

describe("resolveSurfaceReadiness relay-only directory provenance", () => {
  const base = {
    scope: "default-host" as const,
    tabHostId: null,
    authStatus: "signed-in" as const,
    activeHostId: null,
    requestContextUserId: "user-1",
    directoryEntries: [],
    hasLocalHost: false,
    hasReadySessionFor: () => false,
    leases: [],
    authorityAttached: false,
  };

  it("answers searching-hosts while the registry has never delivered a listing", () => {
    // A cold relay-only launch: the directory is empty because nobody has
    // reached the registry yet, not because the account owns no hosts.
    // Presenting the no-host instruction there flashed "No host connected"
    // on every cold start.
    expect(
      resolveSurfaceReadiness({
        ...base,
        hasMobileNoHost: false,
        hostsUnknown: true,
      }),
    ).toEqual({ kind: "searching-hosts" });
  });

  it("answers mobile-no-host only once the emptiness is a delivered answer", () => {
    expect(
      resolveSurfaceReadiness({
        ...base,
        hasMobileNoHost: true,
        hostsUnknown: false,
      }),
    ).toEqual({ kind: "mobile-no-host" });
  });

  it("orders searching-hosts ahead of the no-host answer", () => {
    // The two flags are mutually exclusive at the source (`getCardinality`),
    // but the ordering is the load-bearing half of that contract: an
    // unanswered registry must never be presented as an answered one.
    expect(
      resolveSurfaceReadiness({
        ...base,
        hasMobileNoHost: true,
        hostsUnknown: true,
      }),
    ).toEqual({ kind: "searching-hosts" });
  });

  it("never shows a directory surface on a shell with a local host", () => {
    expect(
      resolveSurfaceReadiness({
        ...base,
        hasLocalHost: true,
        hasMobileNoHost: false,
        hostsUnknown: true,
      }),
    ).toEqual({ kind: "loading-host" });
  });
});
