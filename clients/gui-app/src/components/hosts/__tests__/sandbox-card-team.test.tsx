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
import type {
  SandboxCost,
  SandboxPod,
  SandboxSummary,
  UserSandboxCost,
} from "@traycer/protocol/host/sandbox-control";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  formatSandboxDay,
  sandboxTeamFrozenStateLine,
} from "@/components/hosts/sandbox-card-model";
import { frozenDestroyAt } from "@/lib/sandboxes/sandbox-balance";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSandboxCreateDialogStore } from "@/stores/settings/sandbox-create-dialog-store";
import { useTeamWakeConfirmStore } from "@/stores/hosts/team-wake-confirm-store";
import { SANDBOX_VERB_FETCH_TIMEOUT_MS } from "@traycer-clients/shared/host-client/sandbox-control";

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastFromAuthError: vi.fn<(error: Error, title: string) => void>(),
  costs: null as UserSandboxCost | null,
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
  useRunnerHostOrNull: () => ({ sandboxControlUnavailableReason: null }),
}));
vi.mock("@/lib/host/fleet-refresh", () => ({ requestFleetRefresh: vi.fn() }));
// The secrets section's live parts talk to the sandbox host itself; the card's
// own suite has no host runtime, and they have their own tests.
vi.mock("@/hooks/sandboxes/use-sandbox-egress-events", () => ({
  useSandboxEgressEvents: () => [],
}));
vi.mock("@/hooks/sandboxes/use-sandbox-grants-query", () => ({
  useSandboxGrants: () => ({
    data: undefined,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => false,
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation",
  () => ({
    useSandboxRepairGuestConfiguration: () => ({
      isPending: false,
      mutate: vi.fn(),
    }),
  }),
);
vi.mock("@/hooks/sandboxes/use-refresh-sandbox-costs", () => ({
  useRefreshSandboxCosts: () => undefined,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: null }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-costs-query", () => ({
  useSandboxCosts: () => ({ data: mocks.costs, isError: false }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-runway-warning", () => ({
  useSandboxRunwayWarning: () => ({ kind: "none" }),
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: null }),
}));

import { SandboxCard } from "@/components/hosts/sandbox-card";
import type { SandboxCreateBelongsTo } from "@/components/hosts/sandbox-create-model";
import { TeamWakeConfirmDialogHost } from "@/components/hosts/team-wake-confirm-dialog";
import type { HostScopeSandbox } from "@/components/settings/host-scope/host-scope-model";

/**
 * A TEAM sandbox's card names who created it and
 * whose bundle the running wake is on, has no personal cost view, says its
 * pod's room for shells, always asks for its name before a destroy, and asks
 * before a Resume or Start bills the person pressing it.
 */

const NAME = "build-box";
const VIEWER = "user-viewer";
const ENV = "env_team";

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

const TEAM_ID = "team-acme";

function renderCard(sandbox: HostScopeSandbox, teamOwned: boolean): void {
  renderCardLikeThis(
    sandbox,
    teamOwned,
    teamOwned ? { kind: "team", teamId: TEAM_ID } : { kind: "personal" },
  );
}

function renderCardLikeThis(
  sandbox: HostScopeSandbox,
  teamOwned: boolean,
  likeThis: SandboxCreateBelongsTo | null,
): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SandboxCard
        hostName="Host name"
        hostState="online"
        sandbox={{ ...sandbox, teamOwned }}
        likeThis={likeThis}
        onDestroyed={null}
      />
      <TeamWakeConfirmDialogHost />
    </QueryClientProvider>,
  );
}

