import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamComputerUnattendedSetup } from "../team-computer-unattended-setup";
import { TeamHostInstallTokenLifecycleBridge } from "@/providers/team-host-install-token-lifecycle-bridge";
import { teamComputerMutationKeys } from "@/lib/query-keys/team-computer-mutation-keys";
import { teamHostMutationKeys } from "@/lib/query-keys/team-host-mutation-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

type MintResult =
  | {
      readonly kind: "ok";
      readonly token: string;
      readonly environmentId: string;
      readonly expiresAt: number;
    }
  | {
      readonly kind: "refused";
      readonly status: number;
      readonly code:
        | "broker_unavailable"
        | "environment_action_forbidden"
        | "seat_without_write";
    };

interface AuthFacade {
  readonly mintTeamComputerInstallToken: (
    environmentId: string,
  ) => Promise<MintResult>;
}

const hostBindingMock = vi.hoisted(() => ({
  current: null as { readonly auth: AuthFacade } | null,
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => hostBindingMock.current,
  useHostClient: () => null,
}));

vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    data: {
      environments: [
        {
          environmentId: "environment-1",
          ownerKind: "organization",
          providerHandle: "team-slug",
        },
      ],
    },
  }),
}));

const ENVIRONMENT_ID = "environment-1";
const INSTALL_TOKEN = "account-a-install-token";
const ACCOUNT_A = "account-a";
const ACCOUNT_B = "account-b";

let queryClient: QueryClient;

function signIn(userId: string): void {
  useAuthStore
    .getState()
    .setSignedIn(
      { userId, userName: userId, email: `${userId}@example.test` },
      { userId, username: userId },
      [],
    );
}

function mountSetup(): void {
  render(
    <QueryClientProvider client={queryClient}>
      <TeamHostInstallTokenLifecycleBridge />
      <TeamComputerUnattendedSetup environmentId={ENVIRONMENT_ID} />
    </QueryClientProvider>,
  );
}

function tokenResult(): Extract<MintResult, { readonly kind: "ok" }> {
  return {
    kind: "ok",
    token: INSTALL_TOKEN,
    environmentId: ENVIRONMENT_ID,
    expiresAt: Date.now() + 60_000,
  };
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: true, retryDelay: 0 },
      queries: { retry: false },
    },
  });
  useAuthStore.getState().setSignedOut();
  hostBindingMock.current = null;
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  hostBindingMock.current = null;
  useAuthStore.getState().setSignedOut();
  vi.restoreAllMocks();
});

