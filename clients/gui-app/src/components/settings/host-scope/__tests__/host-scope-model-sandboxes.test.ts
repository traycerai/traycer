import { describe, expect, it } from "vitest";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  buildHostScopeOptions,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";
import {
  AVAILABLE_HOST_ROW_SURFACE_STATE,
  credentialTargetHostOptions,
  groupHostOptions,
  hostEntryTakesCredentials,
  hostOptionCanActivate,
  hostOptionKindLabel,
  hostOptionPickerGroup,
  isHostOptionSelectable,
  isSleepingSandboxPick,
  pickableHostOptions,
  SANDBOX_CREDENTIALS_REFUSED,
  hostTakesCredentials,
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
      teamOwned: false,
    });
    // The join is by host id: another sandbox does not inherit this summary.
    expect(options.get("other-host")?.sandbox?.summary).toBeNull();
  });

  it.each([
    ["stopping", "stopped"],
    ["suspending", "suspended"],
    ["destroying", "destroyed"],
  ] as const)(
    "reads the control plane's %s while the registry already reads its destination %s",
    (inFlight, destination) => {
      const summary = sandboxSummaryFixture({
        id: "sbx_1",
        hostId: "sbx-host",
        state: inFlight,
      });
      const option = build({
        registry: [
          item({
            hostId: "sbx-host",
            kind: "sandbox",
            sandboxState: destination,
          }),
        ],
        sandboxes: [summary],
      }).get("sbx-host");
      expect(option?.sandbox?.state).toBe(inFlight);
    },
  );

  it("keeps the registry's state when the control plane's row is not on its way there", () => {
    // A stale summary from before a wake: the registry's newer word stands.
    const summary = sandboxSummaryFixture({
      id: "sbx_1",
      hostId: "sbx-host",
      state: "stopping",
    });
    const option = build({
      registry: [
        item({ hostId: "sbx-host", kind: "sandbox", sandboxState: "awake" }),
      ],
      sandboxes: [summary],
    }).get("sbx-host");
    expect(option?.sandbox?.state).toBe("awake");
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
      teamOwned: false,
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
      teamOwned: false,
    },
  });
  const burst = hostScopeOptionFixture({
    hostId: "b",
    kind: "sandbox",
    sandbox: {
      state: "awake",
      frozen: false,
      summary: sandboxSummaryFixture({ hostId: "b", burst: true }),
      teamOwned: false,
    },
  });
  const unanswered = hostScopeOptionFixture({
    hostId: "u",
    kind: "sandbox",
    sandbox: { state: "awake", frozen: false, summary: null, teamOwned: false },
  });

  it("puts each row in the group the host list and the pickers agree on", () => {
    expect(hostOptionPickerGroup(personal, false, null)).toBe("personal");
    expect(hostOptionPickerGroup(normal, false, null)).toBe("sandbox");
    expect(hostOptionPickerGroup(burst, true, null)).toBe("agent-sandbox");
    expect(hostOptionPickerGroup(burst, false, null)).toBe("hidden");
    expect(hostOptionPickerGroup(unanswered, false, null)).toBe("hidden");
    expect(hostOptionPickerGroup(unanswered, true, null)).toBe("sandbox");
  });

  it("offers Activate for exactly the rows a picker offers", () => {
    const pod = hostScopeOptionFixture({
      hostId: "a",
      kind: "sandbox",
      sandbox: {
        state: "awake",
        frozen: false,
        summary: sandboxSummaryFixture({ hostId: "a", kind: "automation" }),
        teamOwned: false,
      },
    });
    expect(hostOptionCanActivate(personal)).toBe(true);
    expect(hostOptionCanActivate(normal)).toBe(true);
    expect(hostOptionCanActivate(pod)).toBe(false);
    expect(hostOptionCanActivate(burst)).toBe(false);
    expect(hostOptionCanActivate(unanswered)).toBe(false);
  });

  it("keeps the list's own order inside each group and never drops the row a surface points at", () => {
    const groups = groupHostOptions(
      [normal, burst, personal, unanswered],
      false,
      null,
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
        teamOwned: false,
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
    expect(hostOptionPickerGroup(pod, false, null)).toBe("hidden");
    expect(hostOptionPickerGroup(pod, true, null)).toBe("sandbox");
    expect(pickableHostOptions([pod], null)).toEqual([]);
  });

  it("hides the Automations pod from every picker, shows it in the host list, and never activates it", () => {
    for (const state of ["awake", "released"] as const) {
      const pod = sandboxOption({
        state,
        frozen: false,
        connectable: state === "awake",
        kind: "automation",
      });
      expect(hostOptionPickerGroup(pod, false, null)).toBe("hidden");
      expect(hostOptionPickerGroup(pod, false, { userId: "u" })).toBe("hidden");
      expect(hostOptionPickerGroup(pod, true, null)).toBe("sandbox");
      expect(hostOptionCanActivate(pod)).toBe(false);
      expect(groupHostOptions([pod], false, null, null).sandboxes).toEqual([]);
    }
  });

  it("does not let a composer viewer unhide a burst sandbox or an unanswered one", () => {
    const burstRow = hostScopeOptionFixture({
      hostId: "b",
      kind: "sandbox",
      sandbox: {
        state: "awake",
        frozen: false,
        summary: sandboxSummaryFixture({ hostId: "b", burst: true }),
        teamOwned: false,
      },
    });
    const unansweredRow = hostScopeOptionFixture({
      hostId: "u",
      kind: "sandbox",
      sandbox: {
        state: "awake",
        frozen: false,
        summary: null,
        teamOwned: false,
      },
    });
    const viewer = { userId: "u" };
    expect(hostOptionPickerGroup(burstRow, false, viewer)).toBe("hidden");
    expect(hostOptionPickerGroup(unansweredRow, false, viewer)).toBe("hidden");
  });

  it("treats a released, not frozen pod as a sleeping pick and a frozen one as not", () => {
    const released = sandboxOption({
      state: "released",
      frozen: false,
      connectable: false,
      kind: "automation",
    });
    expect(isSleepingSandboxPick(released)).toBe(true);
    expect(isHostOptionSelectable(released, "pin", available)).toBe(true);
    expect(
      isSleepingSandboxPick(
        sandboxOption({
          state: "released",
          frozen: true,
          connectable: false,
          kind: "automation",
        }),
      ),
    ).toBe(false);
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
        teamOwned: false,
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
      sandbox: {
        state: "awake",
        frozen: false,
        summary: null,
        teamOwned: false,
      },
    });
    expect(credentialTargetHostOptions([unanswered])).toEqual([]);
    expect(credentialTargetHostOptions([])).toEqual([]);
  });
});