function sandboxOf(
  state: HostScopeSandbox["state"],
  frozen: boolean,
  overrides: Partial<SandboxSummary>,
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

function podOf(
  summary: SandboxSummary,
  headroom: number,
  liveShells: number,
): SandboxPod {
  return { sandbox: summary, ordinal: 0, liveShells, headroom };
}

function text(testId: string): string {
  return screen.getByTestId(testId).textContent;
}

beforeEach(() => {
  mocks.binding = createFakeSandboxBinding();
  mocks.costs = null;
  mocks.toastSuccess.mockClear();
  mocks.toastInfo.mockClear();
  mocks.toastFromAuthError.mockClear();
  useTeamWakeConfirmStore.setState({ pending: null });
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: VIEWER, username: "viewer" },
  });
});
afterEach(() => {
  cleanup();
  useSandboxCreateDialogStore.setState({
    open: false,
    preselect: null,
    workingHostTeamId: null,
  });
  useTeamWakeConfirmStore.setState({ pending: null });
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("<SandboxCard /> team creator and wake payer", () => {
  it("names the creator and the wake payer on a team card, as 'you' for the viewer", () => {
    renderCard(
      sandboxOf("awake", false, {
        createdBy: { userId: VIEWER, displayName: "Vera Viewer" },
        wakePayer: { userId: VIEWER, displayName: "Vera Viewer" },
      }),
      true,
    );
    expect(text("sandbox-card-creator")).toBe("Created by you");
    expect(text("sandbox-card-wake-payer")).toBe("This wake is on your bundle");
  });

  it("names another member by their display name", () => {
    renderCard(
      sandboxOf("awake", false, {
        createdBy: { userId: "user-ada", displayName: "Ada Lovelace" },
        wakePayer: { userId: "user-grace", displayName: "Grace Hopper" },
      }),
      true,
    );
    expect(text("sandbox-card-creator")).toBe("Created by Ada Lovelace");
    expect(text("sandbox-card-wake-payer")).toBe(
      "This wake is on Grace Hopper's bundle",
    );
  });

  it("shows the creator but no payer line while the team sandbox is asleep", () => {
    renderCard(
      sandboxOf("suspended", false, {
        createdBy: { userId: "user-ada", displayName: "Ada Lovelace" },
        wakePayer: { userId: "user-ada", displayName: "Ada Lovelace" },
      }),
      true,
    );
    expect(text("sandbox-card-creator")).toBe("Created by Ada Lovelace");
    expect(screen.queryByTestId("sandbox-card-wake-payer")).toBeNull();
  });

  it("shows neither line on a personal card, whatever the summary says", () => {
    renderCard(
      sandboxOf("awake", false, {
        createdBy: { userId: VIEWER, displayName: "Vera Viewer" },
        wakePayer: { userId: VIEWER, displayName: "Vera Viewer" },
      }),
      false,
    );
    expect(screen.queryByTestId("sandbox-card-creator")).toBeNull();
    expect(screen.queryByTestId("sandbox-card-wake-payer")).toBeNull();
  });

  it("shows no creator line on a team card whose summary names none", () => {
    renderCard(sandboxOf("awake", false, { createdBy: null }), true);
    expect(screen.queryByTestId("sandbox-card-creator")).toBeNull();
  });

  it("says whose bundle ran out on a frozen team card", () => {
    renderCard(
      sandboxOf("suspended", true, {
        wakePayer: { userId: "user-ada", displayName: "Ada Lovelace" },
      }),
      true,
    );
    expect(text("sandbox-card-state-line")).toBe(
      "Frozen: Ada Lovelace's bundle is out.",
    );
  });
});

describe("<SandboxCard /> frozen team destroy date", () => {
  const FROZEN_AT = new Date(2026, 8, 1, 12).getTime();
  const ADA = { userId: "user-ada", displayName: "Ada Lovelace" };
  const BASE = "Frozen: Ada Lovelace's bundle is out.";

  it("adds the day the sandbox is destroyed when the server sends frozenAt", () => {
    renderCard(
      sandboxOf("suspended", true, { frozenAt: FROZEN_AT, wakePayer: ADA }),
      true,
    );
    expect(text("sandbox-card-state-line")).toBe(
      `${BASE} Destroyed on ${formatSandboxDay(frozenDestroyAt(FROZEN_AT))}.`,
    );
  });

  it("names no one, and never 'your credits', before the sandbox list answers", () => {
    renderCard(
      { state: "suspended", frozen: true, summary: null, teamOwned: false },
      true,
    );
    expect(text("sandbox-card-state-line")).toBe(
      "Frozen: its payer's bundle is out.",
    );
    expect(sandboxTeamFrozenStateLine(null, VIEWER)).toBe(
      "Frozen: its payer's bundle is out.",
    );
  });

  it("adds no date when frozenAt is not sent", () => {
    renderCard(
      sandboxOf("suspended", true, { frozenAt: null, wakePayer: ADA }),
      true,
    );
    expect(text("sandbox-card-state-line")).toBe(BASE);
  });

  it("builds the line from the payer's name, the viewer's own bundle and a missing payer", () => {
    const frozen = (payer: SandboxSummary["wakePayer"]): SandboxSummary =>
      sandboxSummaryFixture({ frozenAt: FROZEN_AT, wakePayer: payer });
    const day = formatSandboxDay(frozenDestroyAt(FROZEN_AT));
    expect(sandboxTeamFrozenStateLine(frozen(ADA), VIEWER)).toBe(
      `${BASE} Destroyed on ${day}.`,
    );
    expect(
      sandboxTeamFrozenStateLine(
        frozen({ userId: VIEWER, displayName: "Vera Viewer" }),
        VIEWER,
      ),
    ).toBe(`Frozen: your bundle is out. Destroyed on ${day}.`);
    expect(sandboxTeamFrozenStateLine(frozen(null), VIEWER)).toBe(
      `Frozen: its payer's bundle is out. Destroyed on ${day}.`,
    );
  });
});

describe("<SandboxCard /> team cost view", () => {
  it("mounts no cost view on a team card, and the personal view on a personal one", () => {
    mocks.costs = { sandboxes: [COST], awakeBurnMillicreditsPerHour: 120 };

    renderCard(sandboxOf("awake", false, {}), true);
    expect(screen.queryByTestId("sandbox-card-cost")).toBeNull();
    cleanup();

    renderCard(sandboxOf("awake", false, {}), false);
    expect(screen.getByTestId("sandbox-card-cost")).toBeDefined();
  });

  it("mounts no cost view on a team pod either", () => {
    mocks.costs = { sandboxes: [COST], awakeBurnMillicreditsPerHour: 120 };
    renderCard(
      sandboxOf("awake", false, { kind: "automation", environmentId: ENV }),
      true,
    );
    expect(screen.queryByTestId("sandbox-card-cost")).toBeNull();
  });
});

describe("<SandboxCard /> team pod room", () => {
  function scriptPods(
    pods: (summary: SandboxSummary) => readonly SandboxPod[],
    summary: SandboxSummary,
  ): void {
    mocks.binding?.auth.getSandboxAutomation.mockResolvedValue({
      kind: "ok",
      automation: { available: true, sandbox: null, pods: pods(summary) },
    });
  }

  it("reads the environment's pod list and says the pod's room and live shells", async () => {
    const pod = sandboxOf("awake", false, {
      kind: "automation",
      environmentId: ENV,
    });
    if (pod.summary === null) throw new Error("the fixture has no summary");
    scriptPods((summary) => [podOf(summary, 6, 2)], pod.summary);

    renderCard(pod, true);

    await waitFor(() => {
      expect(text("sandbox-card-pod-room")).toBe(
        "Room for 6 more shells · 2 live shells",
      );
    });
    expect(mocks.binding?.auth.getSandboxAutomation).toHaveBeenCalledTimes(1);
    expect(mocks.binding?.auth.getSandboxAutomation).toHaveBeenCalledWith(ENV);
  });

  it("says when the pod is full and has no live shells to count", async () => {
    const pod = sandboxOf("awake", false, {
      kind: "automation",
      environmentId: ENV,
    });
    if (pod.summary === null) throw new Error("the fixture has no summary");
    scriptPods((summary) => [podOf(summary, 0, 0)], pod.summary);

    renderCard(pod, true);

    await waitFor(() => {
      expect(text("sandbox-card-pod-room")).toBe(
        "No room for another shell · no live shells",
      );
    });
  });

  it("finds its own pod among the team's by sandbox id", async () => {
    const pod = sandboxOf("awake", false, {
      kind: "automation",
      environmentId: ENV,
      id: "sbx_pod_2",
    });
    if (pod.summary === null) throw new Error("the fixture has no summary");
    const other = sandboxSummaryFixture({
      kind: "automation",
      environmentId: ENV,
      id: "sbx_pod_1",
    });
    scriptPods(
      (summary) => [podOf(other, 1, 7), podOf(summary, 3, 1)],
      pod.summary,
    );

    renderCard(pod, true);

    await waitFor(() => {
      expect(text("sandbox-card-pod-room")).toBe(
        "Room for 3 more shells · 1 live shell",
      );
    });
  });

  it("shows no room line when the pod list does not hold this pod", async () => {
    const pod = sandboxOf("awake", false, {
      kind: "automation",
      environmentId: ENV,
    });
    mocks.binding?.auth.getSandboxAutomation.mockResolvedValue({
      kind: "ok",
      automation: { available: true, sandbox: null, pods: [] },
    });

    renderCard(pod, true);

    await waitFor(() => {
      expect(mocks.binding?.auth.getSandboxAutomation).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("sandbox-card-pod-room")).toBeNull();
  });

  it("shows no room line, and reads no pod list, for a team pod with no environment", async () => {
    renderCard(
      sandboxOf("awake", false, { kind: "automation", environmentId: null }),
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Reading it with no environment would read the person's own host.
    expect(mocks.binding?.auth.getSandboxAutomation).not.toHaveBeenCalled();
    expect(screen.queryByTestId("sandbox-card-pod-room")).toBeNull();
  });

  it("reads no pod list for a personal Automations card or a team card that is not a pod", async () => {
    renderCard(
      sandboxOf("awake", false, { kind: "automation", environmentId: ENV }),
      false,
    );
    cleanup();
    renderCard(sandboxOf("awake", false, { environmentId: ENV }), true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.binding?.auth.getSandboxAutomation).not.toHaveBeenCalled();
    expect(screen.queryByTestId("sandbox-card-pod-room")).toBeNull();
  });
});

describe("<SandboxCard /> team destroy", () => {
  function openDestroy(): void {
    fireEvent.click(screen.getByTestId("sandbox-card-destroy"));
  }

  it("asks for the typed name on a team card that is not frozen, and says it ends others' sessions", async () => {
    renderCard(sandboxOf("suspended", false, {}), true);
    openDestroy();

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(
      within(dialog).getByTestId("sandbox-card-destroy-team"),
    ).toBeDefined();
    expect(text("sandbox-card-destroy-team")).toContain(
      "other members' running agents",
    );
    const input = screen.getByTestId("sandbox-card-destroy-typed");
    expect(input).toBeDefined();
    expect(screen.getByTestId("confirm-action").hasAttribute("disabled")).toBe(
      true,
    );
    expect(mocks.binding?.auth.destroySandbox).not.toHaveBeenCalled();
  });

  it("destroys only once the exact name is typed", async () => {
    renderCard(sandboxOf("suspended", false, {}), true);
    openDestroy();
    await screen.findByTestId("confirm-destructive-dialog");

    const input = screen.getByTestId("sandbox-card-destroy-typed");
    fireEvent.change(input, { target: { value: "build" } });
    expect(text("confirm-blocked-reason")).toBe(
      `Type ${NAME} below to destroy it.`,
    );
    expect(screen.getByTestId("confirm-action").hasAttribute("disabled")).toBe(
      true,
    );

    fireEvent.change(input, { target: { value: NAME } });
    expect(screen.getByTestId("confirm-action").hasAttribute("disabled")).toBe(
      false,
    );
    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => {
      expect(mocks.binding?.auth.destroySandbox).toHaveBeenCalledWith("sbx_1");
    });
  });

  it("asks for the name on a team pod too", async () => {
    renderCard(
      sandboxOf("awake", false, { kind: "automation", environmentId: ENV }),
      true,
    );
    openDestroy();
    await screen.findByTestId("confirm-destructive-dialog");
    expect(screen.getByTestId("sandbox-card-destroy-typed")).toBeDefined();
    expect(screen.getByTestId("sandbox-card-destroy-team")).toBeDefined();
  });

  it("keeps a personal card's destroy as it was: no typed name, no team sentence", async () => {
    renderCard(sandboxOf("suspended", false, {}), false);
    openDestroy();
    await screen.findByTestId("confirm-destructive-dialog");
    expect(screen.queryByTestId("sandbox-card-destroy-typed")).toBeNull();
    expect(screen.queryByTestId("sandbox-card-destroy-team")).toBeNull();
  });

  it("words the typed field for a team card as its own, not as a frozen one", async () => {
    renderCard(sandboxOf("suspended", false, {}), true);
    openDestroy();
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain("Type its name to confirm.");
    expect(dialog.textContent).not.toContain("This sandbox is frozen.");
  });
});

describe("<SandboxCard /> team wake confirm", () => {
  function resume(): void {
    fireEvent.click(screen.getByTestId("sandbox-card-resume"));
  }

  it("opens the confirm on Resume of a team card and calls no verb until Resume is pressed", async () => {
    renderCard(sandboxOf("suspended", false, {}), true);
    resume();

    const dialog = await screen.findByTestId("team-wake-confirm");
    expect(dialog.textContent).toContain(
      "Opening this resumes it on your bundle.",
    );
    expect(mocks.binding?.auth.runSandboxVerb).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("team-wake-confirm-resume"));
    await waitFor(() => {
      expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
    });
    expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledWith(
      "sbx_1",
      "resume",
      SANDBOX_VERB_FETCH_TIMEOUT_MS,
    );
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith(`Resumed ${NAME}`);
    });
  });

  it("calls nothing on Cancel", async () => {
    renderCard(sandboxOf("suspended", false, {}), true);
    resume();
    await screen.findByTestId("team-wake-confirm");

    fireEvent.click(screen.getByTestId("team-wake-confirm-cancel"));
    await waitFor(() => {
      expect(screen.queryByTestId("team-wake-confirm")).toBeNull();
    });
    expect(mocks.binding?.auth.runSandboxVerb).not.toHaveBeenCalled();
  });

  it("asks before a Start of a stopped team sandbox as well", async () => {
    renderCard(sandboxOf("stopped", false, {}), true);
    fireEvent.click(screen.getByTestId("sandbox-card-start"));

    await screen.findByTestId("team-wake-confirm");
    expect(mocks.binding?.auth.runSandboxVerb).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("team-wake-confirm-resume"));
    await waitFor(() => {
      expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledWith(
        "sbx_1",
        "start",
        SANDBOX_VERB_FETCH_TIMEOUT_MS,
      );
    });
  });

  it("calls the verb at once on a personal card's Resume, with no confirm", async () => {
    renderCard(sandboxOf("suspended", false, {}), false);
    resume();

    await waitFor(() => {
      expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
    });
    expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledWith(
      "sbx_1",
      "resume",
      SANDBOX_VERB_FETCH_TIMEOUT_MS,
    );
    expect(screen.queryByTestId("team-wake-confirm")).toBeNull();
  });

  it("does not ask for a team pod's Start: the pod runs on the team's free pool", async () => {
    renderCard(
      sandboxOf("released", false, { kind: "automation", environmentId: ENV }),
      true,
    );
    fireEvent.click(screen.getByTestId("sandbox-card-start"));

    await waitFor(() => {
      expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("team-wake-confirm")).toBeNull();
  });

  it("does not ask for a Suspend or a Stop of a team sandbox: only a wake bills", async () => {
    renderCard(sandboxOf("awake", false, {}), true);
    fireEvent.click(screen.getByTestId("sandbox-card-suspend"));

    await waitFor(() => {
      expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledWith(
        "sbx_1",
        "suspend",
        SANDBOX_VERB_FETCH_TIMEOUT_MS,
      );
    });
    expect(screen.queryByTestId("team-wake-confirm")).toBeNull();
  });
});

