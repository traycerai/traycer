import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HOST_SANDBOX_STATES } from "@traycer/protocol/host/host-status";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { SandboxEgressEvent } from "@traycer/protocol/host/sandbox-egress";
import type {
  SandboxGrant,
  SandboxGrantsSummary,
} from "@traycer/protocol/host/sandbox-secrets";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import type {
  SandboxCatalogue,
  SandboxCost,
  UserSandboxCost,
} from "@traycer/protocol/host/sandbox-control";
import type { SandboxRunwayWarning } from "@/lib/sandboxes/sandbox-balance";
import {
  createFakeSandboxBinding,
  refusal,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { useAuthStore } from "@/stores/auth/auth-store";
import { SANDBOX_VERB_FETCH_TIMEOUT_MS } from "@traycer-clients/shared/host-client/sandbox-control";

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastFromAuthError: vi.fn<(error: Error, title: string) => void>(),
  catalogue: null as SandboxCatalogue | null,
  costs: null as UserSandboxCost | null,
  warning: { kind: "none" } as SandboxRunwayWarning,
  /** `IRunnerHost.sandboxControlUnavailableReason`; `null` reaches the control plane. */
  unavailableReason: null as string | null,
  /** What `useSandboxEgressEvents` returns; the hook spy records its argument. */
  egressEvents: [] as readonly SandboxEgressEvent[],
  useEgressEvents: vi.fn<(hostId: string | null) => void>(),
  /** What `useHostSupportsMethod` answers for every method. */
  supportsMethod: false,
  useSupportsMethod: vi.fn<(hostId: string | null, method: string) => void>(),
  repairPending: false,
  repairMutate: vi.fn<(variables: object, options: object) => void>(),
  /** What `useSandboxGrants` returns; the hook spy records its argument. */
  grantsData: undefined as SandboxGrantsSummary | null | undefined,
  grantsError: false,
  grantsFetching: false,
  grantsRefetch: vi.fn<() => void>(),
  useGrants:
    vi.fn<(environmentId: string | null, hostId: string | null) => void>(),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, info: mocks.toastInfo },
}));
vi.mock("@/lib/auth-error-toast", () => ({
  toastFromAuthError: mocks.toastFromAuthError,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ refreshHostFleet: vi.fn() }),
  useRunnerHostOrNull: () => ({
    sandboxControlUnavailableReason: mocks.unavailableReason,
  }),
}));
vi.mock("@/lib/host/fleet-refresh", () => ({ requestFleetRefresh: vi.fn() }));
// The secrets section's live parts talk to the sandbox host itself; the card's
// own suite has no host runtime, and they have their own tests.
vi.mock("@/hooks/sandboxes/use-sandbox-egress-events", () => ({
  useSandboxEgressEvents: (hostId: string | null) => {
    mocks.useEgressEvents(hostId);
    return mocks.egressEvents;
  },
}));
vi.mock("@/hooks/sandboxes/use-sandbox-grants-query", () => ({
  useSandboxGrants: (environmentId: string | null, hostId: string | null) => {
    mocks.useGrants(environmentId, hostId);
    return {
      data: mocks.grantsData,
      isError: mocks.grantsError,
      isFetching: mocks.grantsFetching,
      refetch: mocks.grantsRefetch,
    };
  },
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: (hostId: string | null, method: string) => {
    mocks.useSupportsMethod(hostId, method);
    return mocks.supportsMethod;
  },
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation",
  () => ({
    useSandboxRepairGuestConfiguration: () => ({
      isPending: mocks.repairPending,
      mutate: mocks.repairMutate,
    }),
  }),
);
vi.mock("@/hooks/sandboxes/use-refresh-sandbox-costs", () => ({
  useRefreshSandboxCosts: () => undefined,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: mocks.catalogue }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-costs-query", () => ({
  useSandboxCosts: () => ({ data: mocks.costs, isError: false }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-runway-warning", () => ({
  useSandboxRunwayWarning: () => mocks.warning,
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: null }),
}));

import { SandboxCard } from "@/components/hosts/sandbox-card";
import type { HostHealthState } from "@/components/settings/host-scope/host-health";
import { SANDBOX_STAND_IN_CLAUSE } from "@/lib/sandboxes/sandbox-grants-view";
import {
  buildHostScopeOptions,
  type HostScopeSandbox,
} from "@/components/settings/host-scope/host-scope-model";

const NAME = "build-box";

function renderCard(sandbox: HostScopeSandbox): void {
  renderCardOnHost(sandbox, null, "online");
}

function renderCardDestroyed(
  sandbox: HostScopeSandbox,
  onDestroyed: (() => void) | null,
): void {
  renderCardOnHost(sandbox, onDestroyed, "online");
}

function renderCardOnHost(
  sandbox: HostScopeSandbox,
  onDestroyed: (() => void) | null,
  hostState: HostHealthState,
): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SandboxCard
        hostName="Host name"
        hostState={hostState}
        sandbox={sandbox}
        likeThis={{ kind: "personal" }}
        onDestroyed={onDestroyed}
      />
    </QueryClientProvider>,
  );
}

function sandboxOf(
  state: HostScopeSandbox["state"],
  frozen: boolean,
  overrides: Parameters<typeof sandboxSummaryFixture>[0],
): HostScopeSandbox {
  return {
    state,
    frozen,
    summary: sandboxSummaryFixture({
      displayName: NAME,
      state: state ?? "awake",
      frozen,
      ...overrides,
    }),
    teamOwned: false,
  };
}

function actionTestIds(): string[] {
  return screen
    .queryAllByTestId(/^sandbox-card-(suspend|resume|stop|start|destroy)$/)
    .map((el) => el.getAttribute("data-testid") ?? "");
}

const COST: SandboxCost = {
  sandboxId: "sbx_1",
  currentRateMillicreditsPerHour: 120,
  state: "awake",
  frozen: false,
  charged: {
    computeMillicredits: 5_000,
    storageMillicredits: 1_000,
    sinceCreatedAt: new Date(2026, 9, 1, 12).getTime(),
  },
  pendingMillicredits: 500,
  segments: [],
};

beforeEach(() => {
  mocks.binding = createFakeSandboxBinding();
  mocks.catalogue = null;
  mocks.costs = null;
  mocks.warning = { kind: "none" };
  mocks.unavailableReason = null;
  mocks.egressEvents = [];
  mocks.supportsMethod = false;
  mocks.repairPending = false;
  mocks.grantsData = undefined;
  mocks.grantsError = false;
  mocks.grantsFetching = false;
  mocks.grantsRefetch.mockClear();
  mocks.useGrants.mockClear();
  mocks.useEgressEvents.mockClear();
  mocks.useSupportsMethod.mockClear();
  mocks.repairMutate.mockClear();
  mocks.toastSuccess.mockClear();
  mocks.toastInfo.mockClear();
  mocks.toastFromAuthError.mockClear();
});
afterEach(cleanup);

