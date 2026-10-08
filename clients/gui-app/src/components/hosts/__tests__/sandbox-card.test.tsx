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

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastFromAuthError: vi.fn<(error: Error, title: string) => void>(),
  catalogue: null as SandboxCatalogue | null,
  costs: null as UserSandboxCost | null,
  warning: { kind: "none" } as SandboxRunwayWarning,
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
}));
vi.mock("@/lib/host/fleet-refresh", () => ({ requestFleetRefresh: vi.fn() }));
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
import type { HostScopeSandbox } from "@/components/settings/host-scope/host-scope-model";

const NAME = "build-box";

function renderCard(sandbox: HostScopeSandbox): void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SandboxCard hostName="Host name" sandbox={sandbox} />
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
  mocks.toastSuccess.mockClear();
  mocks.toastInfo.mockClear();
  mocks.toastFromAuthError.mockClear();
});
afterEach(cleanup);

describe("<SandboxCard /> per state", () => {
  const ACTIONS: Record<string, readonly string[]> = {
    creating: [],
    awake: ["suspend", "stop", "destroy"],
    suspending: [],
    suspended: ["resume", "destroy"],
    resuming: [],
    stopping: [],
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
    let finish: (() => void) | null = null;
    mocks.binding?.auth.runSandboxVerb.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ kind: "ok", settled: true });
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

    finish?.();
    await waitFor(() => {
      expect(
        screen.getByTestId("sandbox-card-stop").hasAttribute("disabled"),
      ).toBe(false);
    });
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
