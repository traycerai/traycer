import { describe, expect, it } from "vitest";
import {
  groupHostOptions,
  hostOptionCanActivate,
  hostOptionPickerGroup,
  pickableHostOptions,
} from "@/components/settings/host-scope/host-option-model";
import {
  buildHostScopeOptions,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

/**
 * A sandbox with no host row is listed: a sandbox row with neither a directory
 * entry nor a registry row is management-only. The host list shows it, so the
 * person can destroy it; no picker offers it and Activate is never offered for
 * it, because there is no host to start work on.
 */

const UNENROLLED_HOST_ID = "sbx-never-enrolled";

/**
 * A summary as the server really sends it: `environmentId` is a NOT NULL
 * column, so every listed sandbox names one.
 */
function listedSummary(overrides: Partial<SandboxSummary>): SandboxSummary {
  return sandboxSummaryFixture({ environmentId: "env_1", ...overrides });
}

function registryItem(hostId: string): HostListItem {
  return {
    hostId,
    displayName: `Registered ${hostId}`,
    platform: "linux-x64",
    kind: "sandbox",
    publicKey: "pk",
    createdAt: "2026-01-01T00:00:00Z",
    updatePolicy: "manual",
    sandboxState: "awake",
    sandboxFrozen: false,
    profile: "agent",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: "2026-01-01T00:00:00Z",
    },
  };
}

function rowFor(input: {
  readonly registry: readonly HostListItem[];
  readonly summary: SandboxSummary;
}): HostScopeOption {
  const rows = buildHostScopeOptions({
    leases: [],
    authorityAttached: false,
    directory: [],
    registry: input.registry,
    localHostId: null,
    activeHostId: null,
    localService: undefined,
    hasLiveSession: () => false,
    localHostSettingUp: false,
    localHostTerminalRunNote: null,
    sandboxes: [input.summary],
    nowMs: 0,
  });
  const row = rows.find((option) => option.hostId === input.summary.hostId);
  if (row === undefined) {
    throw new Error("the sandbox list's row was not built");
  }
  return row;
}

function unenrolledRow(state: "failed" | "creating"): HostScopeOption {
  return rowFor({
    registry: [],
    summary: listedSummary({
      id: "sbx_unenrolled",
      hostId: UNENROLLED_HOST_ID,
      displayName: "Broken box",
      state,
      failureCode: state === "failed" ? "PROVIDER_CREATE_FAILED" : null,
    }),
  });
}

describe("hostOptionPickerGroup for a sandbox no host row stands for", () => {
  it("puts it in the host list's sandbox group, whatever its state", () => {
    expect(hostOptionPickerGroup(unenrolledRow("failed"), true, null)).toBe(
      "sandbox",
    );
    expect(hostOptionPickerGroup(unenrolledRow("creating"), true, null)).toBe(
      "sandbox",
    );
  });

  it("hides it from every picker, composer included", () => {
    for (const state of ["failed", "creating"] as const) {
      const row = unenrolledRow(state);
      expect(hostOptionPickerGroup(row, false, null)).toBe("hidden");
      expect(hostOptionPickerGroup(row, false, { userId: "u" })).toBe("hidden");
    }
  });

  it("never offers Activate for it", () => {
    expect(hostOptionCanActivate(unenrolledRow("failed"))).toBe(false);
    expect(hostOptionCanActivate(unenrolledRow("creating"))).toBe(false);
  });

  it("hides a literal row with no entry, no registry row and an unanswered control-plane row, from a picker", () => {
    const row = hostScopeOptionFixture({
      hostId: "sbx-literal",
      isLocalMachine: false,
      isActive: false,
      connectable: false,
      registered: false,
      entry: null,
      item: null,
      kind: "sandbox",
      sandbox: {
        state: "failed",
        frozen: false,
        summary: listedSummary({
          hostId: "sbx-literal",
          state: "failed",
          failureCode: "PROVIDER_CREATE_FAILED",
        }),
        teamOwned: false,
      },
    });
    expect(hostOptionPickerGroup(row, false, null)).toBe("hidden");
    expect(hostOptionPickerGroup(row, true, null)).toBe("sandbox");
  });
});