describe("sandbox row words", () => {
  it("leads with frozen, then the lifecycle word, and has none for a state not yet known", () => {
    expect(
      sandboxStateWord({
        state: "suspended",
        frozen: true,
        summary: null,
        teamOwned: false,
      }),
    ).toBe("frozen");
    expect(
      sandboxStateWord({
        state: "stopped",
        frozen: false,
        summary: null,
        teamOwned: false,
      }),
    ).toBe("stopped");
    expect(
      sandboxStateWord({
        state: null,
        frozen: false,
        summary: null,
        teamOwned: false,
      }),
    ).toBeNull();
  });

  it("labels a sandbox row Sandbox ahead of its transport kind", () => {
    expect(
      hostOptionKindLabel(
        hostScopeOptionFixture({
          hostId: "n",
          isLocalMachine: false,
          kind: "sandbox",
          sandbox: {
            state: "awake",
            frozen: false,
            summary: null,
            teamOwned: false,
          },
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

describe("SANDBOX_CREDENTIALS_REFUSED", () => {
  it("is the one line every credential control shows", () => {
    expect(SANDBOX_CREDENTIALS_REFUSED).toBe("Sandboxes don't take sign-ins");
  });
});

describe("hostTakesCredentials", () => {
  it("is false for a sandbox row in every state, even one whose control-plane row has not answered", () => {
    for (const [state, frozen, summary] of [
      ["awake", false, sandboxSummaryFixture({ hostId: "s", state: "awake" })],
      ["suspended", true, null],
      ["awake", false, null],
    ] as const) {
      expect(
        hostTakesCredentials(
          hostScopeOptionFixture({
            hostId: "s",
            kind: "sandbox",
            sandbox: { state, frozen, summary, teamOwned: false },
          }),
        ),
      ).toBe(false);
    }
  });

  it("is true for a personal host, local or remote", () => {
    expect(hostTakesCredentials(hostScopeOptionFixture({ hostId: "p" }))).toBe(
      true,
    );
    expect(
      hostTakesCredentials(
        hostScopeOptionFixture({ hostId: "p", isLocalMachine: true }),
      ),
    ).toBe(true);
  });

  it("agrees with credentialTargetHostOptions: exactly the rows it keeps", () => {
    const rows = [
      hostScopeOptionFixture({ hostId: "laptop" }),
      hostScopeOptionFixture({
        hostId: "sbx",
        kind: "sandbox",
        sandbox: {
          state: "awake",
          frozen: false,
          summary: null,
          teamOwned: false,
        },
      }),
    ];
    expect(credentialTargetHostOptions(rows)).toEqual(
      rows.filter(hostTakesCredentials),
    );
  });
});

describe("hostEntryTakesCredentials", () => {
  function remote(kind: "personal" | "sandbox"): HostDirectoryEntry {
    const row = item({
      hostId: "host-r",
      kind,
      ...(kind === "sandbox"
        ? {
            sandboxState: "awake" as const,
            sandboxFrozen: false,
            profile: "agent" as const,
          }
        : {}),
    });
    return hostListItemToDirectoryEntry(row, "wss://relay.example.test");
  }

  it("is false for a sandbox directory entry", () => {
    expect(hostEntryTakesCredentials(remote("sandbox"))).toBe(false);
  });

  it("is true for a personal remote entry, this machine's own entry, and an unknown host (null)", () => {
    expect(hostEntryTakesCredentials(remote("personal"))).toBe(true);
    expect(
      hostEntryTakesCredentials({
        hostId: "host-local",
        label: "This machine",
        kind: "local",
        websocketUrl: "ws://127.0.0.1:9/stream",
        version: "1.5.0",
        transportDialability: "dialable",
      }),
    ).toBe(true);
    expect(hostEntryTakesCredentials(null)).toBe(true);
  });
});