describe("<SandboxCard /> per state", () => {
  const ACTIONS: Record<string, readonly string[]> = {
    creating: [],
    awake: ["suspend", "stop", "destroy"],
    suspending: ["destroy"],
    suspended: ["resume", "destroy"],
    resuming: [],
    stopping: ["destroy"],
    stopped: ["start", "destroy"],
    starting: [],
    destroying: [],
    destroyed: [],
    failed: ["destroy"],
    released: ["destroy"],
  };

  it("renders every state's copy, badge word and exactly its allowed actions", () => {
    const seenLines = new Set<string>();
    for (const state of HOST_SANDBOX_STATES) {
      renderCard(sandboxOf(state, false, {}));
      const card = screen.getByTestId("sandbox-card");
      expect(card.getAttribute("data-state")).toBe(state);
      expect(card.getAttribute("data-frozen")).toBe("false");
      expect(
        screen.getByTestId("sandbox-card-state").textContent.toLowerCase(),
      ).toBe(state);
      seenLines.add(screen.getByTestId("sandbox-card-state-line").textContent);
      expect(actionTestIds()).toEqual(
        ACTIONS[state].map((action) => `sandbox-card-${action}`),
      );
      cleanup();
    }
    // Twelve states, twelve different sentences.
    expect(seenLines.size).toBe(HOST_SANDBOX_STATES.length);
  });

  it("shows a frozen row the frozen line, a Frozen badge and Destroy alone", () => {
    renderCard(
      sandboxOf("suspended", true, {
        frozenAt: new Date(2026, 9, 9, 12).getTime(),
      }),
    );
    expect(screen.getByTestId("sandbox-card").getAttribute("data-frozen")).toBe(
      "true",
    );
    expect(screen.getByTestId("sandbox-card-state").textContent).toBe("Frozen");
    expect(screen.getByTestId("sandbox-card-state-line").textContent).toMatch(
      /^Frozen: out of credits\. Top up to resume\. Destroyed on /,
    );
    expect(actionTestIds()).toEqual(["sandbox-card-destroy"]);
  });

  it("shows a destroyed row its destroyed copy and badge, not the frozen line, when its summary kept the frozen flag", () => {
    renderCard(sandboxOf("destroyed", false, {}));
    const destroyedLine = screen.getByTestId(
      "sandbox-card-state-line",
    ).textContent;
    cleanup();

    // The scope folds the registry's flag with the state; the control plane's
    // summary row keeps its last `frozen` value after a destroy.
    renderCard(sandboxOf("destroyed", false, { frozen: true }));
    const card = screen.getByTestId("sandbox-card");
    expect(card.getAttribute("data-state")).toBe("destroyed");
    expect(card.getAttribute("data-frozen")).toBe("false");
    expect(screen.getByTestId("sandbox-card-state").textContent).toBe(
      "Destroyed",
    );
    expect(screen.getByTestId("sandbox-card-state-line").textContent).toBe(
      destroyedLine,
    );
    expect(destroyedLine).not.toMatch(/Frozen/);
    expect(actionTestIds()).toEqual([]);
  });

  it("offers a frozen-but-awake row Destroy as well: the meter freezes before it suspends", () => {
    renderCard(sandboxOf("awake", true, {}));
    expect(actionTestIds()).toEqual(["sandbox-card-destroy"]);
  });

  it("shows its shape, region, rate and idle rule, and the Created-by line only for a burst row", () => {
    renderCard(
      sandboxOf("awake", false, {
        burst: true,
        idleMinutes: 120,
        cpus: 4,
        memoryMb: 8192,
        region: "eu-west",
      }),
    );
    expect(screen.getByTestId("sandbox-card-shape").textContent).toContain(
      "4 vCPU",
    );
    expect(screen.getByTestId("sandbox-card-region").textContent).toBe(
      "eu-west",
    );
    expect(screen.getByTestId("sandbox-card-rate").textContent).toContain(
      "credits/hour awake",
    );
    expect(screen.getByTestId("sandbox-card-idle").textContent).toBe(
      "Destroyed after 2 h idle",
    );
    expect(screen.getByText("An agent, for one task")).toBeDefined();
    cleanup();

    renderCard(sandboxOf("awake", false, { burst: false }));
    expect(screen.queryByText("An agent, for one task")).toBeNull();
    expect(screen.getByTestId("sandbox-card-idle").textContent).toBe(
      "Suspends after 30 min idle",
    );
  });

  it("renders the guest's configuration failure as plain text, only when the guest reported one", () => {
    renderCard(
      sandboxOf("awake", false, {
        guestConfigured: false,
        guestConfigFailureReason: "<b>broker</b> unreachable",
      }),
    );
    const failure = screen.getByTestId("sandbox-card-guest-config-failure");
    expect(failure.textContent).toBe(
      "Guest setup failed: <b>broker</b> unreachable",
    );
    expect(failure.querySelector("b")).toBeNull();
    cleanup();

    renderCard(sandboxOf("awake", false, { guestConfigured: true }));
    expect(
      screen.queryByTestId("sandbox-card-guest-config-failure"),
    ).toBeNull();
  });

  it("says what a suspend keeps from the provider's catalogue, but not on a burst sandbox", () => {
    mocks.catalogue = {
      providers: [
        {
          provider: "tensorlake",
          os: ["linux"],
          shape: {
            cpuMin: 1,
            cpuMax: 16,
            cpuStep: 1,
            memoryPerCpuMinMb: 1024,
            memoryPerCpuMaxMb: 8192,
            memoryMinMb: 1024,
            memoryMaxMb: 65536,
            memoryStepMb: 512,
            diskMinMb: 10240,
            diskMaxMb: 102400,
            diskDefaultMb: 20480,
          },
          suspendFidelity: "memory",
          stoppedStorage: "snapshot",
          wakeClass: "resume",
          dockerInGuest: true,
          creatable: true,
          notCreatableReason: null,
          regions: [],
        },
      ],
    };
    renderCard(sandboxOf("awake", false, { burst: false }));
    expect(
      screen.getByTestId("sandbox-card-suspend-keeps").textContent,
    ).toContain("keeps memory");
    cleanup();
    renderCard(sandboxOf("awake", false, { burst: true }));
    expect(screen.queryByTestId("sandbox-card-suspend-keeps")).toBeNull();
  });

  it("reads what a suspend keeps from the catalogue entry of the sandbox's own OS", () => {
    // A provider serving two OSes is one catalogue entry per OS, each with
    // its own suspend: the card of one OS never says what the other keeps.
    const entry = {
      provider: "daytona",
      shape: {
        cpuMin: 1,
        cpuMax: 4,
        cpuStep: 1,
        memoryPerCpuMinMb: 1024,
        memoryPerCpuMaxMb: 8192,
        memoryMinMb: 1024,
        memoryMaxMb: 16384,
        memoryStepMb: 512,
        diskMinMb: 10240,
        diskMaxMb: 51200,
        diskDefaultMb: 10240,
      },
      stoppedStorage: "disk",
      dockerInGuest: false,
      creatable: true,
      notCreatableReason: null,
      regions: [],
    };
    mocks.catalogue = {
      providers: [
        {
          ...entry,
          os: ["linux"],
          suspendFidelity: "disk",
          wakeClass: "cold-boot",
        },
        {
          ...entry,
          os: ["windows"],
          suspendFidelity: "memory",
          wakeClass: "resume",
        },
      ],
    };
    renderCard(
      sandboxOf("awake", false, { provider: "daytona", os: "windows" }),
    );
    expect(
      screen.getByTestId("sandbox-card-suspend-keeps").textContent,
    ).toContain("keeps memory");
    cleanup();
    renderCard(sandboxOf("awake", false, { provider: "daytona", os: "linux" }));
    expect(
      screen.getByTestId("sandbox-card-suspend-keeps").textContent,
    ).toContain("disk only");
  });

  it("shows the cost view and the runway warning when the figures and the warning are in", () => {
    mocks.costs = { sandboxes: [COST], awakeBurnMillicreditsPerHour: 120 };
    mocks.warning = { kind: "critical", runwayMinutes: 20 };
    renderCard(sandboxOf("awake", false, {}));
    expect(screen.getByTestId("sandbox-card-cost-now").textContent).toBe(
      "0.12 credits/hour",
    );
    expect(
      screen.getByTestId("sandbox-card-cost-charged").textContent,
    ).toContain("6.00 credits since");
    expect(
      screen.getByTestId("sandbox-card-cost-charged").textContent,
    ).toContain("0.50 pending");
    const warning = screen.getByTestId("sandbox-balance-warning");
    expect(warning.getAttribute("data-level")).toBe("critical");
    expect(warning.textContent).toContain("20 min");
  });
});

