import { describe, expect, it } from "vitest";
import {
  projectDefaultHostReadiness,
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

  // The remote arm returns early at `presentsLocalHostLifecycle`, so a compat gate reintroduced below that early
  // return would sail past a remote-target assertion.
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
