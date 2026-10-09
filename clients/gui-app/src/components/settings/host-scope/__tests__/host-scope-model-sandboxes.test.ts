import { describe, expect, it } from "vitest";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  buildHostScopeOptions,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";
import {
  AVAILABLE_HOST_ROW_SURFACE_STATE,
  credentialTargetHostOptions,
  groupHostOptions,
  hostOptionKindLabel,
  hostOptionPickerGroup,
  isHostOptionSelectable,
  pickableHostOptions,
  sandboxStateWord,
} from "@/components/settings/host-scope/host-option-model";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

function item(overrides: Partial<HostListItem>): HostListItem {
  return {
    hostId: "host-a",
    displayName: "Host A",
    platform: "linux",
    kind: "personal",
    publicKey: "pk",
    createdAt: "2026-01-01T00:00:00Z",
    updatePolicy: "manual",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: "2026-01-01T00:00:00Z",
    },
    ...overrides,
  };
}

function build(input: {
  readonly registry: readonly HostListItem[];
  readonly sandboxes: readonly SandboxSummary[] | null;
}): ReadonlyMap<string, HostScopeOption> {
  const options = buildHostScopeOptions({
    leases: [],
    authorityAttached: false,
    directory: input.registry.map((row) =>
      hostListItemToDirectoryEntry(row, "wss://relay.example.test"),
    ),
    registry: input.registry,
    localHostId: null,
    activeHostId: null,
    localService: undefined,
    hasLiveSession: () => false,
    localHostSettingUp: false,
    sandboxes: input.sandboxes,
    nowMs: 0,
  });
  return new Map(options.map((option) => [option.hostId, option]));
}

describe("buildHostScopeOptions sandbox facts", () => {
  it("leaves a personal host with no sandbox facts", () => {
    const option = build({ registry: [item({})], sandboxes: [] }).get("host-a");
    expect(option?.kind).toBe("personal");
    expect(option?.sandbox).toBeNull();
  });

  it("takes a sandbox's lifecycle from the registry row and its summary from the control plane's row for the same host", () => {
    const summary = sandboxSummaryFixture({
      id: "sbx_1",
      hostId: "sbx-host",
      burst: true,
    });
    const options = build({
      registry: [
        item({
          hostId: "sbx-host",
          kind: "sandbox",
          sandboxState: "suspended",
          sandboxFrozen: true,
          profile: "agent",
        }),
        item({ hostId: "other-host", kind: "sandbox", sandboxState: "awake" }),
      ],
      sandboxes: [summary],
    });
    expect(options.get("sbx-host")?.kind).toBe("sandbox");
    expect(options.get("sbx-host")?.sandbox).toEqual({
      state: "suspended",
      frozen: true,
      summary,
    });
    // The join is by host id: another sandbox does not inherit this summary.
    expect(options.get("other-host")?.sandbox?.summary).toBeNull();
  });

  it("never reads a destroyed sandbox as frozen, whatever flag the registry kept", () => {
    const option = build({
      registry: [
        item({
          hostId: "sbx-host",
          kind: "sandbox",
          sandboxState: "destroyed",
          sandboxFrozen: true,
          profile: "agent",
        }),
      ],
      sandboxes: null,
    }).get("sbx-host");
    expect(option?.sandbox?.state).toBe("destroyed");
    expect(option?.sandbox?.frozen).toBe(false);
    expect(option?.sandbox ? sandboxStateWord(option.sandbox) : null).toBe(
      "destroyed",
    );
  });

  it("keeps every sandbox's summary unknown until the control plane's list has answered", () => {
    const option = build({
      registry: [
        item({ hostId: "sbx-host", kind: "sandbox", sandboxState: "awake" }),
      ],
      sandboxes: null,
    }).get("sbx-host");
    expect(option?.sandbox).toEqual({
      state: "awake",
      frozen: false,
      summary: null,
    });
  });

  it("falls back to the control plane's row for a sandbox the registry has no state for yet", () => {
    const option = build({
      registry: [
        item({ hostId: "sbx-host", kind: "sandbox", sandboxState: null }),
      ],
      sandboxes: [
        sandboxSummaryFixture({
          id: "sbx_1",
          hostId: "sbx-host",
          state: "creating",
        }),
      ],
    }).get("sbx-host");
    expect(option?.sandbox?.state).toBe("creating");
  });
});

describe("sandbox grouping predicates", () => {
  const personal = hostScopeOptionFixture({ hostId: "p" });
  const normal = hostScopeOptionFixture({
    hostId: "n",
    kind: "sandbox",
    sandbox: {
      state: "awake",
      frozen: false,
      summary: sandboxSummaryFixture({ hostId: "n", burst: false }),
    },
  });
  const burst = hostScopeOptionFixture({
    hostId: "b",
    kind: "sandbox",
    sandbox: {
      state: "awake",
      frozen: false,
      summary: sandboxSummaryFixture({ hostId: "b", burst: true }),
    },
  });
  const unanswered = hostScopeOptionFixture({
    hostId: "u",
    kind: "sandbox",
    sandbox: { state: "awake", frozen: false, summary: null },
  });

  it("puts each row in the group the host list and the pickers agree on", () => {
    expect(hostOptionPickerGroup(personal, false)).toBe("personal");
    expect(hostOptionPickerGroup(normal, false)).toBe("sandbox");
    expect(hostOptionPickerGroup(burst, true)).toBe("agent-sandbox");
    expect(hostOptionPickerGroup(burst, false)).toBe("hidden");
    expect(hostOptionPickerGroup(unanswered, false)).toBe("hidden");
    expect(hostOptionPickerGroup(unanswered, true)).toBe("sandbox");
  });

  it("keeps the list's own order inside each group and never drops the row a surface points at", () => {
    const groups = groupHostOptions(
      [normal, burst, personal, unanswered],
      false,
      "b",
    );
    expect(groups.personal.map((h) => h.hostId)).toEqual(["p"]);
    expect(groups.sandboxes.map((h) => h.hostId)).toEqual(["n", "b"]);
    expect(groups.agentSandboxes).toEqual([]);
  });

  it("flattens a picker to personal hosts first and the user's sandboxes after, never a burst one", () => {
    expect(
      pickableHostOptions([normal, burst, personal, unanswered], null).map(
        (h) => h.hostId,
      ),
    ).toEqual(["p", "n"]);
  });
});

