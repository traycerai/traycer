/**
 * The size a create opens at. A personal create opens at the provider's
 * smallest shape; a team create opens at the smallest shape that gives the
 * sandbox 2 GB, and keeps following that default across Belongs to and
 * Operating system for as long as the size is untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AuthenticatedUser,
  TraycerTeamSubscription,
} from "@traycer/protocol/auth";
import type {
  SandboxCatalogue,
  SandboxCatalogueProvider,
  SandboxOs,
} from "@traycer/protocol/host/sandbox-control";
import {
  teamSubscription,
  userSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";

interface CatalogueState {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly data: SandboxCatalogue | undefined;
  readonly error: Error | null;
  readonly refetch: () => Promise<void>;
}

const mocks = vi.hoisted(() => ({
  catalogue: null as CatalogueState | null,
  user: null as AuthenticatedUser | null,
}));

vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => mocks.catalogue,
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({
    data: mocks.user,
    isPending: false,
    isError: false,
    refetch: () => Promise.resolve(),
  }),
}));
vi.mock("@/hooks/sandboxes/use-team-environment-query", () => ({
  useTeamEnvironment: () => ({
    data: undefined,
    isPending: true,
    isError: false,
  }),
}));
vi.mock("@/hooks/sandboxes/use-environment-providers-query", () => ({
  useEnvironmentProviders: () => ({
    data: undefined,
    isPending: true,
    isError: false,
  }),
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-create-mutation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/sandboxes/use-sandbox-create-mutation")
    >()),
    useSandboxCreate: () => ({
      mutate: vi.fn(),
      isPending: false,
      isError: false,
      error: null,
      variables: undefined,
      reset: () => undefined,
    }),
  }),
);

import { SandboxCreateDialog } from "@/components/hosts/sandbox-create-dialog";
import type { SandboxCreateBelongsTo } from "@/components/hosts/sandbox-create-model";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSandboxCreateDialogStore } from "@/stores/settings/sandbox-create-dialog-store";

const ACME_ID = "team-acme";

function provider(
  os: SandboxOs,
  shape: Partial<SandboxCatalogueProvider["shape"]>,
): SandboxCatalogueProvider {
  return {
    provider: os === "linux" ? "tensorlake" : "winbox",
    os: [os],
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
      ...shape,
    },
    suspendFidelity: "memory",
    stoppedStorage: "snapshot",
    wakeClass: "resume",
    dockerInGuest: true,
    creatable: true,
    notCreatableReason: null,
    regions: [
      {
        id: "us-east",
        label: "US East",
        fromPriceMcPerHour: { awakeMc: 120, suspendedMc: 4, stoppedMc: 2 },
      },
    ],
  };
}

/** 2 GB is available at the provider's smallest vCPU count. */
const ROOMY: Partial<SandboxCatalogueProvider["shape"]> = {};

/** 2 GB needs a vCPU step: at most 2 GB per vCPU, and half a vCPU to start. */
const NARROW: Partial<SandboxCatalogueProvider["shape"]> = {
  cpuMin: 0.5,
  cpuStep: 0.5,
  memoryPerCpuMinMb: 1024,
  memoryPerCpuMaxMb: 2048,
  memoryMinMb: 512,
  memoryStepMb: 512,
};

function openCatalogue(...providers: SandboxCatalogueProvider[]): void {
  mocks.catalogue = {
    isPending: false,
    isError: false,
    data: { providers },
    error: null,
    refetch: () => Promise.resolve(),
  };
}

function teamEntry(id: string, slug: string): TraycerTeamSubscription {
  const base = teamSubscription(1_000);
  return { ...base, teamID: id, team: { ...base.team, id, slug } };
}

async function renderDialog(
  preselect: SandboxCreateBelongsTo | null,
): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  act(() => {
    useSandboxCreateDialogStore.getState().openDialog(preselect, null);
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SandboxCreateDialog />
    </QueryClientProvider>,
  );
  await screen.findByTestId("sandbox-create-name");
}

const TEAM: SandboxCreateBelongsTo = { kind: "team", teamId: ACME_ID };

async function pickBelongsTo(optionName: RegExp): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByTestId("sandbox-create-belongs-to"));
  await user.click(await screen.findByRole("option", { name: optionName }));
}

async function pickOs(optionName: RegExp): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Operating system" }));
  await user.click(await screen.findByRole("option", { name: optionName }));
}

