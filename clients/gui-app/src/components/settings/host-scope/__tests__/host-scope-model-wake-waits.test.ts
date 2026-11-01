import { describe, expect, it } from "vitest";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type {
  SandboxOperation,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  buildHostScopeOptions,
  withSandboxWakeWaits,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";
import {
  AVAILABLE_HOST_ROW_SURFACE_STATE,
  hostOptionStatusWord,
} from "@/components/settings/host-scope/host-option-model";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

const HOST_ID = "sbx-host";

function registryRow(state: HostListItem["sandboxState"]): HostListItem {
  return {
    hostId: HOST_ID,
    displayName: "Build box",
    platform: "linux",
    kind: "sandbox",
    publicKey: "pk",
    createdAt: "2026-01-01T00:00:00Z",
    updatePolicy: "manual",
    status: {
      connectivity: "offline",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
    sandboxState: state,
    sandboxFrozen: false,
    profile: "agent",
  };
}

function optionFor(
  registryState: HostListItem["sandboxState"],
  summary: SandboxSummary,
  hasLiveSession: boolean,
): HostScopeOption {
  const registry = [registryRow(registryState)];
  const [option] = buildHostScopeOptions({
    leases: [],
    authorityAttached: false,
    directory: registry.map((row) =>
      hostListItemToDirectoryEntry(row, "wss://relay.example.test"),
    ),
    registry,
    localHostId: null,
    activeHostId: null,
    localService: undefined,
    localPlatform: null,
    hasLiveSession: () => hasLiveSession,
    localHostSettingUp: false,
    localHostTerminalRunNote: null,
    sandboxes: [summary],
    nowMs: 0,
  });
  return option;
}

function wakeFrom(fromState: SandboxOperation["fromState"]): SandboxOperation {
  return {
    at: 1_791_000_020_000,
    fromState,
    state: "awake",
    cause: "wake",
    outcomeCause: "wake",
    outcomeDetail: null,
    actor: null,
    gesture: null,
  };
}

function awakeAfter(fromState: SandboxOperation["fromState"]): SandboxSummary {
  return sandboxSummaryFixture({
    hostId: HOST_ID,
    state: "awake",
    lastTransitionAt: 1_791_000_020_000,
    operation: wakeFrom(fromState),
  });
}

function word(host: HostScopeOption): string | null {
  return hostOptionStatusWord(host, AVAILABLE_HOST_ROW_SURFACE_STATE);
}

describe("withSandboxWakeWaits", () => {
  it.each([
    { from: "suspended", wait: "resuming" },
    { from: "stopped", wait: "starting" },
  ] as const)(
    "reads an awake sandbox whose host has not reported as $wait, never offline",
    ({ from, wait }) => {
      const host = optionFor("awake", awakeAfter(from), false);
      expect(word(host)).toBe("offline");

      const [waiting] = withSandboxWakeWaits([host], {});

      expect(waiting.sandbox?.state).toBe(wait);
      expect(word(waiting)).toBe(wait);
    },
  );

  it("reads a host that has answered as awake", () => {
    const summary = awakeAfter("suspended");
    const answered = optionFor("awake", summary, true);

    const [live] = withSandboxWakeWaits([answered], {});
    expect(live.sandbox?.state).toBe("awake");

    const [recorded] = withSandboxWakeWaits(
      [optionFor("awake", summary, false)],
      {
        [summary.id]: summary.operation?.at ?? 0,
      },
    );
    expect(recorded.sandbox?.state).toBe("awake");
  });

  it("leaves a sandbox that is not awake, and a host that is not a sandbox, as it was", () => {
    const resting = optionFor(
      "suspended",
      sandboxSummaryFixture({ hostId: HOST_ID, state: "suspended" }),
      false,
    );
    const personal: HostScopeOption = {
      ...resting,
      kind: "personal",
      sandbox: null,
    };

    const out = withSandboxWakeWaits([resting, personal], {});

    expect(out[0]).toBe(resting);
    expect(out[1]).toBe(personal);
  });
});

describe("a wake the registry has not heard of", () => {
  const sandboxState = (
    registry: HostListItem["sandboxState"],
    row: SandboxSummary["state"],
  ) =>
    optionFor(
      registry,
      sandboxSummaryFixture({ hostId: HOST_ID, state: row }),
      false,
    ).sandbox?.state;

  it.each(["suspended", "stopped"] as const)(
    "reads the row's resuming or starting over the registry's %s",
    (asleep) => {
      expect(sandboxState(asleep, "resuming")).toBe("resuming");
      expect(sandboxState(asleep, "starting")).toBe("starting");
    },
  );

  it("moves no other pairing: the registry's word stands", () => {
    expect(sandboxState("awake", "starting")).toBe("awake");
    expect(sandboxState("awake", "resuming")).toBe("awake");
    expect(sandboxState("suspended", "awake")).toBe("suspended");
    expect(sandboxState("awake", "suspending")).toBe("awake");
    expect(sandboxState("suspended", "stopping")).toBe("suspended");
    expect(sandboxState("stopped", "suspended")).toBe("stopped");
    expect(sandboxState("failed", "resuming")).toBe("failed");
  });
});