describe("sleeping sandbox picks", () => {
  function sandboxOption(input: {
    readonly state: NonNullable<HostListItem["sandboxState"]>;
    readonly frozen: boolean;
    readonly connectable: boolean;
    readonly kind: SandboxSummary["kind"];
  }): HostScopeOption {
    return hostScopeOptionFixture({
      hostId: "s",
      kind: "sandbox",
      connectable: input.connectable,
      sandbox: {
        state: input.state,
        frozen: input.frozen,
        summary: sandboxSummaryFixture({
          hostId: "s",
          state: input.state,
          frozen: input.frozen,
          kind: input.kind,
        }),
      },
    });
  }
  const available = AVAILABLE_HOST_ROW_SURFACE_STATE;

  it("offers a suspended or stopped, not frozen sandbox to pin and bind although its route is down", () => {
    for (const state of ["suspended", "stopped"] as const) {
      const host = sandboxOption({
        state,
        frozen: false,
        connectable: false,
        kind: "agent",
      });
      expect(isHostOptionSelectable(host, "pin", available)).toBe(true);
      expect(isHostOptionSelectable(host, "bind", available)).toBe(true);
    }
  });

  it("never offers a frozen sandbox to pin or bind, even one that still dials, but still lets it be viewed", () => {
    const host = sandboxOption({
      state: "suspended",
      frozen: true,
      connectable: true,
      kind: "agent",
    });
    expect(isHostOptionSelectable(host, "pin", available)).toBe(false);
    expect(isHostOptionSelectable(host, "bind", available)).toBe(false);
    expect(isHostOptionSelectable(host, "view", available)).toBe(true);
  });

  it("still needs a route for a sandbox that is not asleep", () => {
    const host = sandboxOption({
      state: "awake",
      frozen: false,
      connectable: false,
      kind: "agent",
    });
    expect(isHostOptionSelectable(host, "pin", available)).toBe(false);
  });

  it("lists the Automations pod with the user's sandboxes and offers it to no picker", () => {
    const pod = sandboxOption({
      state: "awake",
      frozen: false,
      connectable: true,
      kind: "automation",
    });
    expect(hostOptionPickerGroup(pod, false)).toBe("hidden");
    expect(hostOptionPickerGroup(pod, true)).toBe("sandbox");
    expect(pickableHostOptions([pod], null)).toEqual([]);
  });
});

describe("credentialTargetHostOptions", () => {
  const sandboxOf = (
    hostId: string,
    state: "awake" | "suspended",
    frozen: boolean,
    burst: boolean,
  ): HostScopeOption =>
    hostScopeOptionFixture({
      hostId,
      kind: "sandbox",
      sandbox: {
        state,
        frozen,
        summary: sandboxSummaryFixture({ hostId, state, frozen, burst }),
      },
    });

  it("drops every sandbox row, awake, frozen or burst, and keeps personal hosts in their order", () => {
    const first = hostScopeOptionFixture({ hostId: "laptop" });
    const second = hostScopeOptionFixture({ hostId: "desktop" });

    expect(
      credentialTargetHostOptions([
        first,
        sandboxOf("sbx-awake", "awake", false, false),
        sandboxOf("sbx-frozen", "suspended", true, false),
        second,
        sandboxOf("sbx-burst", "awake", false, true),
      ]).map((h) => h.hostId),
    ).toEqual(["laptop", "desktop"]);
  });

  it("drops a sandbox whose control-plane row has not answered, and is empty for no hosts", () => {
    const unanswered = hostScopeOptionFixture({
      hostId: "sbx-unknown",
      kind: "sandbox",
      sandbox: { state: "awake", frozen: false, summary: null },
    });
    expect(credentialTargetHostOptions([unanswered])).toEqual([]);
    expect(credentialTargetHostOptions([])).toEqual([]);
  });
});

describe("sandbox row words", () => {
  it("leads with frozen, then the lifecycle word, and has none for a state not yet known", () => {
    expect(
      sandboxStateWord({ state: "suspended", frozen: true, summary: null }),
    ).toBe("frozen");
    expect(
      sandboxStateWord({ state: "stopped", frozen: false, summary: null }),
    ).toBe("stopped");
    expect(
      sandboxStateWord({ state: null, frozen: false, summary: null }),
    ).toBeNull();
  });

  it("labels a sandbox row Sandbox ahead of its transport kind", () => {
    expect(
      hostOptionKindLabel(
        hostScopeOptionFixture({
          hostId: "n",
          isLocalMachine: false,
          kind: "sandbox",
          sandbox: { state: "awake", frozen: false, summary: null },
        }),
      ),
    ).toBe("Sandbox");
    expect(
      hostOptionKindLabel(
        hostScopeOptionFixture({ hostId: "p", isLocalMachine: false }),
      ),
    ).toBe("Host");
  });
});
