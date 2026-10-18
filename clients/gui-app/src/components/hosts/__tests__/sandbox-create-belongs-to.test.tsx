import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AuthenticatedUser,
  TraycerTeamSubscription,
} from "@traycer/protocol/auth";
import type {
  SandboxCatalogue,
  SandboxCreateRequest,
} from "@traycer/protocol/host/sandbox-control";
import type {
  EnvironmentProvidersFetchResult,
  TeamEnvironmentFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-secrets";
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

interface CreateVariables {
  readonly request: SandboxCreateRequest;
  readonly teamName: string | null;
  readonly teamId: string | null;
}

const mocks = vi.hoisted(() => ({
  catalogue: null as CatalogueState | null,
  user: null as AuthenticatedUser | null,
  /** The user query has not answered: no data, still pending. */
  userPending: false,
  /** The user query failed: no data, no longer pending. */
  userFailed: false,
  /** A refetch failed: still the earlier data, and in error. */
  userRefetchFailed: false,
  userRefetch: vi.fn<() => Promise<void>>(),
  environments: new Map<string, TeamEnvironmentFetchResult>(),
  providers: new Map<string, EnvironmentProvidersFetchResult>(),
  mutate: vi.fn<(variables: CreateVariables, options: unknown) => void>(),
  /** The last create's outcome, as the mutation result carries it. */
  create: {
    error: null as Error | null,
    variables: undefined as CreateVariables | undefined,
  },
  /** Every team id `useTeamEnvironment` was called with, in render order. */
  environmentCalls: [] as (string | null)[],
}));

vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => mocks.catalogue,
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({
    data: mocks.userPending || mocks.userFailed ? undefined : mocks.user,
    isPending: mocks.userPending,
    isError: mocks.userFailed || mocks.userRefetchFailed,
    refetch: mocks.userRefetch,
  }),
}));
vi.mock("@/hooks/sandboxes/use-team-environment-query", () => ({
  useTeamEnvironment: (teamId: string | null) => {
    mocks.environmentCalls.push(teamId);
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
vi.mock(
  "@/hooks/sandboxes/use-sandbox-create-mutation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/sandboxes/use-sandbox-create-mutation")
    >()),
    useSandboxCreate: () => ({
      mutate: mocks.mutate,
      isPending: false,
      isError: mocks.create.error !== null,
      error: mocks.create.error,
      variables: mocks.create.variables,
      reset: () => undefined,
    }),
  }),
);

import { SandboxCreateDialog } from "@/components/hosts/sandbox-create-dialog";
import type { SandboxCreateBelongsTo } from "@/components/hosts/sandbox-create-model";
import { SandboxCreateError } from "@/hooks/sandboxes/use-sandbox-create-mutation";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSandboxCreateDialogStore } from "@/stores/settings/sandbox-create-dialog-store";

const FROM_AWAKE_MC = 120;

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
          fromPriceMcPerHour: {
            awakeMc: FROM_AWAKE_MC,
            suspendedMc: 4,
            stoppedMc: 2,
          },
        },
        {
          id: "eu-west",
          label: "EU West",
          fromPriceMcPerHour: {
            awakeMc: FROM_AWAKE_MC,
            suspendedMc: 4,
            stoppedMc: 2,
          },
        },
      ],
    },
  ],
};

const ACME_ID = "team-acme";
const ZETA_ID = "team-zeta";

/** One `teamSubscriptions` entry holding `planCredits` credits to spend. */
function teamEntry(
  id: string,
  slug: string,
  planCredits: number,
): TraycerTeamSubscription {
  const base = teamSubscription(planCredits);
  return { ...base, teamID: id, team: { ...base.team, id, slug } };
}

function userInTeams(
  teams: readonly TraycerTeamSubscription[],
): AuthenticatedUser {
  return userWith(
    userSubscription({
      totalPlanCredits: 5,
      consumedFromPlan: 0,
      bonusCredits: 0,
      consumedFromBonus: 0,
      bundleRemaining: 0,
    }),
    [...teams],
  );
}

/** The person is in acme and zeta, each with plenty of credit. */
function userInAcmeAndZeta(): AuthenticatedUser {
  return userInTeams([
    teamEntry(ACME_ID, "acme", 1_000),
    teamEntry(ZETA_ID, "zeta", 1_000),
  ]);
}