/**
 * The card's `sandbox` prop as the scope builder resolves it, for the cases
 * that are about WHICH answer the card shows: the host list's facts (registry
 * row, then directory entry) when it has them, the sandbox list's summary
 * otherwise. `listed` is what `GET /api/v3/hosts?include=sandboxState` said;
 * `null` is a registry row that carried no sandbox facts (and no directory
 * entry to copy them from).
 */
function resolvedSandbox(input: {
  readonly listed: {
    readonly state: HostScopeSandbox["state"];
    readonly frozen: boolean;
  } | null;
  readonly summaryFrozen: boolean;
}): HostScopeSandbox {
  const item: HostListItem = {
    hostId: "sbx-host",
    displayName: "Build box",
    platform: "linux",
    kind: "sandbox",
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
    profile: "agent",
    ...(input.listed === null
      ? {}
      : {
          sandboxState: input.listed.state,
          sandboxFrozen: input.listed.frozen,
        }),
  };
  const options = buildHostScopeOptions({
    leases: [],
    authorityAttached: false,
    directory:
      input.listed === null
        ? []
        : [hostListItemToDirectoryEntry(item, "wss://relay.example.test")],
    registry: [item],
    localHostId: null,
    activeHostId: null,
    localService: undefined,
    hasLiveSession: () => false,
    localHostSettingUp: false,
    sandboxes: [
      sandboxSummaryFixture({
        id: "sbx_1",
        hostId: "sbx-host",
        displayName: NAME,
        state: "suspended",
        frozen: input.summaryFrozen,
      }),
    ],
    nowMs: 0,
  });
  const sandbox = options.find(
    (option) => option.hostId === "sbx-host",
  )?.sandbox;
  if (sandbox === undefined || sandbox === null) {
    throw new Error("the builder produced no sandbox facts for the row");
  }
  return sandbox;
}

describe("<SandboxCard /> facts as the scope resolves them", () => {
  it("shows the host list's thaw, not the stale summary's frozen flag", () => {
    const sandbox = resolvedSandbox({
      listed: { state: "suspended", frozen: false },
      summaryFrozen: true,
    });
    // The builder prefers the host list: thawed.
    expect(sandbox.frozen).toBe(false);

    renderCard(sandbox);

    expect(screen.getByTestId("sandbox-card").getAttribute("data-frozen")).toBe(
      "false",
    );
    expect(screen.getByTestId("sandbox-card-state").textContent).not.toBe(
      "Frozen",
    );
    expect(
      screen.getByTestId("sandbox-card-state-line").textContent,
    ).not.toMatch(/^Frozen/);
    expect(actionTestIds()).toEqual([
      "sandbox-card-resume",
      "sandbox-card-destroy",
    ]);
  });

  it("control: shows a frozen row when the host list says frozen, whatever the summary says", () => {
    const sandbox = resolvedSandbox({
      listed: { state: "suspended", frozen: true },
      summaryFrozen: false,
    });
    expect(sandbox.frozen).toBe(true);

    renderCard(sandbox);

    expect(screen.getByTestId("sandbox-card").getAttribute("data-frozen")).toBe(
      "true",
    );
    expect(screen.getByTestId("sandbox-card-state").textContent).toBe("Frozen");
    expect(screen.getByTestId("sandbox-card-state-line").textContent).toMatch(
      /^Frozen: out of credits/,
    );
    expect(actionTestIds()).toEqual(["sandbox-card-destroy"]);
  });

  it("control: falls back to the summary's frozen flag when the host list carries no sandbox facts", () => {
    const sandbox = resolvedSandbox({ listed: null, summaryFrozen: true });
    // The builder's fallback, not a hand-written prop.
    expect(sandbox.frozen).toBe(true);
    expect(sandbox.state).toBe("suspended");

    renderCard(sandbox);

    expect(screen.getByTestId("sandbox-card").getAttribute("data-frozen")).toBe(
      "true",
    );
    expect(screen.getByTestId("sandbox-card-state").textContent).toBe("Frozen");
    expect(actionTestIds()).toEqual(["sandbox-card-destroy"]);
  });
});

