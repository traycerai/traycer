import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  HostListItem,
  HostOwnerPrincipal,
} from "@traycer/protocol/host/host-status";
import type {
  SandboxPod,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { groupHostOptions } from "@/components/settings/host-scope/host-option-model";
import type { HostPickerGroups } from "@/components/settings/host-scope/host-option-model";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { useAuthStore } from "@/stores/auth/auth-store";

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => ({ sandboxControlUnavailableReason: null }),
}));

import {
  useSandboxAutomation,
  useSandboxTeamPods,
} from "@/hooks/sandboxes/use-sandbox-automation-query";
import {
  teamPodEnvironmentIds,
  teamPodOpenRows,
} from "@/lib/commands/sources/open/team-pod-open";

/**
 * The new terminal picker lists a team's pods and opens one that cannot be
 * dialed yet by its environment and ordinal. The pod lists are one read per
 * team environment, however many pods the team has.
 */

const TEAM_A: HostOwnerPrincipal = {
  kind: "team",
  id: "team-a",
  name: "Alpha",
};
const TEAM_B: HostOwnerPrincipal = {
  kind: "team",
  id: "team-b",
  name: "Bravo",
};
const ENV_A = "env-a";
const ENV_B = "env-b";
/** Held in constants: a hook's id list is stable across renders, as the picker's is. */
const ONLY_A: readonly string[] = [ENV_A];
const NO_ENVIRONMENTS: readonly string[] = [];

function registryItem(hostId: string, owner: HostOwnerPrincipal): HostListItem {
  return {
    hostId,
    displayName: hostId,
    platform: "linux-x64",
    kind: "sandbox",
    publicKey: "pk",
    createdAt: new Date(0).toISOString(),
    updatePolicy: "manual",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.4.2",
      lastSeenAt: new Date(0).toISOString(),
    },
    owner,
  };
}

function summaryOf(
  hostId: string,
  environmentId: string | null,
  kind: SandboxSummary["kind"],
): SandboxSummary {
  return sandboxSummaryFixture({
    id: `sbx-${hostId}`,
    hostId,
    kind,
    environmentId,
  });
}

function teamRow(
  hostId: string,
  owner: HostOwnerPrincipal,
  environmentId: string | null,
  kind: SandboxSummary["kind"],
): HostScopeOption {
  return hostScopeOptionFixture({
    hostId,
    name: `Name of ${hostId}`,
    kind: "sandbox",
    isLocalMachine: false,
    item: registryItem(hostId, owner),
    sandbox: {
      state: "awake",
      frozen: false,
      summary: summaryOf(hostId, environmentId, kind),
      teamOwned: true,
    },
  });
}

function ownRow(hostId: string, kind: SandboxSummary["kind"]): HostScopeOption {
  return hostScopeOptionFixture({
    hostId,
    name: `Name of ${hostId}`,
    kind: "sandbox",
    isLocalMachine: false,
    item: registryItem(hostId, { kind: "user", id: "user-me" }),
    sandbox: {
      state: "awake",
      frozen: false,
      summary: summaryOf(hostId, "env-own", kind),
      teamOwned: false,
    },
  });
}

/** The picker's own host rule: pods offered, no burst sandboxes. */
function pickerGroups(rows: readonly HostScopeOption[]): HostPickerGroups {
  return groupHostOptions(rows, false, true, null);
}

function podOf(hostId: string, ordinal: number, envId: string): SandboxPod {
  return {
    sandbox: summaryOf(hostId, envId, "automation"),
    ordinal,
    liveShells: 0,
    headroom: 5,
  };
}

const THREE_PODS_OF_A: readonly HostScopeOption[] = [
  teamRow("a-pod-0", TEAM_A, ENV_A, "automation"),
  teamRow("a-pod-1", TEAM_A, ENV_A, "automation"),
  teamRow("a-pod-2", TEAM_A, ENV_A, "automation"),
];

describe("teamPodEnvironmentIds", () => {
  it("gives one environment for three pods of one team: three pods cost one read", () => {
    expect(teamPodEnvironmentIds(pickerGroups(THREE_PODS_OF_A))).toEqual([
      ENV_A,
    ]);
  });

  it("gives one environment per team that has a pod", () => {
    const groups = pickerGroups([
      ...THREE_PODS_OF_A,
      teamRow("b-pod-0", TEAM_B, ENV_B, "automation"),
    ]);
    expect(teamPodEnvironmentIds(groups)).toEqual([ENV_A, ENV_B]);
  });

  it("gives none for a team that has only agent sandboxes, and none for the person's own pod", () => {
    const groups = pickerGroups([
      teamRow("a-agent", TEAM_A, ENV_A, "agent"),
      ownRow("own-pod", "automation"),
    ]);
    expect(teamPodEnvironmentIds(groups)).toEqual([]);
  });

  it("leaves out a pod with no environment: there is nothing to read its pod list by", () => {
    const groups = pickerGroups([
      teamRow("a-pod-0", TEAM_A, ENV_A, "automation"),
      teamRow("a-pod-legacy", TEAM_A, null, "automation"),
    ]);
    expect(teamPodEnvironmentIds(groups)).toEqual([ENV_A]);
    expect(
      teamPodEnvironmentIds(
        pickerGroups([teamRow("a-pod-legacy", TEAM_A, null, "automation")]),
      ),
    ).toEqual([]);
  });

  it("gives none when there is no team", () => {
    expect(teamPodEnvironmentIds(pickerGroups([]))).toEqual([]);
  });
});

