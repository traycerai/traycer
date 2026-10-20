/**
 * A team sandbox's create ends on "Start a <team> task" for a person with no
 * task in that team yet.
 *
 * This drives the REAL create mutation (`auth.createSandbox` resolving an
 * accepted create) so the offer is decided where it is in production: after
 * the create lands, not at click time. A team create by a person with no team
 * task keeps the dialog open on the offer; Start pins the landing composer to
 * the new sandbox, opens a new task and closes the dialog. A person who has a
 * team task, and a Personal create, close the dialog with no offer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AuthenticatedUser,
  TraycerTeamSubscription,
} from "@traycer/protocol/auth";
import type { SandboxCatalogue } from "@traycer/protocol/host/sandbox-control";
import type {
  EnvironmentProvidersFetchResult,
  TeamEnvironmentFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-secrets";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
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
  binding: null as FakeSandboxBinding | null,
  catalogue: null as CatalogueState | null,
  user: null as AuthenticatedUser | null,
  environments: new Map<string, TeamEnvironmentFetchResult>(),
  providers: new Map<string, EnvironmentProvidersFetchResult>(),
  hasTeamTask: { current: false },
  navigate: vi.fn(),
  navigateToTabIntent:
    vi.fn<(navigate: unknown, intent: unknown, options: unknown) => void>(),
  toastSuccess: vi.fn(),
  toastFromAuthError: vi.fn<(error: Error, title: string) => void>(),
}));

vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess } }));
vi.mock("@/lib/auth-error-toast", () => ({
  toastFromAuthError: mocks.toastFromAuthError,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));
// The controller behind it resolves routes and tab state this suite does not
// mount; what is under test is that the dialog hands it the router's navigate
// and a new-task intent exactly once.
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  navigateToTabIntent: (
    navigate: unknown,
    intent: unknown,
    options: unknown,
  ): void => {
    mocks.navigateToTabIntent(navigate, intent, options);
  },
}));
vi.mock("@/hooks/epics/use-epic-owning-team", () => ({
  useEpicOwningTeamId: (): string | null => null,
  usePersonHasTeamTask: (): boolean => mocks.hasTeamTask.current,
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
  useTeamEnvironment: (teamId: string | null) => {
    const data = teamId === null ? undefined : mocks.environments.get(teamId);
    return { data, isPending: data === undefined, isError: false };
  },
}));
vi.mock("@/hooks/sandboxes/use-environment-providers-query", () => ({
  useEnvironmentProviders: (environmentId: string | null) => {
    const data =
      environmentId === null ? undefined : mocks.providers.get(environmentId);
    return { data, isPending: data === undefined, isError: false };
  },
}));

import { SandboxCreateDialog } from "@/components/hosts/sandbox-create-dialog";
import type { SandboxCreateBelongsTo } from "@/components/hosts/sandbox-create-model";
import { browserTabId } from "@/lib/browser-tab-identity";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  composerSurfaceKey,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";
import { useSandboxCreateDialogStore } from "@/stores/settings/sandbox-create-dialog-store";

const ACME_ID = "team-acme";
const NEW_HOST_ID = "host-new";

const CATALOGUE: SandboxCatalogue = {
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
      regions: [
        {
          id: "us-east",
          label: "US East",
          fromPriceMcPerHour: { awakeMc: 120, suspendedMc: 4, stoppedMc: 2 },
        },
      ],
    },
  ],
};

function teamEntry(
  id: string,
  slug: string,
  planCredits: number,
): TraycerTeamSubscription {
  const base = teamSubscription(planCredits);
  return { ...base, teamID: id, team: { ...base.team, id, slug } };
}

function userInAcme(): AuthenticatedUser {
  return userWith(
    userSubscription({
      totalPlanCredits: 5,
      consumedFromPlan: 0,
      bonusCredits: 0,
      consumedFromBonus: 0,
      bundleRemaining: 0,
    }),
    [teamEntry(ACME_ID, "acme", 1_000)],
  );
}

function type(testId: string, value: string): void {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

/** Opens the dialog on `preselect`, names the sandbox and presses Create. */
async function createSandbox(
  preselect: SandboxCreateBelongsTo | null,
): Promise<void> {
  mocks.binding?.auth.createSandbox.mockResolvedValue({
    kind: "ok",
    accepted: {
      sandboxId: "sbx_new",
      hostId: NEW_HOST_ID,
      sandbox: sandboxSummaryFixture({ state: "creating" }),
    },
  });
  act(() => {
    useSandboxCreateDialogStore.getState().openDialog(preselect, null);
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { mutations: { retry: false } } })
      }
    >
      <SandboxCreateDialog />
    </QueryClientProvider>,
  );
  await screen.findByTestId("sandbox-create-name");
  type("sandbox-create-name", "build-box");
  fireEvent.click(screen.getByTestId("sandbox-create-submit"));
  await waitFor(() => {
    expect(mocks.binding?.auth.createSandbox).toHaveBeenCalledTimes(1);
  });
}

