/**
 * Query awaits between a press and its `mutationFn` (`Mutation.execute`
 * awaits the cache's `onMutate` and the mutation's own, given or not), and the
 * bearer is read only when the write is sent, from the one `AuthService` that
 * outlives an account switch. This pins, through the real hooks, that a write
 * pressed as account A is never sent as account B when the switch lands in
 * that wait, and that one pressed across A's own token refresh is sent, with
 * the refreshed token. The cache's `onMutate` is held to widen the wait the
 * library already has; nothing else stands between the press and the call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { AuthService, type ChosenSignIn } from "@/lib/auth/auth-service";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { useAuthStore } from "@/stores/auth/auth-store";

const AUTHN = "http://localhost:5005";
const VALIDATION_URL = `${AUTHN}/api/v3/user/negotiated`;
const MINT_URL = `${AUTHN}/api/v3/hosts/team-install-tokens`;

const bound = vi.hoisted(
  (): {
    binding: {
      readonly auth: AuthService;
      readonly directory: { readonly refresh: () => Promise<void> };
    } | null;
  } => ({ binding: null }),
);

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => bound.binding,
}));

import { useTeamComputerInstallTokenMutation } from "@/hooks/host/use-team-computer-install-token-mutation";

function installFetch(
  handler: (url: string, init: RequestInit | undefined) => Promise<Response>,
): () => void {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: unknown, init: RequestInit | undefined) =>
      handler(String(input), init),
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  };
}

function bearerOf(init: RequestInit | undefined): string {
  return new Headers(init?.headers).get("authorization") ?? "";
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "x-traycer-user-record-version": "2.0",
    },
  });
}

/** The identity route's answer for the account the bearer belongs to. */
function profileFor(userId: string): Response {
  return json({
    user: {
      id: userId,
      name: userId,
      providerId: `gh-${userId}`,
      providerHandle: userId,
      providerType: "GITHUB",
      email: `${userId}@example.com`,
      avatarUrl: null,
      activatedAt: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      lastSeenAt: null,
      privacyMode: false,
      isLearningEnabled: true,
    },
    userSubscription: {
      id: `sub-${userId}`,
      userID: userId,
      orgID: null,
      teamID: null,
      customerId: `cus-${userId}`,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      subscriptionExpiry: null,
      trialEndsAt: null,
      subscriptionStatus: "FREE",
      hasPaymentMethod: false,
      isInTrial: false,
      rechargeRateSeconds: 0,
    },
    teamSubscriptions: [],
    payAsYouGoUsage: { allowPayAsYouGo: false },
  });
}

const services: AuthService[] = [];
let restoreFetch: () => void = () => undefined;

beforeEach(() => {
  useAuthStore.getState().setSignedOut();
});

afterEach(() => {
  cleanup();
  while (services.length > 0) services.pop()?.dispose();
  useAuthStore.getState().setSignedOut();
  restoreFetch();
  bound.binding = null;
});

interface SignedIn {
  readonly host: MockRunnerHost;
  readonly service: AuthService;
  readonly queryClient: QueryClient;
  readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  /** The bearer of every write to `writeUrl`, in the order sent. */
  readonly writes: string[];
  /** Ends the held wait between the press and `mutationFn`. */
  readonly releasePress: () => void;
}

/** Account A signed in on a real AuthService; every press is held in Query. */
async function signInA(
  writeUrl: string,
  answer: () => Response,
): Promise<SignedIn> {
  const writes: string[] = [];
  restoreFetch = installFetch((url, init) => {
    if (url === VALIDATION_URL)
      return Promise.resolve(
        profileFor(bearerOf(init) === "Bearer token-b" ? "user-b" : "user-a"),
      );
    if (url === writeUrl) {
      writes.push(bearerOf(init));
      return Promise.resolve(answer());
    }
    return Promise.resolve(new Response(null, { status: 500 }));
  });
  const host = new MockRunnerHost({
    signInUrl:
      "https://auth.traycer.ai/sign-in?redirect_uri=traycer%3A%2F%2Fauth",
    authnBaseUrl: AUTHN,
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const service = new AuthService({ runnerHost: host });
  services.push(service);
  await host.tokenStore.signIn(
    { token: "token-a", refreshToken: "token-a-refresh" },
    { id: "user-a", email: "user-a@example.com", name: "user-a" },
  );
  await service.start();
  await waitFor(() =>
    expect(useAuthStore.getState().contextMetadata?.userId).toBe("user-a"),
  );
  bound.binding = {
    auth: service,
    directory: { refresh: () => Promise.resolve() },
  };
  const press: { release: (() => void) | null } = { release: null };
  const queryClient = new QueryClient({
    mutationCache: new MutationCache({
      onMutate: () =>
        new Promise<void>((resolve) => {
          press.release = resolve;
        }),
    }),
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    host,
    service,
    queryClient,
    wrapper: (props) => (
      <QueryClientProvider client={queryClient}>
        <RunnerHostContext value={host}>{props.children}</RunnerHostContext>
      </QueryClientProvider>
    ),
    writes,
    releasePress: () => press.release?.(),
  };
}

async function switchToB(session: SignedIn): Promise<void> {
  await session.host.tokenStore.signIn(
    { token: "token-b", refreshToken: "token-b-refresh" },
    { id: "user-b", email: "user-b@example.com", name: "user-b" },
  );
  await vi.waitFor(() => {
    expect(session.service.getCurrentSessionSnapshot().token).toBe("token-b");
  });
}

async function refreshA(session: SignedIn): Promise<void> {
  const credentialGeneration = session.service.getCredentialGeneration();
  await session.host.tokenStore.signIn(
    { token: "token-a2", refreshToken: "token-a2-refresh" },
    { id: "user-a", email: "user-a@example.com", name: "user-a" },
  );
  await vi.waitFor(() => {
    expect(session.service.getCurrentSessionSnapshot().token).toBe("token-a2");
  });
  expect(session.service.getCredentialGeneration()).toBeGreaterThan(
    credentialGeneration,
  );
}

function mintAnswer(): Response {
  return json({ token: "install-1", environmentId: "env-a", expiresAt: 1 });
}

/** Presses as A: the sign-in is read now, the call waits in Query. */
function pressMint(session: SignedIn) {
  const hook = renderHook(() => useTeamComputerInstallTokenMutation("env-a"), {
    wrapper: session.wrapper,
  });
  const chosenBy: ChosenSignIn = session.service.chosenSignIn();
  act(() => hook.result.current.mutate(chosenBy));
  return hook;
}

describe("an install-token mint pressed before a sign-in change", () => {
  it("is not sent as the account switched to before Query calls it", async () => {
    const session = await signInA(MINT_URL, mintAnswer);
    pressMint(session);

    await switchToB(session);
    session.releasePress();

    // The mint is keyed by account, so B's render no longer observes A's
    // mutation; its outcome is read from the cache.
    await waitFor(() =>
      expect(
        session.queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.error?.message),
      ).toEqual(["The signed-in account changed. Create a new token."]),
    );
    expect(session.writes).toEqual([]);
  });

  it("is sent across the same account's token refresh, with the refreshed token", async () => {
    const session = await signInA(MINT_URL, mintAnswer);
    const hook = pressMint(session);

    await refreshA(session);
    session.releasePress();

    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(session.writes).toEqual(["Bearer token-a2"]);
  });
});