describe("teamPodOpenRows", () => {
  const groups = pickerGroups([
    ...THREE_PODS_OF_A,
    teamRow("a-agent", TEAM_A, ENV_A, "agent"),
    teamRow("b-pod-0", TEAM_B, ENV_B, "automation"),
    ownRow("own-pod", "automation"),
  ]);
  const NONE_DIALABLE = (): boolean => false;
  const ANSWERED: ReadonlyMap<string, readonly SandboxPod[]> = new Map([
    [
      ENV_A,
      [
        podOf("a-pod-0", 0, ENV_A),
        podOf("a-pod-1", 3, ENV_A),
        podOf("a-pod-2", 7, ENV_A),
      ],
    ],
    [ENV_B, [podOf("b-pod-0", 1, ENV_B)]],
  ]);

  it("offers every team pod that cannot be dialed, and nothing else", () => {
    const rows = teamPodOpenRows(groups, ANSWERED, NONE_DIALABLE);
    expect(rows.map((row) => row.hostId)).toEqual([
      "a-pod-0",
      "a-pod-1",
      "a-pod-2",
      "b-pod-0",
    ]);
    expect(rows[0].label).toBe("Name of a-pod-0");
  });

  it("skips a pod that can already be dialed", () => {
    const rows = teamPodOpenRows(
      groups,
      ANSWERED,
      (hostId) => hostId === "a-pod-1" || hostId === "b-pod-0",
    );
    expect(rows.map((row) => row.hostId)).toEqual(["a-pod-0", "a-pod-2"]);
  });

  it("carries the pod's own ordinal from its environment's pod list", () => {
    const rows = teamPodOpenRows(
      groups,
      new Map([
        [
          ENV_A,
          [
            podOf("a-pod-0", 0, ENV_A),
            podOf("a-pod-1", 3, ENV_A),
            podOf("a-pod-2", 7, ENV_A),
          ],
        ],
        [ENV_B, [podOf("b-pod-0", 1, ENV_B)]],
      ]),
      NONE_DIALABLE,
    );
    expect(rows.map((row) => row.target)).toEqual([
      { environmentId: ENV_A, ordinal: 0 },
      { environmentId: ENV_A, ordinal: 3 },
      { environmentId: ENV_A, ordinal: 7 },
      { environmentId: ENV_B, ordinal: 1 },
    ]);
  });

  it("offers one generic row per team, which lets the server pick, while no pod list has answered", () => {
    const rows = teamPodOpenRows(groups, new Map(), NONE_DIALABLE);
    expect(rows).toEqual([
      {
        hostId: null,
        label: "a pod for Alpha",
        target: { environmentId: ENV_A, ordinal: null },
      },
      {
        hostId: null,
        label: "a pod for Bravo",
        target: { environmentId: ENV_B, ordinal: null },
      },
    ]);
  });

  it("folds the pods its answered list does not hold into the team's generic row, and names the rest with the list's ordinal", () => {
    const rows = teamPodOpenRows(
      groups,
      new Map([[ENV_A, [podOf("a-pod-2", 4, ENV_A)]]]),
      NONE_DIALABLE,
    );
    expect(rows.map((row) => [row.hostId, row.target])).toEqual([
      [null, { environmentId: ENV_A, ordinal: null }],
      ["a-pod-2", { environmentId: ENV_A, ordinal: 4 }],
      [null, { environmentId: ENV_B, ordinal: null }],
    ]);
  });

  it("offers no open for a pod with no environment, since opening it would address the person's own Automations host", () => {
    const withLegacy = pickerGroups([
      teamRow("a-pod-0", TEAM_A, ENV_A, "automation"),
      teamRow("a-pod-legacy", TEAM_A, null, "automation"),
    ]);
    expect(
      teamPodOpenRows(
        withLegacy,
        new Map([[ENV_A, [podOf("a-pod-0", 0, ENV_A)]]]),
        NONE_DIALABLE,
      ).map((row) => row.hostId),
    ).toEqual(["a-pod-0"]);
  });

  it("offers nothing when every pod can be dialed", () => {
    expect(teamPodOpenRows(groups, new Map(), () => true)).toEqual([]);
  });

  it("names no specific pod on a row whose ordinal is unknown while the pod list is pending", () => {
    const twoPods = pickerGroups([
      teamRow("a-pod-0", TEAM_A, ENV_A, "automation"),
      teamRow("a-pod-1", TEAM_A, ENV_A, "automation"),
    ]);
    const rows = teamPodOpenRows(twoPods, new Map(), NONE_DIALABLE);
    // Either the rows are omitted, or one generic row stands in; a row that
    // names a specific pod must carry a known ordinal.
    const namedWithoutOrdinal = rows.filter(
      (row) =>
        row.target.ordinal === null &&
        (row.hostId === "a-pod-0" || row.hostId === "a-pod-1"),
    );
    expect(namedWithoutOrdinal).toEqual([]);
  });
});