describe("<SandboxCard /> without a summary", () => {
  // The details come from the sandbox list, which loads for a signed-in user.
  beforeEach(() => {
    useAuthStore.setState({ status: "signed-in" });
  });
  afterEach(() => {
    useAuthStore.setState({ status: "signed-out" });
  });

  function renderWithoutSummary(state: HostScopeSandbox["state"]): void {
    renderCard({ state, frozen: false, summary: null, teamOwned: false });
  }

  it("says it is loading while the list has not answered", async () => {
    mocks.binding?.auth.listSandboxes.mockImplementation(
      () => new Promise(() => undefined),
    );
    renderWithoutSummary("suspended");

    await screen.findByText("Loading this sandbox's details…");
    expect(screen.queryByTestId("sandbox-card-details-reload")).toBeNull();
  });

  it("says the details could not be loaded when the list failed, and Retry reads the list again", async () => {
    mocks.binding?.auth.listSandboxes.mockResolvedValue({
      kind: "network-error",
      detail: "the request never completed (TypeError)",
    });
    renderWithoutSummary("suspended");

    const failed = await screen.findByTestId("sandbox-card-details-failed");
    expect(failed.textContent).toContain(
      "Couldn't load this sandbox's details.",
    );
    const retry = screen.getByTestId("sandbox-card-details-reload");
    expect(retry.textContent).toBe("Retry");
    const reads = mocks.binding?.auth.listSandboxes.mock.calls.length ?? 0;

    fireEvent.click(retry);

    await waitFor(() => {
      expect(mocks.binding?.auth.listSandboxes).toHaveBeenCalledTimes(
        reads + 1,
      );
    });
  });

  it("says why instead of loading when the build cannot reach the control plane, and never reads the list", async () => {
    mocks.unavailableReason =
      "Sandboxes aren't available in the staging build.";
    renderWithoutSummary("suspended");

    const line = await screen.findByTestId("sandbox-card-details-unavailable");
    expect(line.textContent).toBe(
      "Sandboxes aren't available in the staging build.",
    );
    expect(screen.queryByText("Loading this sandbox's details…")).toBeNull();
    expect(screen.queryByTestId("sandbox-card-details-reload")).toBeNull();
    expect(screen.queryByTestId("sandbox-card-details-failed")).toBeNull();
    expect(mocks.binding?.auth.listSandboxes).not.toHaveBeenCalled();
  });

  it("says a destroyed sandbox was destroyed once the list answered without it", async () => {
    mocks.binding?.auth.listSandboxes.mockResolvedValue({
      kind: "ok",
      response: { sandboxes: [] },
    });
    renderWithoutSummary("destroyed");

    const destroyed = await screen.findByTestId(
      "sandbox-card-details-destroyed",
    );
    expect(destroyed.textContent).toBe("This sandbox was destroyed.");
    expect(screen.queryByTestId("sandbox-card-details-reload")).toBeNull();
  });

  it("says any other sandbox missing from an answered list is not in it, and Refresh reads the list again", async () => {
    mocks.binding?.auth.listSandboxes.mockResolvedValue({
      kind: "ok",
      response: { sandboxes: [] },
    });
    renderWithoutSummary("suspended");

    const absent = await screen.findByTestId("sandbox-card-details-absent");
    expect(absent.textContent).toContain("Not in your sandbox list.");
    const refresh = screen.getByTestId("sandbox-card-details-reload");
    expect(refresh.textContent).toBe("Refresh");
    const reads = mocks.binding?.auth.listSandboxes.mock.calls.length ?? 0;

    fireEvent.click(refresh);

    await waitFor(() => {
      expect(mocks.binding?.auth.listSandboxes).toHaveBeenCalledTimes(
        reads + 1,
      );
    });
  });
});