function expectedLines(team: string): readonly string[] {
  return [
    `Belongs to: ${team}`,
    `Charged to your bundle under ${team}.`,
    `Chats on it are visible to the people of the task you use it in, which can include people outside ${team}.`,
    `Agents on it work with ${team}'s hosts only; they cannot work with agents on your own computer. The task still shares its files and chats.`,
  ];
}

function shownLines(): readonly (string | null)[] {
  return screen
    .getAllByTestId("sandbox-create-team-line")
    .map((line) => line.textContent);
}

function teamPreselect(teamId: string): SandboxCreateBelongsTo {
  return { kind: "team", teamId };
}

/** Opens the dialog and mounts it, without waiting for the form. */
function mountDialog(preselect: SandboxCreateBelongsTo | null): void {
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
}

async function renderDialog(
  preselect: SandboxCreateBelongsTo | null,
): Promise<void> {
  mountDialog(preselect);
  await screen.findByTestId("sandbox-create-name");
}

async function pickRegion(optionName: RegExp): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Region" }));
  await user.click(await screen.findByRole("option", { name: optionName }));
}

async function pickBelongsTo(optionName: RegExp): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByTestId("sandbox-create-belongs-to"));
  await user.click(await screen.findByRole("option", { name: optionName }));
}

function type(testId: string, value: string): void {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

function submit(): HTMLElement {
  return screen.getByTestId("sandbox-create-submit");
}

function request(environmentId: string | null): SandboxCreateRequest {
  return {
    os: "linux",
    cpus: 1,
    memoryMb: 1024,
    diskMb: null,
    region: "us-east",
    displayName: "build-box",
    idleMinutes: 30,
    burst: false,
    createdByHostId: null,
    createdByAgentId: null,
    environmentId,
  };
}

beforeEach(() => {
  useAuthStore.setState({ status: "signed-in" });
  mocks.catalogue = {
    isPending: false,
    isError: false,
    data: CATALOGUE,
    error: null,
    refetch: () => Promise.resolve(),
  };
  mocks.user = userInAcmeAndZeta();
  mocks.userPending = false;
  mocks.userFailed = false;
  mocks.userRefetchFailed = false;
  mocks.userRefetch.mockReset();
  mocks.userRefetch.mockResolvedValue(undefined);
  mocks.environments.clear();
  mocks.providers.clear();
  mocks.mutate.mockReset();
  mocks.create.error = null;
  mocks.create.variables = undefined;
  mocks.environmentCalls.length = 0;
});

afterEach(() => {
  cleanup();
  act(() => {
    useSandboxCreateDialogStore.getState().closeDialog();
  });
  useAuthStore.setState({ status: "signed-out" });
});

describe("<SandboxCreateDialog /> belongs to", () => {
  it("has no Belongs to for a person in no team", async () => {
    mocks.user = userInTeams([]);
    await renderDialog(null);

    expect(screen.queryByTestId("sandbox-create-belongs-to")).toBeNull();
    expect(screen.queryByTestId("sandbox-create-team-lines")).toBeNull();
  });

  it("has no Belongs to before the person has loaded", async () => {
    mocks.user = null;
    await renderDialog(null);

    expect(screen.queryByTestId("sandbox-create-belongs-to")).toBeNull();
  });

  it("defaults to Personal, with none of the four lines, for a person in teams", async () => {
    await renderDialog(null);

    expect(
      screen.getByTestId("sandbox-create-belongs-to").textContent,
    ).toContain("Personal");
    expect(screen.queryByTestId("sandbox-create-team-lines")).toBeNull();
    expect(screen.queryAllByTestId("sandbox-create-team-line")).toHaveLength(0);
    expect(screen.queryByTestId("sandbox-create-no-providers")).toBeNull();
    expect(screen.queryByTestId("sandbox-create-ask-admin")).toBeNull();
    expect(screen.queryByTestId("sandbox-create-team-refusal")).toBeNull();
  });

  it("shows the four lines the moment a team is preselected, before either lookup answers and with no refusal", async () => {
    await renderDialog(teamPreselect(ACME_ID));

    expect(screen.getByTestId("sandbox-create-team-lines")).toBeDefined();
    expect(shownLines()).toEqual(expectedLines("acme"));
    expect(
      screen.getByTestId("sandbox-create-belongs-to").textContent,
    ).toContain("acme");
    expect(screen.queryByTestId("sandbox-create-team-refusal")).toBeNull();
    expect(screen.queryByTestId("sandbox-create-no-providers")).toBeNull();
    expect(screen.queryByTestId("sandbox-create-ask-admin")).toBeNull();
  });

  it("shows each picked team's own lines, and none again on Personal", async () => {
    await renderDialog(teamPreselect(ACME_ID));
    expect(shownLines()).toEqual(expectedLines("acme"));

    await pickBelongsTo(/zeta/);
    expect(shownLines()).toEqual(expectedLines("zeta"));

    await pickBelongsTo(/acme/);
    expect(shownLines()).toEqual(expectedLines("acme"));

    await pickBelongsTo(/Personal/);
    expect(screen.queryByTestId("sandbox-create-team-lines")).toBeNull();
  });

  it("sends a Personal request, byte-identical to today's, with no team name", async () => {
    await renderDialog(null);
    type("sandbox-create-name", "build-box");
    fireEvent.click(submit());

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0][0]).toEqual({
      request: request(null),
      teamName: null,
      teamId: null,
    });
  });

  it("sends the team's environment id and its slug once the environment answers", async () => {
    mocks.environments.set(ACME_ID, { kind: "ok", environmentId: "env-acme" });
    mocks.providers.set("env-acme", {
      kind: "ok",
      counts: { providerSecretCount: 1, connectedPlanCount: 0 },
    });
    await renderDialog(teamPreselect(ACME_ID));
    type("sandbox-create-name", "build-box");
    fireEvent.click(submit());

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0][0]).toEqual({
      request: request("env-acme"),
      teamName: "acme",
      teamId: ACME_ID,
    });
  });

  it("warns that agents cannot run when the team has no API keys and no plans", async () => {
    mocks.environments.set(ACME_ID, { kind: "ok", environmentId: "env-acme" });
    mocks.providers.set("env-acme", {
      kind: "ok",
      counts: { providerSecretCount: 0, connectedPlanCount: 0 },
    });
    await renderDialog(teamPreselect(ACME_ID));

    expect(screen.getByTestId("sandbox-create-no-providers").textContent).toBe(
      "No providers configured for acme; agents cannot run until an admin adds one",
    );
  });

  it("does not warn when the team has an API key", async () => {
    mocks.environments.set(ACME_ID, { kind: "ok", environmentId: "env-acme" });
    mocks.providers.set("env-acme", {
      kind: "ok",
      counts: { providerSecretCount: 1, connectedPlanCount: 0 },
    });
    await renderDialog(teamPreselect(ACME_ID));

    expect(screen.queryByTestId("sandbox-create-no-providers")).toBeNull();
  });

  it("replaces Create with the disabled ask-an-admin button when the team balance is below an hour of the region's from price", async () => {
    // 0.05 credits is 50 millicredits, under the region's 120 per hour.
    mocks.user = userInTeams([teamEntry(ACME_ID, "acme", 0.05)]);
    mocks.environments.set(ACME_ID, { kind: "ok", environmentId: "env-acme" });
    mocks.providers.set("env-acme", {
      kind: "ok",
      counts: { providerSecretCount: 1, connectedPlanCount: 0 },
    });
    await renderDialog(teamPreselect(ACME_ID));

    const askAdmin = screen.getByTestId("sandbox-create-ask-admin");
    expect(askAdmin.textContent).toBe("Ask a team admin for more capacity");
    expect(askAdmin.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByTestId("sandbox-create-submit")).toBeNull();
  });

  it("keeps Create when the team balance covers an hour", async () => {
    mocks.environments.set(ACME_ID, { kind: "ok", environmentId: "env-acme" });
    mocks.providers.set("env-acme", {
      kind: "ok",
      counts: { providerSecretCount: 1, connectedPlanCount: 0 },
    });
    await renderDialog(teamPreselect(ACME_ID));

    expect(screen.queryByTestId("sandbox-create-ask-admin")).toBeNull();
    expect(submit()).toBeDefined();
  });

  it("says the person is not a member of the team when the environment lookup refuses", async () => {
    mocks.environments.set(ACME_ID, { kind: "not-a-member" });
    await renderDialog(teamPreselect(ACME_ID));

    expect(screen.getByTestId("sandbox-create-team-refusal").textContent).toBe(
      "You are not a member of acme.",
    );
  });

  it("says Traycer could not check where the sandbox belongs when the environment lookup fails", async () => {
    mocks.environments.set(ACME_ID, {
      kind: "network-error",
      detail: "timeout",
    });
    await renderDialog(teamPreselect(ACME_ID));

    expect(screen.getByTestId("sandbox-create-team-refusal").textContent).toBe(
      "Traycer couldn't check where this sandbox belongs. Try again in a moment.",
    );
  });
  it("says Traycer could not load the teams, with a retry that reads them again, and shows no form, when the user read failed", async () => {
    mocks.userFailed = true;
    mountDialog(teamPreselect(ACME_ID));

    expect(
      await screen.findByText("Traycer couldn't load your teams."),
    ).toBeDefined();
    expect(screen.queryByTestId("sandbox-create-name")).toBeNull();
    expect(screen.queryByTestId("sandbox-create-loading")).toBeNull();
    expect(mocks.userRefetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(mocks.userRefetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the form, and the teams it has, when only a refetch of the user failed", async () => {
    mocks.userRefetchFailed = true;
    await renderDialog(teamPreselect(ACME_ID));

    expect(screen.queryByText("Traycer couldn't load your teams.")).toBeNull();
    expect(screen.getByTestId("sandbox-create-team-lines")).toBeDefined();
  });

  it("opens the Personal form when the user read failed and nothing named a team", async () => {
    mocks.userFailed = true;
    await renderDialog(null);

    expect(screen.queryByText("Traycer couldn't load your teams.")).toBeNull();
    expect(screen.queryByTestId("sandbox-create-belongs-to")).toBeNull();
  });

  it("reads Personal in Belongs to when the preselected team is not one of the person's", async () => {
    await renderDialog(teamPreselect("team-gone"));

    const trigger = screen.getByTestId("sandbox-create-belongs-to");
    expect(trigger.textContent).toContain("Personal");
    expect(screen.queryByTestId("sandbox-create-team-lines")).toBeNull();
  });

  it("reads Personal in Belongs to, not blank, when the picked team leaves the person's teams while the form is open", async () => {
    await renderDialog(teamPreselect(ZETA_ID));
    expect(
      screen.getByTestId("sandbox-create-belongs-to").textContent,
    ).toContain("zeta");

    // The person leaves zeta. The mocks are not reactive: a store write the
    // body selects makes it read them again (the working host's team is
    // ignored here, being no team of the person's).
    mocks.user = userInTeams([teamEntry(ACME_ID, "acme", 1_000)]);
    act(() => {
      useSandboxCreateDialogStore.setState({
        workingHostTeamId: "unrelated-team",
      });
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("sandbox-create-belongs-to").textContent,
      ).toContain("Personal");
    });
    expect(screen.queryByTestId("sandbox-create-team-lines")).toBeNull();
  });

  it("stays loading while the person has not loaded, then opens on the preselected team and not on Personal", async () => {
    mocks.userPending = true;
    mountDialog(teamPreselect(ACME_ID));

    expect(await screen.findByTestId("sandbox-create-loading")).toBeDefined();
    expect(screen.queryByTestId("sandbox-create-name")).toBeNull();
    expect(screen.queryByTestId("sandbox-create-belongs-to")).toBeNull();

    // The user lands. The mocks are not reactive: a store write the body
    // selects makes it read them again (the working host's team is ignored
    // here, being no team of the person's).
    mocks.userPending = false;
    act(() => {
      useSandboxCreateDialogStore.setState({
        workingHostTeamId: "unrelated-team",
      });
    });

    await screen.findByTestId("sandbox-create-name");
    expect(screen.queryByTestId("sandbox-create-loading")).toBeNull();
    expect(
      screen.getByTestId("sandbox-create-belongs-to").textContent,
    ).toContain("acme");
    expect(shownLines()).toEqual(expectedLines("acme"));
  });

  it("reads no team's environment for a Personal pick", async () => {
    await renderDialog(null);

    expect(mocks.environmentCalls.length).toBeGreaterThan(0);
    expect(new Set(mocks.environmentCalls)).toEqual(new Set([null]));
  });

  it("reads only the picked team's environment, never another team's, until another is picked", async () => {
    await renderDialog(teamPreselect(ACME_ID));
    expect(new Set(mocks.environmentCalls)).toEqual(new Set([ACME_ID]));

    await pickBelongsTo(/Personal/);
    expect(mocks.environmentCalls).not.toContain(ZETA_ID);
    expect(mocks.environmentCalls.at(-1)).toBeNull();

    await pickBelongsTo(/zeta/);
    expect(mocks.environmentCalls).toContain(ZETA_ID);
    expect(mocks.environmentCalls.at(-1)).toBe(ZETA_ID);
  });

  it("keeps Create disabled for a team until its environment answers, and sends nothing meanwhile", async () => {
    await renderDialog(teamPreselect(ACME_ID));
    type("sandbox-create-name", "build-box");

    expect(submit().hasAttribute("disabled")).toBe(true);
    fireEvent.submit(submit().closest("form") ?? submit());
    expect(mocks.mutate).not.toHaveBeenCalled();
    cleanup();

    mocks.environments.set(ACME_ID, { kind: "ok", environmentId: "env-acme" });
    await renderDialog(teamPreselect(ACME_ID));
    type("sandbox-create-name", "build-box");
    expect(submit().hasAttribute("disabled")).toBe(false);
  });

  it("keeps Create disabled for a team whose environment answered not-a-member", async () => {
    mocks.environments.set(ACME_ID, { kind: "not-a-member" });
    await renderDialog(teamPreselect(ACME_ID));
    type("sandbox-create-name", "build-box");

    expect(submit().hasAttribute("disabled")).toBe(true);
  });

  describe("after a refused team create", () => {
    function teamAnswered(): void {
      mocks.environments.set(ACME_ID, {
        kind: "ok",
        environmentId: "env-acme",
      });
      mocks.providers.set("env-acme", {
        kind: "ok",
        counts: { providerSecretCount: 1, connectedPlanCount: 0 },
      });
    }

    function refusedWith(
      code: string,
      environmentId: string,
      reason: string | null,
    ): void {
      mocks.create.error = new SandboxCreateError("refused", code, reason);
      mocks.create.variables = {
        request: request(environmentId),
        teamName: "acme",
        teamId: ACME_ID,
      };
    }

    it("replaces Create with the ask-an-admin button when the create was refused 402 insufficient_credit", async () => {
      teamAnswered();
      refusedWith("insufficient_credit", "env-acme", null);
      await renderDialog(teamPreselect(ACME_ID));

      expect(
        screen.getByTestId("sandbox-create-ask-admin").hasAttribute("disabled"),
      ).toBe(true);
      expect(screen.queryByTestId("sandbox-create-submit")).toBeNull();
    });

    it("shows no ask-an-admin for a 402 the credit service could not decide, and keeps Create", async () => {
      teamAnswered();
      refusedWith("insufficient_credit", "env-acme", "unverified");
      await renderDialog(teamPreselect(ACME_ID));

      expect(screen.queryByTestId("sandbox-create-ask-admin")).toBeNull();
      expect(screen.getByTestId("sandbox-create-submit")).toBeDefined();
    });

    it("shows ask-an-admin for a 402 the credit service denied", async () => {
      teamAnswered();
      refusedWith("insufficient_credit", "env-acme", "denied");
      await renderDialog(teamPreselect(ACME_ID));

      expect(
        screen.getByTestId("sandbox-create-ask-admin").hasAttribute("disabled"),
      ).toBe(true);
      expect(screen.queryByTestId("sandbox-create-submit")).toBeNull();
    });

    it("says Traycer could not check where the sandbox belongs when the create was refused 503 environment_unavailable", async () => {
      teamAnswered();
      refusedWith("environment_unavailable", "env-acme", null);
      await renderDialog(teamPreselect(ACME_ID));

      expect(
        screen.getByTestId("sandbox-create-team-refusal").textContent,
      ).toBe(
        "Traycer couldn't check where this sandbox belongs. Try again in a moment.",
      );
      expect(screen.queryByTestId("sandbox-create-ask-admin")).toBeNull();
    });

    it("gives Create back when the size is changed after the refusal, and takes it again when the refused size returns", async () => {
      teamAnswered();
      refusedWith("insufficient_credit", "env-acme", null);
      await renderDialog(teamPreselect(ACME_ID));
      expect(screen.getByTestId("sandbox-create-ask-admin")).toBeDefined();

      type("sandbox-create-cpus", "2");
      expect(screen.queryByTestId("sandbox-create-ask-admin")).toBeNull();
      expect(screen.getByTestId("sandbox-create-submit")).toBeDefined();

      type("sandbox-create-cpus", "1");
      expect(screen.getByTestId("sandbox-create-ask-admin")).toBeDefined();
      expect(screen.queryByTestId("sandbox-create-submit")).toBeNull();

      type("sandbox-create-memory", "2");
      expect(screen.queryByTestId("sandbox-create-ask-admin")).toBeNull();
      expect(screen.getByTestId("sandbox-create-submit")).toBeDefined();
    });

    it("gives Create back when the region is changed after the refusal", async () => {
      teamAnswered();
      refusedWith("insufficient_credit", "env-acme", null);
      await renderDialog(teamPreselect(ACME_ID));
      expect(screen.getByTestId("sandbox-create-ask-admin")).toBeDefined();

      await pickRegion(/EU West/);

      expect(screen.queryByTestId("sandbox-create-ask-admin")).toBeNull();
      expect(screen.getByTestId("sandbox-create-submit")).toBeDefined();
    });

    it("keeps the not-a-member line whatever the size or region", async () => {
      teamAnswered();
      refusedWith("environment_not_found", "env-acme", null);
      await renderDialog(teamPreselect(ACME_ID));
      const line = "You are not a member of acme.";
      expect(
        screen.getByTestId("sandbox-create-team-refusal").textContent,
      ).toBe(line);

      type("sandbox-create-cpus", "2");
      expect(
        screen.getByTestId("sandbox-create-team-refusal").textContent,
      ).toBe(line);

      await pickRegion(/EU West/);
      expect(
        screen.getByTestId("sandbox-create-team-refusal").textContent,
      ).toBe(line);
    });

    it("says the person is not a member of the team when the create was refused 404 environment_not_found", async () => {
      teamAnswered();
      refusedWith("environment_not_found", "env-acme", null);
      await renderDialog(teamPreselect(ACME_ID));

      expect(
        screen.getByTestId("sandbox-create-team-refusal").textContent,
      ).toBe("You are not a member of acme.");
    });

    it("keeps Create disabled after a definitive environment_not_found refusal", async () => {
      teamAnswered();
      refusedWith("environment_not_found", "env-acme", null);
      await renderDialog(teamPreselect(ACME_ID));
      type("sandbox-create-name", "build-box");

      expect(
        screen.getByTestId("sandbox-create-team-refusal").textContent,
      ).toBe("You are not a member of acme.");
      expect(submit().hasAttribute("disabled")).toBe(true);
    });

    it("answers neither for a refusal of another code", async () => {
      teamAnswered();
      refusedWith("provider_unavailable", "env-acme", null);
      await renderDialog(teamPreselect(ACME_ID));

      expect(screen.queryByTestId("sandbox-create-ask-admin")).toBeNull();
      expect(screen.queryByTestId("sandbox-create-team-refusal")).toBeNull();
      expect(submit()).toBeDefined();
    });

    it("answers neither for a refusal of a create sent to another environment", async () => {
      teamAnswered();
      refusedWith("insufficient_credit", "env-zeta", null);
      await renderDialog(teamPreselect(ACME_ID));
      expect(screen.queryByTestId("sandbox-create-ask-admin")).toBeNull();
      cleanup();

      refusedWith("environment_not_found", "env-zeta", null);
      await renderDialog(teamPreselect(ACME_ID));
      expect(screen.queryByTestId("sandbox-create-team-refusal")).toBeNull();
    });

    it("answers neither on a Personal pick", async () => {
      teamAnswered();
      refusedWith("insufficient_credit", "env-acme", null);
      await renderDialog(null);

      expect(screen.queryByTestId("sandbox-create-ask-admin")).toBeNull();
      expect(screen.queryByTestId("sandbox-create-team-refusal")).toBeNull();
      expect(submit()).toBeDefined();
    });
  });
});