beforeEach(() => {
  useAuthStore.setState({ status: "signed-in" });
  mocks.binding = createFakeSandboxBinding();
  mocks.catalogue = {
    isPending: false,
    isError: false,
    data: CATALOGUE,
    error: null,
    refetch: () => Promise.resolve(),
  };
  mocks.user = userInAcme();
  mocks.environments.clear();
  mocks.providers.clear();
  mocks.environments.set(ACME_ID, { kind: "ok", environmentId: "env-acme" });
  mocks.providers.set("env-acme", {
    kind: "ok",
    counts: { providerSecretCount: 1, connectedPlanCount: 0 },
  });
  mocks.hasTeamTask.current = false;
  mocks.navigate.mockReset();
  mocks.navigateToTabIntent.mockReset();
  mocks.toastSuccess.mockClear();
  mocks.toastFromAuthError.mockClear();
  useSurfaceHostSelectionStore.setState({ selections: {} });
});

afterEach(() => {
  cleanup();
  act(() => {
    useSandboxCreateDialogStore.getState().closeDialog();
  });
  useAuthStore.setState({ status: "signed-out" });
  useSurfaceHostSelectionStore.setState({ selections: {} });
});

describe("<SandboxCreateDialog /> first team task", () => {
  it("offers to start a team task, and keeps the dialog open, after a team create by a person with no team task", async () => {
    mocks.hasTeamTask.current = false;
    await createSandbox({ kind: "team", teamId: ACME_ID });

    expect(
      await screen.findByTestId("sandbox-create-start-team-task"),
    ).toBeDefined();
    expect(useSandboxCreateDialogStore.getState().open).toBe(true);
    expect(mocks.navigateToTabIntent).not.toHaveBeenCalled();
  });

  it("starts the task on the new sandbox: pins the composer host, opens a new task once and closes the dialog", async () => {
    mocks.hasTeamTask.current = false;
    await createSandbox({ kind: "team", teamId: ACME_ID });

    const start = await screen.findByTestId(
      "sandbox-create-start-team-task-start",
    );
    expect(start.textContent).toBe("Start a acme task");
    fireEvent.click(start);

    expect(
      useSurfaceHostSelectionStore.getState().selections[
        composerSurfaceKey(browserTabId())
      ],
    ).toBe(NEW_HOST_ID);
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(mocks.navigateToTabIntent.mock.calls[0][0]).toBe(mocks.navigate);
    expect(mocks.navigateToTabIntent.mock.calls[0][1]).toMatchObject({
      kind: "new-draft",
    });
    await waitFor(() => {
      expect(useSandboxCreateDialogStore.getState().open).toBe(false);
    });
  });

  it("closes the dialog with no offer when the person already has a team task", async () => {
    mocks.hasTeamTask.current = true;
    await createSandbox({ kind: "team", teamId: ACME_ID });

    await waitFor(() => {
      expect(useSandboxCreateDialogStore.getState().open).toBe(false);
    });
    expect(screen.queryByTestId("sandbox-create-start-team-task")).toBeNull();
    expect(mocks.navigateToTabIntent).not.toHaveBeenCalled();
  });

  it("closes the dialog with no offer after a Personal create", async () => {
    mocks.hasTeamTask.current = false;
    await createSandbox(null);

    await waitFor(() => {
      expect(useSandboxCreateDialogStore.getState().open).toBe(false);
    });
    expect(screen.queryByTestId("sandbox-create-start-team-task")).toBeNull();
    expect(mocks.navigateToTabIntent).not.toHaveBeenCalled();
  });
});