describe("<SandboxCard /> verbs", () => {
  function suspend(): void {
    fireEvent.click(screen.getByTestId("sandbox-card-suspend"));
  }

  it("toasts success naming the sandbox when the verb lands at rest (200)", async () => {
    renderCard(sandboxOf("awake", false, {}));
    suspend();
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith(`Suspended ${NAME}`);
    });
    expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledWith(
      "sbx_1",
      "suspend",
      SANDBOX_VERB_FETCH_TIMEOUT_MS,
    );
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });

  it("toasts info, not success, when the server's deadline passed with the row still moving (202)", async () => {
    mocks.binding?.auth.runSandboxVerb.mockResolvedValue({
      kind: "ok",
      settled: false,
    });
    renderCard(sandboxOf("awake", false, {}));
    suspend();
    await waitFor(() => {
      expect(mocks.toastInfo).toHaveBeenCalledWith(`Suspending ${NAME}…`);
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("says nothing when the row was destroyed while the verb waited (404 sandbox_not_found)", async () => {
    mocks.binding?.auth.runSandboxVerb.mockResolvedValue(
      refusal(404, "sandbox_not_found"),
    );
    renderCard(sandboxOf("awake", false, {}));
    suspend();
    await waitFor(() => {
      expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
    });
    // Let the mutation settle before asserting the absence of a toast.
    await waitFor(() => {
      expect(mocks.binding?.directory.refresh).toHaveBeenCalledTimes(1);
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.toastFromAuthError).not.toHaveBeenCalled();
  });

  it("disables the other verbs while one runs but leaves Destroy usable", async () => {
    // Held in an object: TS narrows a `let` assigned only in a callback to `never`.
    const gate: { finish: (() => void) | null } = { finish: null };
    mocks.binding?.auth.runSandboxVerb.mockImplementation(
      () =>
        new Promise((resolve) => {
          gate.finish = () => resolve({ kind: "ok", settled: true });
        }),
    );
    renderCard(sandboxOf("awake", false, {}));
    suspend();

    await waitFor(() => {
      expect(
        screen.getByTestId("sandbox-card-stop").hasAttribute("disabled"),
      ).toBe(true);
    });
    expect(
      screen.getByTestId("sandbox-card-suspend").hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByTestId("sandbox-card-suspend-spinner")).toBeDefined();
    expect(
      screen.getByTestId("sandbox-card-destroy").hasAttribute("disabled"),
    ).toBe(false);

    gate.finish?.();
    await waitFor(() => {
      expect(
        screen.getByTestId("sandbox-card-stop").hasAttribute("disabled"),
      ).toBe(false);
    });
  });
});

describe("<SandboxCard /> Automations row", () => {
  it("offers an awake row stop and destroy, never suspend, and says it is free", () => {
    renderCard(sandboxOf("awake", false, { kind: "automation" }));
    expect(actionTestIds()).toEqual([
      "sandbox-card-stop",
      "sandbox-card-destroy",
    ]);
    expect(screen.getByTestId("sandbox-card-rate").textContent).toBe("Free");
    expect(screen.getByTestId("sandbox-card-state-line").textContent).toBe(
      "Running. Automations aren't billed.",
    );
    expect(screen.getByTestId("sandbox-card-idle").textContent).toBe(
      "Released after a day with no shell",
    );
  });

  it("offers a released row start and destroy; Start sends the start verb", async () => {
    renderCard(sandboxOf("released", false, { kind: "automation" }));
    expect(actionTestIds()).toEqual([
      "sandbox-card-start",
      "sandbox-card-destroy",
    ]);
    fireEvent.click(screen.getByTestId("sandbox-card-start"));
    await waitFor(() => {
      expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
    });
    expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledWith(
      "sbx_1",
      "start",
      SANDBOX_VERB_FETCH_TIMEOUT_MS,
    );
  });
});

describe("<SandboxCard /> destroy", () => {
  function openDestroy(): void {
    fireEvent.click(screen.getByTestId("sandbox-card-destroy"));
  }

  it("asks for confirmation on a non-burst row and destroys nothing until it is given", async () => {
    renderCard(sandboxOf("suspended", false, { burst: false }));
    openDestroy();

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(within(dialog).getByText(`Destroy ${NAME}?`)).toBeDefined();
    expect(within(dialog).getByText(/can't be recovered/)).toBeDefined();
    // No typed confirmation on a row that is not frozen.
    expect(screen.queryByTestId("sandbox-card-destroy-typed")).toBeNull();
    expect(mocks.binding?.auth.destroySandbox).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => {
      expect(mocks.binding?.auth.destroySandbox).toHaveBeenCalledWith("sbx_1");
    });
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith(`Destroyed ${NAME}`);
    });
  });

  it("destroys nothing when the confirmation is cancelled", async () => {
    renderCard(sandboxOf("suspended", false, {}));
    openDestroy();
    await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
    expect(mocks.binding?.auth.destroySandbox).not.toHaveBeenCalled();
  });

  it("toasts Destroying…, not Destroyed, when the server answers 202", async () => {
    mocks.binding?.auth.destroySandbox.mockResolvedValue({
      kind: "ok",
      settled: false,
    });
    renderCard(sandboxOf("suspended", false, {}));
    openDestroy();
    await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(mocks.toastInfo).toHaveBeenCalledWith(`Destroying ${NAME}…`);
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("toasts Destroyed when the row was already gone (404 sandbox_not_found)", async () => {
    mocks.binding?.auth.destroySandbox.mockResolvedValue(
      refusal(404, "sandbox_not_found"),
    );
    renderCard(sandboxOf("suspended", false, {}));
    openDestroy();
    await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith(`Destroyed ${NAME}`);
    });
  });

  describe("onDestroyed (an unenrolled row returns Settings to the active host)", () => {
    async function confirmDestroy(): Promise<void> {
      openDestroy();
      await screen.findByTestId("confirm-destructive-dialog");
      fireEvent.click(screen.getByTestId("confirm-action"));
    }

    it("calls onDestroyed once when the destroy settled (gone)", async () => {
      const onDestroyed = vi.fn<() => void>();
      renderCardDestroyed(sandboxOf("suspended", false, {}), onDestroyed);
      await confirmDestroy();

      await waitFor(() => {
        expect(mocks.toastSuccess).toHaveBeenCalledWith(`Destroyed ${NAME}`);
      });
      expect(onDestroyed).toHaveBeenCalledTimes(1);
    });

    it("calls onDestroyed when the row was already gone (404 sandbox_not_found)", async () => {
      mocks.binding?.auth.destroySandbox.mockResolvedValue(
        refusal(404, "sandbox_not_found"),
      );
      const onDestroyed = vi.fn<() => void>();
      renderCardDestroyed(sandboxOf("suspended", false, {}), onDestroyed);
      await confirmDestroy();

      await waitFor(() => {
        expect(mocks.toastSuccess).toHaveBeenCalledWith(`Destroyed ${NAME}`);
      });
      expect(onDestroyed).toHaveBeenCalledTimes(1);
    });

    it("does not call onDestroyed when the destroy was accepted but is not gone yet (202)", async () => {
      mocks.binding?.auth.destroySandbox.mockResolvedValue({
        kind: "ok",
        settled: false,
      });
      const onDestroyed = vi.fn<() => void>();
      renderCardDestroyed(sandboxOf("suspended", false, {}), onDestroyed);
      await confirmDestroy();

      await waitFor(() => {
        expect(mocks.toastInfo).toHaveBeenCalledWith(`Destroying ${NAME}…`);
      });
      expect(onDestroyed).not.toHaveBeenCalled();
    });

    it("destroys without throwing when onDestroyed is null", async () => {
      renderCardDestroyed(sandboxOf("suspended", false, {}), null);
      await confirmDestroy();

      await waitFor(() => {
        expect(mocks.binding?.auth.destroySandbox).toHaveBeenCalledWith(
          "sbx_1",
        );
      });
      await waitFor(() => {
        expect(mocks.toastSuccess).toHaveBeenCalledWith(`Destroyed ${NAME}`);
      });
    });
  });

  describe("the typed-name gate on a frozen row", () => {
    async function openFrozen(): Promise<HTMLElement> {
      renderCard(sandboxOf("suspended", true, {}));
      openDestroy();
      await screen.findByTestId("confirm-destructive-dialog");
      const input = screen.getByTestId("sandbox-card-destroy-typed");
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("the typed confirmation is not an input");
      }
      return input;
    }

    it("keeps Confirm disabled while the field is empty and shows no red reason yet", async () => {
      await openFrozen();
      expect(
        screen.getByTestId("confirm-action").hasAttribute("disabled"),
      ).toBe(true);
      expect(screen.queryByTestId("confirm-blocked-reason")).toBeNull();
    });

    it("explains itself once something wrong is typed, and stays disabled", async () => {
      const input = await openFrozen();
      fireEvent.change(input, { target: { value: "build" } });
      expect(screen.getByTestId("confirm-blocked-reason").textContent).toBe(
        `Type ${NAME} below to destroy it.`,
      );
      expect(
        screen.getByTestId("confirm-action").hasAttribute("disabled"),
      ).toBe(true);
    });

    it("enables Confirm on the exact name, ignoring surrounding spaces, and then destroys", async () => {
      const input = await openFrozen();
      fireEvent.change(input, { target: { value: `  ${NAME} ` } });
      expect(screen.queryByTestId("confirm-blocked-reason")).toBeNull();
      const confirm = screen.getByTestId("confirm-action");
      expect(confirm.hasAttribute("disabled")).toBe(false);

      fireEvent.click(confirm);
      await waitFor(() => {
        expect(mocks.binding?.auth.destroySandbox).toHaveBeenCalledWith(
          "sbx_1",
        );
      });
    });

    it("clears what was typed when the dialog is opened again", async () => {
      const input = await openFrozen();
      fireEvent.change(input, { target: { value: "build" } });
      fireEvent.click(screen.getByTestId("confirm-cancel"));
      await waitFor(() => {
        expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
      });
      openDestroy();
      const reopened = await screen.findByTestId("sandbox-card-destroy-typed");
      expect(reopened).toHaveProperty("value", "");
    });
  });
});

describe("<SandboxCard /> secrets readiness", () => {
  it("shows a ready line for an awake sandbox whose egress canary answered", () => {
    renderCard(sandboxOf("awake", false, { phase: "proxy-reachable" }));

    const line = screen.getByTestId("sandbox-card-secrets-readiness");
    expect(line.getAttribute("data-tone")).toBe("ready");
  });

  it("shows no readiness line while the sandbox reports no phase", () => {
    renderCard(sandboxOf("awake", false, { phase: null }));

    expect(screen.queryByTestId("sandbox-card-secrets-readiness")).toBeNull();
  });

  it("shows a pending line while the sandbox is attaching to the gateway", () => {
    renderCard(sandboxOf("awake", false, { phase: "attaching" }));

    const line = screen.getByTestId("sandbox-card-secrets-readiness");
    expect(line.getAttribute("data-tone")).toBe("pending");
  });

  it("shows no readiness line once the sandbox's host is offline", () => {
    renderCardOnHost(
      sandboxOf("awake", false, { phase: "ready" }),
      null,
      "offline",
    );

    expect(screen.queryByTestId("sandbox-card-secrets-readiness")).toBeNull();
  });
});

describe("<SandboxCard /> secrets section", () => {
  function teardownEvent(): SandboxEgressEvent {
    return {
      kind: "egress.teardown",
      id: "ev-teardown",
      at: new Date(2026, 9, 1, 12).getTime(),
      emitter: "gateway",
      untrusted: false,
      route: "route-1",
      reason: "revoke",
    };
  }

  function untrustedRefusalEvent(): SandboxEgressEvent {
    return {
      kind: "egress.refused",
      id: "ev-refused",
      at: new Date(2026, 9, 1, 12).getTime(),
      emitter: "reporter",
      untrusted: true,
      code: "grant_missing",
      route: null,
      host: "db.internal",
      protocol: "postgres",
      secret: "PROD_DB",
      howToRequest: null,
    };
  }

  it("is absent while the sandbox reports no phase", () => {
    renderCard(sandboxOf("awake", false, { phase: null }));

    expect(screen.queryByTestId("sandbox-card-secrets")).toBeNull();
  });

  it("mounts none of its live hooks while the sandbox reports no phase", () => {
    mocks.supportsMethod = true;

    renderCard(sandboxOf("awake", false, { phase: null }));

    expect(mocks.useEgressEvents).not.toHaveBeenCalled();
    expect(screen.queryByTestId("sandbox-card-repair")).toBeNull();
  });

  it("shows the section and no Docker note for an awake, ready sandbox", () => {
    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    // No sandbox image carries Docker, so the card says nothing about
    // using secrets from a container.
    expect(screen.getByTestId("sandbox-card-secrets")).toBeTruthy();
    expect(screen.queryByTestId("sandbox-card-docker-note")).toBeNull();
  });

  it("shows no event list while there are no events", () => {
    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    expect(screen.queryByTestId("sandbox-card-egress-events")).toBeNull();
    expect(screen.queryByTestId("sandbox-card-egress-event")).toBeNull();
  });

  it("lists a teardown event as a closed line", () => {
    mocks.egressEvents = [teardownEvent()];

    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    const item = screen.getByTestId("sandbox-card-egress-event");
    expect(item.getAttribute("data-tone")).toBe("closed");
    expect(item.textContent).toContain("Connections closed");
    expect(item.textContent).not.toContain("reported by the sandbox");
  });

  it("says an untrusted refusal was reported by the sandbox", () => {
    mocks.egressEvents = [untrustedRefusalEvent()];

    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    const item = screen.getByTestId("sandbox-card-egress-event");
    expect(item.getAttribute("data-tone")).toBe("refused");
    expect(item.textContent).toContain("reported by the sandbox");
  });

  it("subscribes to the egress events of the summary's host while awake", () => {
    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    expect(mocks.useEgressEvents).toHaveBeenLastCalledWith("host-sbx-1");
  });

  it("subscribes to nothing while the sandbox is suspended", () => {
    renderCard(sandboxOf("suspended", false, { phase: "ready" }));

    expect(screen.getByTestId("sandbox-card-secrets")).toBeTruthy();
    expect(mocks.useEgressEvents).toHaveBeenLastCalledWith(null);
    expect(mocks.useEgressEvents).not.toHaveBeenCalledWith("host-sbx-1");
  });

  it("subscribes to nothing for a frozen sandbox", () => {
    renderCard(sandboxOf("awake", true, { phase: "ready" }));

    expect(mocks.useEgressEvents).toHaveBeenLastCalledWith(null);
  });

  describe("the repair action", () => {
    it("is hidden when the host does not serve the verb", () => {
      mocks.supportsMethod = false;

      renderCard(sandboxOf("awake", false, { phase: "ready" }));

      expect(screen.queryByTestId("sandbox-card-repair")).toBeNull();
    });

    it("is hidden while the sandbox is not awake, even when the host serves the verb", () => {
      mocks.supportsMethod = true;

      renderCard(sandboxOf("suspended", false, { phase: "ready" }));

      expect(screen.queryByTestId("sandbox-card-repair")).toBeNull();
    });

    it("asks the summary's host about the verb", () => {
      mocks.supportsMethod = true;

      renderCard(sandboxOf("awake", false, { phase: "ready" }));

      expect(mocks.useSupportsMethod).toHaveBeenLastCalledWith(
        "host-sbx-1",
        "host.sandbox.repairGuestConfiguration",
      );
    });

    it("is shown for an awake sandbox on a host that serves the verb, and runs the mutation with an empty request", () => {
      mocks.supportsMethod = true;
      renderCard(sandboxOf("awake", false, { phase: "ready" }));

      const button = screen.getByTestId("sandbox-card-repair");
      expect(button.hasAttribute("disabled")).toBe(false);
      expect(screen.queryByTestId("sandbox-card-repair-spinner")).toBeNull();
      fireEvent.click(button);

      expect(mocks.repairMutate).toHaveBeenCalledTimes(1);
      expect(mocks.repairMutate.mock.lastCall?.[0]).toEqual({});
    });

    it("is disabled and shows a spinner while the repair is pending", () => {
      mocks.supportsMethod = true;
      mocks.repairPending = true;

      renderCard(sandboxOf("awake", false, { phase: "ready" }));

      expect(
        screen.getByTestId("sandbox-card-repair").hasAttribute("disabled"),
      ).toBe(true);
      expect(screen.getByTestId("sandbox-card-repair-spinner")).toBeTruthy();
    });
  });
});

describe("<SandboxCard /> grants list", () => {
  function grantOf(overrides: Partial<SandboxGrant>): SandboxGrant {
    return {
      secretName: "PROD_DB",
      kind: "password",
      protocol: "postgres",
      mode: "brokered",
      source: "approved",
      connectorName: null,
      rotation: null,
      routes: [
        {
          route: "route-1",
          destination: "db.internal",
          port: 5432,
          unready: null,
        },
      ],
      ...overrides,
    };
  }

  function grantsOf(
    grants: readonly SandboxGrant[],
    github: SandboxGrantsSummary["github"],
  ): SandboxGrantsSummary {
    return { version: 3, grants, github };
  }

  it("asks the broker about the summary's host, in the summary's environment", () => {
    mocks.grantsData = grantsOf([], null);

    renderCard(
      sandboxOf("awake", false, {
        phase: "ready",
        environmentId: "env-team-1",
      }),
    );

    expect(mocks.useGrants).toHaveBeenLastCalledWith(
      "env-team-1",
      "host-sbx-1",
    );
  });

  it("asks in the Personal environment when the summary names none", () => {
    mocks.grantsData = grantsOf([], null);

    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    expect(mocks.useGrants).toHaveBeenLastCalledWith(null, "host-sbx-1");
  });

  it("lists each grant with its routes and their readiness", () => {
    mocks.grantsData = grantsOf(
      [
        grantOf({}),
        grantOf({
          secretName: "CACHE_KEY",
          protocol: "redis",
          routes: [
            {
              route: "route-2",
              destination: "cache.internal",
              port: 6379,
              unready: null,
            },
            {
              route: "route-3",
              destination: "cache-2.internal",
              port: null,
              unready: null,
            },
          ],
        }),
      ],
      null,
    );

    renderCard(
      sandboxOf("awake", false, {
        phase: "ready",
        routes: [
          { route: "route-1", state: "ready", code: null },
          { route: "route-2", state: "pending", code: null },
          { route: "route-3", state: "unavailable", code: "connector_offline" },
        ],
      }),
    );

    const list = screen.getByTestId("sandbox-card-grants");
    const grants = within(list).getAllByTestId("sandbox-card-grant");
    expect(grants).toHaveLength(2);
    expect(grants[0].textContent).toContain("PROD_DB");
    expect(grants[0].textContent).toContain("postgres · brokered");
    expect(grants[0].textContent).toContain("approved for this sandbox");
    const routes = within(list).getAllByTestId("sandbox-card-grant-route");
    expect(routes.map((route) => route.getAttribute("data-readiness"))).toEqual(
      ["ready", "pending", "unavailable"],
    );
    expect(routes[0].textContent).toContain("db.internal:5432");
    expect(routes[0].textContent).toContain("ready");
    expect(routes[1].textContent).toContain("not used yet");
    expect(routes[2].textContent).toContain("cache-2.internal");
    expect(routes[2].textContent).toContain("Connector is offline");
  });

  it("shows no reported route state once the sandbox's host is offline, but keeps the broker's", () => {
    mocks.grantsData = grantsOf(
      [
        grantOf({
          routes: [
            {
              route: "route-1",
              destination: "db.internal",
              port: 5432,
              unready: null,
            },
            {
              route: "route-2",
              destination: "cache.internal",
              port: 6379,
              unready: "connector_offline",
            },
          ],
        }),
      ],
      null,
    );

    // The host's last report says both are ready; it can no longer vouch for
    // that, while the broker's own word still stands.
    renderCardOnHost(
      sandboxOf("awake", false, {
        phase: "ready",
        routes: [
          { route: "route-1", state: "ready", code: null },
          { route: "route-2", state: "ready", code: null },
        ],
      }),
      null,
      "offline",
    );

    const routes = screen.getAllByTestId("sandbox-card-grant-route");
    expect(routes.map((route) => route.getAttribute("data-readiness"))).toEqual(
      ["unknown", "unavailable"],
    );
    expect(routes[0].textContent).not.toContain("ready");
  });

  it("shows a route whose connector the broker reports offline, by the connector's name", () => {
    mocks.grantsData = grantsOf(
      [
        grantOf({
          connectorName: "office-vpc",
          rotation: null,
          routes: [
            {
              route: "route-1",
              destination: "db.internal",
              port: 5432,
              unready: "connector_offline",
            },
          ],
        }),
      ],
      null,
    );

    // The sandbox's own last report says ready; the broker's word wins.
    renderCard(
      sandboxOf("awake", false, {
        phase: "ready",
        routes: [{ route: "route-1", state: "ready", code: null }],
      }),
    );

    const route = screen.getByTestId("sandbox-card-grant-route");
    expect(route.getAttribute("data-readiness")).toBe("unavailable");
    expect(route.textContent).toContain("db.internal:5432");
    expect(route.textContent).toContain("connector office-vpc offline");
  });

  it("shows no offline state once the broker reports the route usable again", () => {
    mocks.grantsData = grantsOf(
      [grantOf({ connectorName: "office-vpc" })],
      null,
    );

    renderCard(
      sandboxOf("awake", false, {
        phase: "ready",
        routes: [{ route: "route-1", state: "ready", code: null }],
      }),
    );

    const route = screen.getByTestId("sandbox-card-grant-route");
    expect(route.getAttribute("data-readiness")).toBe("ready");
    expect(route.textContent).not.toContain("offline");
  });

  it("marks a route the sandbox has not reported as unknown", () => {
    mocks.grantsData = grantsOf([grantOf({})], null);

    renderCard(sandboxOf("awake", false, { phase: "ready", routes: null }));

    const route = screen.getByTestId("sandbox-card-grant-route");
    expect(route.getAttribute("data-readiness")).toBe("unknown");
    expect(route.textContent).toBe("db.internal:5432");
  });

  it("shows an exposed grant without routes", () => {
    mocks.grantsData = grantsOf(
      [
        grantOf({
          secretName: "API_TOKEN",
          mode: "exposed",
          protocol: "https",
          routes: [],
        }),
      ],
      null,
    );

    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    const grant = screen.getByTestId("sandbox-card-grant");
    expect(grant.textContent).toContain("API_TOKEN");
    expect(grant.textContent).toContain(
      "https · exposed, readable on the sandbox",
    );
    expect(within(grant).queryByTestId("sandbox-card-grant-route")).toBeNull();
  });

  it("names the connector a grant goes through", () => {
    mocks.grantsData = grantsOf(
      [grantOf({ connectorName: "office-vpc" })],
      null,
    );

    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    expect(screen.getByTestId("sandbox-card-grant").textContent).toContain(
      "through connector office-vpc",
    );
  });

  it("says agents see a stand-in when a grant is brokered", () => {
    mocks.grantsData = grantsOf(
      [grantOf({ mode: "exposed", routes: [] }), grantOf({})],
      null,
    );

    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    expect(screen.getByTestId("sandbox-card-stand-in").textContent).toBe(
      SANDBOX_STAND_IN_CLAUSE,
    );
  });

  it("says nothing of a stand-in when every grant is exposed", () => {
    mocks.grantsData = grantsOf(
      [
        grantOf({ secretName: "API_TOKEN", mode: "exposed", routes: [] }),
        grantOf({ secretName: "OTHER", mode: "exposed", routes: [] }),
      ],
      null,
    );

    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    expect(screen.getByTestId("sandbox-card-grants")).toBeTruthy();
    expect(screen.queryByTestId("sandbox-card-stand-in")).toBeNull();
  });

  it("shows each grant's rotation line, and none for a grant without one", () => {
    mocks.grantsData = grantsOf(
      [
        grantOf({
          rotation: {
            state: "enforced",
            classes: [
              {
                workerClass: "postgres",
                status: "acknowledged",
                evidence: [{ kind: "session_closed", count: 1 }],
              },
            ],
          },
        }),
        grantOf({ secretName: "CACHE_KEY", protocol: "redis" }),
      ],
      null,
    );

    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    const grants = screen.getAllByTestId("sandbox-card-grant");
    expect(
      within(grants[0]).getByTestId("sandbox-card-grant-rotation").textContent,
    ).toBe("New value enforced: postgres, 1 session closed.");
    expect(
      within(grants[1]).queryByTestId("sandbox-card-grant-rotation"),
    ).toBeNull();
  });

  it("keeps a grant accepted until its class has proved the old value out of use", () => {
    mocks.grantsData = grantsOf(
      [
        grantOf({
          rotation: {
            state: "enforced",
            classes: [
              {
                workerClass: "postgres",
                status: "acknowledged",
                evidence: [{ kind: "session_closed", count: 0 }],
              },
            ],
          },
        }),
      ],
      null,
    );

    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    expect(screen.getByTestId("sandbox-card-grant-rotation").textContent).toBe(
      "New value accepted, closing old sessions.",
    );
  });

  it("says no secrets are granted for an empty grant set", () => {
    mocks.grantsData = grantsOf([], null);

    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    expect(screen.getByTestId("sandbox-card-grants").textContent).toContain(
      "No secrets are granted to this sandbox.",
    );
    expect(screen.queryByTestId("sandbox-card-grant")).toBeNull();
  });

  it("shows the GitHub line when the broker reports GitHub access", () => {
    mocks.grantsData = grantsOf([], {
      linked: true,
      installations: [
        { account: "traycerai", repositorySelection: "selected" },
      ],
    });

    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    expect(screen.getByTestId("sandbox-card-github").textContent).toBe(
      "GitHub: traycerai (selected repositories)",
    );
  });

  it("shows no GitHub line when the broker does not report it", () => {
    mocks.grantsData = grantsOf([grantOf({})], null);

    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    expect(screen.queryByTestId("sandbox-card-github")).toBeNull();
  });

  it("shows the grants for a suspended sandbox too", () => {
    mocks.grantsData = grantsOf([grantOf({})], null);

    renderCard(sandboxOf("suspended", false, { phase: "ready" }));

    expect(screen.getByTestId("sandbox-card-grant")).toBeTruthy();
  });

  it("shows the list and no live parts when the sandbox reports no phase", () => {
    mocks.supportsMethod = true;
    mocks.grantsData = grantsOf([grantOf({})], null);

    renderCard(sandboxOf("awake", false, { phase: null }));

    expect(screen.getByTestId("sandbox-card-secrets")).toBeTruthy();
    expect(screen.getByTestId("sandbox-card-grant")).toBeTruthy();
    expect(mocks.useEgressEvents).not.toHaveBeenCalled();
    expect(screen.queryByTestId("sandbox-card-repair")).toBeNull();
    expect(screen.queryByTestId("sandbox-card-docker-note")).toBeNull();
  });

  it("shows no secrets section with no phase and no grants answer", () => {
    mocks.grantsData = undefined;
    renderCard(sandboxOf("awake", false, { phase: null }));
    expect(screen.queryByTestId("sandbox-card-secrets")).toBeNull();
    cleanup();

    mocks.grantsData = null;
    renderCard(sandboxOf("awake", false, { phase: null }));
    expect(screen.queryByTestId("sandbox-card-secrets")).toBeNull();
  });

  it("shows nothing for the grants while the first answer is pending", () => {
    mocks.grantsData = undefined;

    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    expect(screen.getByTestId("sandbox-card-secrets")).toBeTruthy();
    expect(screen.queryByTestId("sandbox-card-grants")).toBeNull();
    expect(screen.queryByTestId("sandbox-card-grants-failed")).toBeNull();
  });

  it("says the grants could not be loaded and retries through refetch", () => {
    mocks.grantsError = true;

    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    expect(screen.queryByTestId("sandbox-card-grants")).toBeNull();
    expect(
      screen.getByTestId("sandbox-card-grants-failed").textContent,
    ).toContain("Couldn't load this sandbox's secrets.");
    fireEvent.click(screen.getByTestId("sandbox-card-grants-retry"));
    expect(mocks.grantsRefetch).toHaveBeenCalledTimes(1);
  });

  it("disables the retry while a refetch is in flight", () => {
    mocks.grantsError = true;
    mocks.grantsFetching = true;

    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    expect(
      screen.getByTestId("sandbox-card-grants-retry").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps the last good list through a failed refetch", () => {
    mocks.grantsData = grantsOf([grantOf({})], null);
    mocks.grantsError = true;

    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    expect(screen.getByTestId("sandbox-card-grant")).toBeTruthy();
    expect(screen.queryByTestId("sandbox-card-grants-failed")).toBeNull();
  });

  it("shows an egress event's route address when the grants summary names the route", () => {
    mocks.grantsData = grantsOf([grantOf({})], null);
    mocks.egressEvents = [
      {
        kind: "egress.teardown",
        id: "ev-teardown",
        at: new Date(2026, 9, 1, 12).getTime(),
        emitter: "gateway",
        untrusted: false,
        route: "route-1",
        reason: "revoke",
      },
    ];

    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    expect(
      screen.getByTestId("sandbox-card-egress-event").textContent,
    ).toContain("db.internal:5432 · ");
  });

  it("shows no address for an event whose route the summary does not name", () => {
    mocks.grantsData = grantsOf([grantOf({ routes: [] })], null);
    mocks.egressEvents = [
      {
        kind: "egress.teardown",
        id: "ev-teardown",
        at: new Date(2026, 9, 1, 12).getTime(),
        emitter: "gateway",
        untrusted: false,
        route: "route-1",
        reason: "revoke",
      },
    ];

    renderCard(sandboxOf("awake", false, { phase: "ready" }));

    expect(
      screen.getByTestId("sandbox-card-egress-event").textContent,
    ).not.toContain("db.internal");
  });
});