describe("TeamComputerUnattendedSetup", () => {
  it("renders no form signed out and does not mint when the setup surface opens", () => {
    const mint = vi.fn(() => Promise.resolve(tokenResult()));
    hostBindingMock.current = {
      auth: { mintTeamComputerInstallToken: mint },
    };
    mountSetup();

    expect(
      screen.queryByRole("button", { name: "Create install token" }),
    ).toBeNull();

    act(() => signIn(ACCOUNT_A));

    expect(
      screen.getByRole("button", { name: "Create install token" }),
    ).not.toBeNull();
    expect(mint).not.toHaveBeenCalled();
  });

  it("creates another unexpired token after remount and keeps the new-token action stable while pending", async () => {
    signIn(ACCOUNT_A);
    const firstToken = {
      ...tokenResult(),
      expiresAt: Date.now() + 60 * 60_000,
    };
    const nextToken = {
      ...firstToken,
      token: "account-a-second-install-token",
    };
    const pendingMint = Promise.withResolvers<MintResult>();
    const mint = vi
      .fn<AuthFacade["mintTeamComputerInstallToken"]>()
      .mockResolvedValueOnce(firstToken)
      .mockReturnValueOnce(pendingMint.promise);
    hostBindingMock.current = { auth: { mintTeamComputerInstallToken: mint } };
    mountSetup();

    fireEvent.click(
      screen.getByRole("button", { name: "Create install token" }),
    );
    expect(await screen.findByText(INSTALL_TOKEN)).not.toBeNull();
    cleanup();
    mountSetup();
    expect(await screen.findByText(INSTALL_TOKEN)).not.toBeNull();
    expect(mint).toHaveBeenCalledTimes(1);

    const create = screen.getByRole("button", { name: "Create a new token" });
    fireEvent.click(create);
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(true));
    expect(
      within(create).getByTestId("team-computer-install-token-progress"),
    ).toBeTruthy();
    expect(screen.queryByText(INSTALL_TOKEN)).toBeNull();
    fireEvent.click(create);
    expect(mint).toHaveBeenCalledTimes(2);
    await act(async () => {
      pendingMint.resolve(nextToken);
      await pendingMint.promise;
    });

    expect(await screen.findByText(nextToken.token)).not.toBeNull();
    expect(screen.queryByText(INSTALL_TOKEN)).toBeNull();
    expect(mint.mock.calls).toEqual([[ENVIRONMENT_ID], [ENVIRONMENT_ID]]);
    expect(
      screen
        .getByRole("button", { name: "Create a new token" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("prints the unattended install command with the team's provider handle", async () => {
    signIn(ACCOUNT_A);
    hostBindingMock.current = {
      auth: {
        mintTeamComputerInstallToken: vi.fn(() =>
          Promise.resolve(tokenResult()),
        ),
      },
    };
    mountSetup();

    fireEvent.click(
      screen.getByRole("button", { name: "Create install token" }),
    );

    expect(
      await screen.findByText(
        "traycer host install --team 'team-slug' < install-token.txt",
      ),
    ).not.toBeNull();
  });

  it("does not automatically retry a refused mint when global mutation retries are enabled", async () => {
    signIn(ACCOUNT_A);
    const mint = vi.fn(() =>
      Promise.resolve<MintResult>({
        kind: "refused",
        status: 503,
        code: "broker_unavailable",
      }),
    );
    hostBindingMock.current = {
      auth: { mintTeamComputerInstallToken: mint },
    };
    mountSetup();

    fireEvent.click(
      screen.getByRole("button", { name: "Create install token" }),
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't create the install token. Try again.",
    );
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith(ENVIRONMENT_ID);
  });

  it.each(["environment_action_forbidden", "seat_without_write"] as const)(
    "explains the permission required after %s instead of offering a retry",
    async (code) => {
      signIn(ACCOUNT_A);
      const mint = vi.fn(() =>
        Promise.resolve<MintResult>({ kind: "refused", status: 403, code }),
      );
      hostBindingMock.current = {
        auth: { mintTeamComputerInstallToken: mint },
      };
      mountSetup();

      fireEvent.click(
        screen.getByRole("button", { name: "Create install token" }),
      );

      expect((await screen.findByRole("alert")).textContent).toBe(
        "Ask a team admin for permission to add computers.",
      );
    },
  );

  it("keeps a credential-bearing facade throw out of the alert and mutation cache", async () => {
    signIn(ACCOUNT_A);
    const secret = "bearer-and-install-token-secret";
    const mint = vi.fn(() =>
      Promise.reject<MintResult>(
        new Error(`Auth facade failed with ${secret}`),
      ),
    );
    hostBindingMock.current = {
      auth: { mintTeamComputerInstallToken: mint },
    };
    mountSetup();

    fireEvent.click(
      screen.getByRole("button", { name: "Create install token" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Couldn't create the install token. Try again.",
    );
    expect(alert.textContent).not.toContain(secret);
    expect(mint).toHaveBeenCalledTimes(1);
    const mutation = queryClient.getMutationCache().findAll({
      mutationKey: teamComputerMutationKeys.installToken(
        ACCOUNT_A,
        ENVIRONMENT_ID,
      ),
    })[0];
    expect(mutation.state.status).toBe("error");
    const cachedError = mutation.state.error;
    if (!(cachedError instanceof Error)) {
      throw new Error(
        "The failed mutation should retain its normalized error.",
      );
    }
    expect(cachedError.message).toBe(
      "Couldn't create the install token. Try again.",
    );
    expect(cachedError.message).not.toContain(secret);
  });

  it("hides a held token immediately on account switch and the lifecycle bridge clears its cache prefix", async () => {
    signIn(ACCOUNT_A);
    const mint = vi.fn(() => Promise.resolve(tokenResult()));
    hostBindingMock.current = {
      auth: { mintTeamComputerInstallToken: mint },
    };
    mountSetup();

    fireEvent.click(
      screen.getByRole("button", { name: "Create install token" }),
    );
    expect(await screen.findByText(INSTALL_TOKEN)).not.toBeNull();
    expect(
      queryClient
        .getMutationCache()
        .findAll({ mutationKey: teamHostMutationKeys.installTokenAll() }),
    ).toHaveLength(1);

    act(() => signIn(ACCOUNT_B));

    expect(screen.queryByText(INSTALL_TOKEN)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Create install token" }),
    ).not.toBeNull();
    expect(
      queryClient
        .getMutationCache()
        .findAll({ mutationKey: teamHostMutationKeys.installTokenAll() }),
    ).toHaveLength(0);
  });

  it("discards an old account's in-flight completion after the identity switch", async () => {
    signIn(ACCOUNT_A);
    const pendingMint = Promise.withResolvers<MintResult>();
    const mint = vi.fn((_environmentId: string) => pendingMint.promise);
    hostBindingMock.current = {
      auth: { mintTeamComputerInstallToken: mint },
    };
    mountSetup();

    fireEvent.click(
      screen.getByRole("button", { name: "Create install token" }),
    );
    await waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
    expect(
      queryClient
        .getMutationCache()
        .findAll({ mutationKey: teamHostMutationKeys.installTokenAll() }),
    ).toHaveLength(1);

    act(() => signIn(ACCOUNT_B));
    expect(screen.queryByText(INSTALL_TOKEN)).toBeNull();
    expect(
      queryClient
        .getMutationCache()
        .findAll({ mutationKey: teamHostMutationKeys.installTokenAll() }),
    ).toHaveLength(0);

    await act(async () => {
      pendingMint.resolve(tokenResult());
      await pendingMint.promise;
    });

    expect(screen.queryByText(INSTALL_TOKEN)).toBeNull();
    expect(
      queryClient
        .getMutationCache()
        .findAll({ mutationKey: teamHostMutationKeys.installTokenAll() }),
    ).toHaveLength(0);
  });
});