describe("the pod reads behind the new terminal picker", () => {
  function wrapper() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return ({ children }: { readonly children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }

  function scriptPods(binding: FakeSandboxBinding): void {
    binding.auth.getSandboxAutomation.mockImplementation((environmentId) =>
      Promise.resolve({
        kind: "ok",
        automation: {
          available: true,
          sandbox: null,
          pods:
            environmentId === ENV_A
              ? [
                  podOf("a-pod-0", 0, ENV_A),
                  podOf("a-pod-1", 1, ENV_A),
                  podOf("a-pod-2", 2, ENV_A),
                ]
              : [podOf("b-pod-0", 0, ENV_B)],
        },
      }),
    );
  }

  beforeEach(() => {
    mocks.binding = createFakeSandboxBinding();
    useAuthStore.setState({ status: "signed-in" });
  });
  afterEach(() => {
    cleanup();
    useAuthStore.setState({ status: "signed-out" });
  });

  it("issues exactly one read, with the team's environment, for three pods of one team", async () => {
    const binding = mocks.binding;
    if (binding === null) throw new Error("the binding was not set");
    scriptPods(binding);
    const ids = teamPodEnvironmentIds(pickerGroups(THREE_PODS_OF_A));

    const { result } = renderHook(() => useSandboxTeamPods(ids), {
      wrapper: wrapper(),
    });

    await waitFor(() => {
      expect(result.current.get(ENV_A)).toHaveLength(3);
    });
    expect(binding.auth.getSandboxAutomation).toHaveBeenCalledTimes(1);
    expect(binding.auth.getSandboxAutomation).toHaveBeenCalledWith(ENV_A);
    expect(result.current.get(ENV_A)?.map((pod) => pod.ordinal)).toEqual([
      0, 1, 2,
    ]);
  });

  it("reads once per team environment, and keys each answer by its environment", async () => {
    const binding = mocks.binding;
    if (binding === null) throw new Error("the binding was not set");
    scriptPods(binding);
    const ids = teamPodEnvironmentIds(
      pickerGroups([
        ...THREE_PODS_OF_A,
        teamRow("b-pod-0", TEAM_B, ENV_B, "automation"),
      ]),
    );

    const { result } = renderHook(() => useSandboxTeamPods(ids), {
      wrapper: wrapper(),
    });

    await waitFor(() => {
      expect(result.current.size).toBe(2);
    });
    expect(binding.auth.getSandboxAutomation).toHaveBeenCalledTimes(2);
    expect(
      binding.auth.getSandboxAutomation.mock.calls.map(([e]) => e),
    ).toEqual([ENV_A, ENV_B]);
    expect(result.current.get(ENV_B)).toHaveLength(1);
  });

  it("omits an environment whose read has not answered", async () => {
    const binding = mocks.binding;
    if (binding === null) throw new Error("the binding was not set");
    binding.auth.getSandboxAutomation.mockImplementation(
      () => new Promise(() => undefined),
    );
    const { result } = renderHook(() => useSandboxTeamPods(ONLY_A), {
      wrapper: wrapper(),
    });
    await waitFor(() => {
      expect(binding.auth.getSandboxAutomation).toHaveBeenCalledTimes(1);
    });
    expect(result.current.size).toBe(0);
  });

  it("reads nothing for no environments", async () => {
    const binding = mocks.binding;
    if (binding === null) throw new Error("the binding was not set");
    const { result } = renderHook(() => useSandboxTeamPods(NO_ENVIRONMENTS), {
      wrapper: wrapper(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.size).toBe(0);
    expect(binding.auth.getSandboxAutomation).not.toHaveBeenCalled();
  });

  it("shares the read with a pod card's own useSandboxAutomation of the same environment", async () => {
    const binding = mocks.binding;
    if (binding === null) throw new Error("the binding was not set");
    scriptPods(binding);

    // Mounted together, as the picker and a pod card beside it are.
    const { result } = renderHook(
      () => ({
        picker: useSandboxTeamPods(ONLY_A),
        card: useSandboxAutomation(ENV_A),
      }),
      { wrapper: wrapper() },
    );

    await waitFor(() => {
      expect(result.current.picker.get(ENV_A)).toHaveLength(3);
      expect(result.current.card.data?.pods).toHaveLength(3);
    });
    expect(binding.auth.getSandboxAutomation).toHaveBeenCalledTimes(1);
    expect(binding.auth.getSandboxAutomation).toHaveBeenCalledWith(ENV_A);
  });
});