function type(testId: string, value: string): void {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

function expectSize(cpus: string, memory: string): void {
  expect(screen.getByTestId("sandbox-create-cpus")).toHaveProperty(
    "value",
    cpus,
  );
  expect(screen.getByTestId("sandbox-create-memory")).toHaveProperty(
    "value",
    memory,
  );
}

beforeEach(() => {
  useAuthStore.setState({ status: "signed-in" });
  mocks.user = userWith(
    userSubscription({
      totalPlanCredits: 5,
      consumedFromPlan: 0,
      bonusCredits: 0,
      consumedFromBonus: 0,
      bundleRemaining: 0,
    }),
    [teamEntry(ACME_ID, "acme")],
  );
});

afterEach(() => {
  cleanup();
  act(() => {
    useSandboxCreateDialogStore.getState().closeDialog();
  });
  useAuthStore.setState({ status: "signed-out" });
});

describe("<SandboxCreateDialog /> default size", () => {
  it("opens a team create at 2 GB", async () => {
    openCatalogue(provider("linux", ROOMY));
    await renderDialog(TEAM);

    expectSize("1", "2");
  });

  it("opens a team create at the vCPU step that allows 2 GB", async () => {
    openCatalogue(provider("linux", NARROW));
    await renderDialog(TEAM);

    expectSize("1", "2");
  });

  it("opens a team create at the first vCPU count whose memory is on the memory lattice", async () => {
    // Memory is exactly 1 GB per vCPU and moves in 1.5 GB steps from 1 GB, so
    // 2 GB is not on the lattice: 3 vCPU would need 3 GB, which is not either.
    // 4 vCPU at 4 GB is the first count whose memory is a valid size.
    openCatalogue(
      provider("linux", {
        cpuMin: 1,
        cpuMax: 16,
        cpuStep: 1,
        memoryMinMb: 1024,
        memoryMaxMb: 65536,
        memoryStepMb: 1536,
        memoryPerCpuMinMb: 1024,
        memoryPerCpuMaxMb: 1024,
      }),
    );
    await renderDialog(TEAM);

    expectSize("4", "4");
  });

  it("opens a team create at the largest valid memory when the provider cannot reach 2 GB", async () => {
    openCatalogue(
      provider("linux", {
        cpuMin: 1,
        cpuMax: 2,
        cpuStep: 1,
        memoryMinMb: 512,
        memoryMaxMb: 1536,
        memoryStepMb: 512,
        memoryPerCpuMinMb: 512,
        memoryPerCpuMaxMb: 1536,
      }),
    );
    await renderDialog(TEAM);

    expectSize("1", "1.5");
  });

  it("opens a team create at the memory maximum the real rounding clamps to", async () => {
    // 2 GB is above the 1.5 GB step grid's last point under a 2 GB maximum, so
    // the create's own rounding clamps to the maximum itself, which is valid.
    openCatalogue(
      provider("linux", {
        cpuMin: 1,
        cpuMax: 16,
        cpuStep: 1,
        memoryMinMb: 1024,
        memoryMaxMb: 2048,
        memoryStepMb: 1536,
        memoryPerCpuMinMb: 1024,
        memoryPerCpuMaxMb: 8192,
      }),
    );
    await renderDialog(TEAM);

    expectSize("1", "2");
  });

  it("opens a team create at an off-grid vCPU maximum when only it allows 2 GB", async () => {
    openCatalogue(
      provider("linux", {
        cpuMin: 1,
        cpuMax: 1.5,
        cpuStep: 1,
        memoryMinMb: 1024,
        memoryMaxMb: 65536,
        memoryStepMb: 512,
        memoryPerCpuMinMb: 1024,
        memoryPerCpuMaxMb: 1536,
      }),
    );
    await renderDialog(TEAM);

    expectSize("1.5", "2");
  });

  it("opens a personal create at the provider's smallest size", async () => {
    openCatalogue(provider("linux", ROOMY));
    await renderDialog(null);
    expectSize("1", "1");
    cleanup();

    openCatalogue(provider("linux", NARROW));
    await renderDialog(null);
    expectSize("0.5", "0.5");
  });

  it("moves an untouched size to the team default when Belongs to changes, and back", async () => {
    openCatalogue(provider("linux", NARROW));
    await renderDialog(null);
    expectSize("0.5", "0.5");

    await pickBelongsTo(/acme/);
    expectSize("1", "2");

    await pickBelongsTo(/Personal/);
    expectSize("0.5", "0.5");
  });

  it("keeps an edited size when Belongs to changes", async () => {
    openCatalogue(provider("linux", NARROW));
    await renderDialog(null);
    type("sandbox-create-memory", "4");

    await pickBelongsTo(/acme/);

    expectSize("0.5", "4");
  });

  it("lands on the team default when the operating system changes under a team", async () => {
    openCatalogue(provider("linux", ROOMY), provider("windows", NARROW));
    await renderDialog(TEAM);

    await pickOs(/Windows/);

    expectSize("1", "2");
  });
});