describe("a burst sandbox no host row stands for", () => {
  function unenrolledBurstRow(): HostScopeOption {
    return rowFor({
      registry: [],
      summary: listedSummary({
        id: "sbx_burst_unenrolled",
        hostId: "sbx-burst-never-enrolled",
        displayName: "Task box",
        state: "failed",
        failureCode: "PROVIDER_CREATE_FAILED",
        burst: true,
      }),
    });
  }

  function registeredBurstRow(): HostScopeOption {
    return rowFor({
      registry: [registryItem("sbx-burst-enrolled")],
      summary: listedSummary({
        id: "sbx_burst_enrolled",
        hostId: "sbx-burst-enrolled",
        displayName: "Task box",
        state: "awake",
        burst: true,
      }),
    });
  }

  it("is built as an unenrolled row, and the registered one as a registry row", () => {
    const unenrolled = unenrolledBurstRow();
    expect(unenrolled.entry).toBeNull();
    expect(unenrolled.item).toBeNull();
    expect(registeredBurstRow().item).not.toBeNull();
  });

  it("lands in the host list's agent-sandboxes group, the group a registered burst sandbox lands in", () => {
    const unenrolled = unenrolledBurstRow();
    const registered = registeredBurstRow();

    expect(hostOptionPickerGroup(registered, true, null)).toBe("agent-sandbox");
    expect(hostOptionPickerGroup(unenrolled, true, null)).toBe(
      hostOptionPickerGroup(registered, true, null),
    );
  });

  it("is listed under agentSandboxes and not under the plain sandboxes, like a registered burst sandbox", () => {
    const unenrolled = unenrolledBurstRow();
    const registered = registeredBurstRow();

    const registeredGroups = groupHostOptions([registered], true, null, null);
    expect(registeredGroups.agentSandboxes).toEqual([registered]);
    expect(registeredGroups.sandboxes).toEqual([]);

    const groups = groupHostOptions([unenrolled], true, null, null);
    expect(groups.agentSandboxes).toEqual([unenrolled]);
    expect(groups.sandboxes).toEqual([]);
    expect(groups.teams).toEqual([]);
    expect(groups.personal).toEqual([]);
  });

  it("stays hidden from every picker", () => {
    const row = unenrolledBurstRow();
    expect(hostOptionPickerGroup(row, false, null)).toBe("hidden");
    expect(hostOptionPickerGroup(row, false, { userId: "u" })).toBe("hidden");
    expect(hostOptionCanActivate(row)).toBe(false);
    expect(pickableHostOptions([row], null)).toEqual([]);
  });
});

describe("groupHostOptions for a sandbox no host row stands for", () => {
  it("lists it in the host list's top-level sandboxes and in no team group", () => {
    for (const state of ["failed", "creating"] as const) {
      const row = unenrolledRow(state);
      const groups = groupHostOptions([row], true, null, null);

      expect(groups.sandboxes).toEqual([row]);
      expect(groups.teams).toEqual([]);
      expect(groups.personal).toEqual([]);
      expect(groups.agentSandboxes).toEqual([]);
    }
  });

  it("drops it from a picker's groups", () => {
    for (const state of ["failed", "creating"] as const) {
      const groups = groupHostOptions(
        [unenrolledRow(state)],
        false,
        null,
        null,
      );

      expect(groups.sandboxes).toEqual([]);
      expect(groups.teams).toEqual([]);
      expect(groups.personal).toEqual([]);
      expect(groups.agentSandboxes).toEqual([]);
    }
  });

  it("keeps it out of a flat picker list", () => {
    expect(pickableHostOptions([unenrolledRow("failed")], null)).toEqual([]);
  });
});
