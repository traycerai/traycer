import { describe, expect, it, vi } from "vitest";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import {
  ACTIVE_HOST_WORKSPACE_CONTROLS_SCOPE,
  buildFixedHostWorkspaceControlsScope,
  hostWorkspaceControlsScopeHostId,
  hostWorkspaceControlsScopeRefusals,
  type HostWorkspaceControlsHostScope,
} from "../host-workspace-controls-scope";

describe("hostWorkspaceControlsScopeHostId", () => {
  it("returns null for the app-wide active scope", () => {
    expect(
      hostWorkspaceControlsScopeHostId(ACTIVE_HOST_WORKSPACE_CONTROLS_SCOPE),
    ).toBeNull();
  });

  it("returns the named host for fixed and selected scopes", () => {
    const fixed = buildFixedHostWorkspaceControlsScope({
      hostId: "host-fixed",
      hostClient: null,
    });
    const selected: HostWorkspaceControlsHostScope = {
      kind: "selected",
      hostId: "host-selected",
      hostClient: null,
      onSelect: vi.fn(),
      refusalByHostId: NO_HOST_OPTION_REFUSALS,
      unselectableExceptHostId: null,
    };
    expect(hostWorkspaceControlsScopeHostId(fixed)).toBe("host-fixed");
    expect(hostWorkspaceControlsScopeHostId(selected)).toBe("host-selected");
  });
});

describe("hostWorkspaceControlsScopeRefusals", () => {
  it("only a selected scope carries per-row refusals", () => {
    const refusals = new Map([["old-host", "needs update"]]);
    const selected: HostWorkspaceControlsHostScope = {
      kind: "selected",
      hostId: "host-selected",
      hostClient: null,
      onSelect: vi.fn(),
      refusalByHostId: refusals,
      unselectableExceptHostId: null,
    };
    expect(hostWorkspaceControlsScopeRefusals(selected)).toBe(refusals);
    expect(
      hostWorkspaceControlsScopeRefusals(ACTIVE_HOST_WORKSPACE_CONTROLS_SCOPE),
    ).toBe(NO_HOST_OPTION_REFUSALS);
    expect(
      hostWorkspaceControlsScopeRefusals(
        buildFixedHostWorkspaceControlsScope({
          hostId: "host-fixed",
          hostClient: null,
        }),
      ),
    ).toBe(NO_HOST_OPTION_REFUSALS);
  });
});
