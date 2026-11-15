import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { AuthService, ChosenSignIn } from "@/lib/auth/auth-service";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useTeamComputerInstallTokenMutation } from "../use-team-computer-install-token-mutation";

const mocks = vi.hoisted(() => ({
  auth: null as Pick<AuthService, "mintTeamComputerInstallToken"> | null,
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => (mocks.auth === null ? null : { auth: mocks.auth }),
}));

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function signedInAs(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId, userName: userId, email: `${userId}@example.test` },
    contextMetadata: { userId, username: userId },
    shareableTeams: [],
    subscriptionStatus: null,
  });
}

function createQueryClient(onMutate: () => Promise<void>): QueryClient {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false, onMutate },
      queries: { retry: false },
    },
  });
}

function wrapper(
  queryClient: QueryClient,
): (props: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  mocks.auth = null;
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
    shareableTeams: [],
    subscriptionStatus: null,
  });
});

describe("team-computer install-token mutation account identity", () => {
  it("does not mint with the new account after mutate begins", async () => {
    const enteredOnMutate = deferred<void>();
    const continueMutation = deferred<void>();
    const currentUserWhenMinted: string[] = [];
    const chosenBy: ChosenSignIn = {
      identityGeneration: 0,
      userId: "user-a",
    };
    const mint = vi.fn<AuthService["mintTeamComputerInstallToken"]>(
      async (_environmentId, pressedBy) => {
        const currentUserId =
          useAuthStore.getState().contextMetadata?.userId ?? null;
        if (pressedBy.userId !== currentUserId)
          throw new Error("The signed-in account changed.");
        currentUserWhenMinted.push(
          useAuthStore.getState().contextMetadata?.userId ?? "none",
        );
        return { kind: "ok", token: "install-token", expiresAt: 2000 };
      },
    );
    mocks.auth = { mintTeamComputerInstallToken: mint };
    signedInAs("user-a");
    const queryClient = createQueryClient(async () => {
      enteredOnMutate.resolve();
      await continueMutation.promise;
    });
    const { result } = renderHook(
      () => useTeamComputerInstallTokenMutation("team-a"),
      { wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      const operation = result.current.mutateAsync(chosenBy);
      await enteredOnMutate.promise;
      signedInAs("user-b");
      continueMutation.resolve();
      await expect(operation).rejects.toThrow();
    });

    expect(mint).toHaveBeenCalledExactlyOnceWith("team-a", chosenBy);
    expect(currentUserWhenMinted).toEqual([]);
    queryClient.clear();
  });

  it("allows minting after a same-user token rotation", async () => {
    const enteredOnMutate = deferred<void>();
    const continueMutation = deferred<void>();
    const currentUserWhenMinted: string[] = [];
    const chosenBy: ChosenSignIn = {
      identityGeneration: 0,
      userId: "user-a",
    };
    const mint = vi.fn<AuthService["mintTeamComputerInstallToken"]>(
      async (_environmentId, pressedBy) => {
        const currentUserId =
          useAuthStore.getState().contextMetadata?.userId ?? null;
        if (pressedBy.userId !== currentUserId)
          throw new Error("The signed-in account changed.");
        currentUserWhenMinted.push(
          useAuthStore.getState().contextMetadata?.userId ?? "none",
        );
        return { kind: "ok", token: "install-token", expiresAt: 2000 };
      },
    );
    mocks.auth = { mintTeamComputerInstallToken: mint };
    signedInAs("user-a");
    const queryClient = createQueryClient(async () => {
      enteredOnMutate.resolve();
      await continueMutation.promise;
    });
    const { result } = renderHook(
      () => useTeamComputerInstallTokenMutation("team-a"),
      { wrapper: wrapper(queryClient) },
    );

    let token: {
      readonly installToken: string;
      readonly expiresAt: number;
    } | null = null;
    await act(async () => {
      const operation = result.current.mutateAsync(chosenBy);
      await enteredOnMutate.promise;
      signedInAs("user-a");
      continueMutation.resolve();
      token = await operation;
    });

    expect(mint).toHaveBeenCalledExactlyOnceWith("team-a", chosenBy);
    expect(currentUserWhenMinted).toEqual(["user-a"]);
    expect(token).toEqual({ installToken: "install-token", expiresAt: 2000 });
    queryClient.clear();
  });
});
