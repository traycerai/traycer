import { describe, expect, it } from "vitest";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  buildHostScopeOptions,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";
import {
  groupHostOptions,
  hostOptionKindLabel,
  hostOptionPickerGroup,
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