describe("<SandboxCard /> New sandbox like this", () => {
  function press(): void {
    fireEvent.click(screen.getByTestId("sandbox-card-new-like-this"));
  }

  it("opens the create form with the team on a team card", () => {
    renderCard(sandboxOf("awake", false, { environmentId: ENV }), true);
    expect(useSandboxCreateDialogStore.getState().open).toBe(false);

    press();

    const store = useSandboxCreateDialogStore.getState();
    expect(store.open).toBe(true);
    expect(store.preselect).toEqual({ kind: "team", teamId: TEAM_ID });
    expect(store.workingHostTeamId).toBeNull();
  });

  it("opens the create form on Personal for a personal card", () => {
    renderCard(sandboxOf("awake", false, {}), false);

    press();

    const store = useSandboxCreateDialogStore.getState();
    expect(store.open).toBe(true);
    expect(store.preselect).toEqual({ kind: "personal" });
    expect(store.workingHostTeamId).toBeNull();
  });

  it("is absent when the card cannot name its team yet, and the card's own actions stay", () => {
    renderCardLikeThis(
      sandboxOf("awake", false, { environmentId: ENV }),
      true,
      null,
    );

    expect(screen.queryByTestId("sandbox-card-new-like-this")).toBeNull();
    expect(screen.getByTestId("sandbox-card-suspend")).toBeDefined();
  });

  it("is absent, with no footer, on a card with neither actions nor a team to offer", () => {
    renderCardLikeThis(sandboxOf("creating", false, {}), true, null);

    expect(screen.queryByTestId("sandbox-card-new-like-this")).toBeNull();
  });

  it("is offered on a card with no lifecycle actions", () => {
    renderCard(sandboxOf("creating", false, {}), false);

    expect(screen.getByTestId("sandbox-card-new-like-this")).toBeDefined();
  });

  it("is absent on a pod, which is the team's Automations host and not a sandbox a person creates", () => {
    renderCard(
      sandboxOf("awake", false, { kind: "automation", environmentId: ENV }),
      true,
    );

    expect(screen.queryByTestId("sandbox-card-new-like-this")).toBeNull();
  });
});
