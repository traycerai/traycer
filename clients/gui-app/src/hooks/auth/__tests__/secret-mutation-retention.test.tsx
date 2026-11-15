import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLinkCodeSignInMutation } from "@/hooks/auth/use-link-code-sign-in-mutation";
import { useRespondLinkLoginMutation } from "@/hooks/auth/use-respond-link-login-mutation";
import { useAuthVerifyStepUpChallenge } from "@/hooks/auth/use-step-up-challenge-mutations";
import { useSubmittedSecretInput } from "@/hooks/use-submitted-secret-input";
import { createAppQueryClient } from "@/lib/query-client";
import { AuthService } from "@/lib/auth/auth-service";
import { useAuthStore } from "@/stores/auth/auth-store";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  createVerifiedTeamAuthService,
  mountTeamPageWithRealBoundary,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";

const authMocks = vi.hoisted(() => ({
  getAuthService: vi.fn<() => AuthService>(),
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useAuthService: (): AuthService => authMocks.getAuthService(),
  };
});

interface AuthHttpReply {
  readonly path: string;
  readonly status: number;
  readonly body: string;
}

interface AuthHttpCall {
  readonly path: string;
  readonly method: string;
  readonly secretPresent: boolean;
}

interface AuthHttpBoundary {
  readonly calls: AuthHttpCall[];
  readonly restore: () => void;
}

interface MutationObserverReference {
  readonly options: unknown;
  readonly getCurrentResult: () => unknown;
}

interface MutationExecution {
  readonly rejected: boolean;
  readonly errorContainsSecret: boolean;
}

interface RetainedStateScan {
  readonly queryClient: QueryClient;
  readonly observers: readonly MutationObserverReference[];
  readonly consoleOutput: readonly unknown[];
  readonly hookResult: unknown;
  readonly secret: string;
}

interface RetainedMutationReplay {
  readonly queryClient: QueryClient;
  readonly boundary: AuthHttpBoundary;
  readonly variables: unknown;
  readonly fixedRefusal: string;
  readonly secret: string;
}

interface RetentionDiagnostics {
  readonly mutationAndObserverContainSecret: boolean;
  readonly logsContainSecret: boolean;
  readonly hookResultContainsSecret: boolean;
}

function authRequestUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url);
  if (input instanceof URL) return input;
  return new URL(input);
}

function createUnstartedAuthService(): AuthService {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  return new AuthService({ runnerHost });
}

function installAuthHttpBoundary(
  replies: readonly AuthHttpReply[],
  secret: string,
): AuthHttpBoundary {
  const previousFetch = globalThis.fetch;
  const calls: AuthHttpCall[] = [];
  globalThis.fetch = async (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ): Promise<Response> => {
    const url = authRequestUrl(input);
    const reply = replies.find((candidate) => candidate.path === url.pathname);
    if (reply === undefined) return previousFetch(input, init);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({
      path: url.pathname,
      method: init?.method ?? "GET",
      secretPresent: body.includes(secret),
    });
    return new Response(reply.body, {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  const restore = (): void => {
    globalThis.fetch = previousFetch;
  };
  activeAuthHttpRestore = restore;
  return { calls, restore };
}

function containsSecret(value: unknown, secret: string): boolean {
  const seen = new WeakSet<object>();
  function contains(current: unknown): boolean {
    if (typeof current === "string") return current.includes(secret);
    if (
      (typeof current !== "object" && typeof current !== "function") ||
      current === null
    ) {
      return false;
    }
    if (seen.has(current)) return false;
    seen.add(current);
    if (
      current instanceof Error &&
      (current.message.includes(secret) || contains(current.cause))
    ) {
      return true;
    }
    return Object.values(current).some(contains);
  }
  return contains(value);
}

function mutationCacheContainsSecret(
  queryClient: QueryClient,
  observers: readonly MutationObserverReference[],
  secret: string,
): boolean {
  return (
    queryClient
      .getMutationCache()
      .getAll()
      .some((mutation) =>
        containsSecret(
          {
            variables: mutation.state.variables,
            context: mutation.state.context,
            data: mutation.state.data,
            error: mutation.state.error,
            meta: mutation.options.meta,
          },
          secret,
        ),
      ) ||
    observers.some((observer) =>
      containsSecret(
        { options: observer.options, result: observer.getCurrentResult() },
        secret,
      ),
    )
  );
}

function retainedStateDiagnostics(
  input: RetainedStateScan,
): RetentionDiagnostics {
  return {
    mutationAndObserverContainSecret: mutationCacheContainsSecret(
      input.queryClient,
      input.observers,
      input.secret,
    ),
    logsContainSecret: containsSecret(input.consoleOutput, input.secret),
    hookResultContainsSecret: containsSecret(input.hookResult, input.secret),
  };
}

function authHttpCallContainsSecret(
  boundary: AuthHttpBoundary,
  path: string,
): boolean {
  const call = boundary.calls.at(0);
  return (
    call !== undefined &&
    call.path === path &&
    call.method === "POST" &&
    call.secretPresent
  );
}

async function observeMutationExecution(
  run: () => Promise<unknown>,
  secret: string,
): Promise<MutationExecution> {
  try {
    await run();
    return { rejected: false, errorContainsSecret: false };
  } catch (error) {
    return {
      rejected: true,
      errorContainsSecret: containsSecret(error, secret),
    };
  }
}

function inputUnavailableWithoutSecret(
  read: () => unknown,
  fixedRefusal: string,
  secret: string,
): boolean {
  try {
    read();
  } catch (error) {
    return (
      error instanceof Error &&
      error.message === fixedRefusal &&
      !containsSecret(error, secret)
    );
  }
  return false;
}

async function replayRetainedMutationWithoutSecret(
  input: RetainedMutationReplay,
): Promise<boolean> {
  const mutation = input.queryClient.getMutationCache().getAll().at(-1);
  if (mutation === undefined)
    throw new Error("Mutation was not retained for replay");
  const mutationFn = mutation.options.mutationFn;
  if (mutationFn === undefined)
    throw new Error("Retained mutation has no mutation function");
  const callCount = input.boundary.calls.length;
  try {
    await mutationFn(input.variables, {
      client: input.queryClient,
      meta: mutation.options.meta,
      mutationKey: mutation.options.mutationKey ?? [],
    });
  } catch (error) {
    return (
      error instanceof Error &&
      error.message === input.fixedRefusal &&
      !containsSecret(error, input.secret) &&
      input.boundary.calls.length === callCount
    );
  }
  return false;
}

function captureMutationObservers(
  queryClient: QueryClient,
): MutationObserverReference[] {
  const observers: MutationObserverReference[] = [];
  const unsubscribe = queryClient.getMutationCache().subscribe((event) => {
    if (event.type === "observerAdded") observers.push(event.observer);
  });
  mutationCacheUnsubscribers.push(unsubscribe);
  return observers;
}

function withQueryClient(queryClient: QueryClient) {
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

function withTeamRuntime(harness: TeamPageHarness, queryClient: QueryClient) {
  const TeamRuntimeWrapper = harness.Wrapper;
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <TeamRuntimeWrapper>
        <QueryClientProvider client={queryClient}>
          {props.children}
        </QueryClientProvider>
      </TeamRuntimeWrapper>
    );
  };
}

function authServiceHasSignedInProfile(auth: AuthService): boolean {
  const snapshot = auth.getCurrentSessionSnapshot();
  return snapshot.status === "signed-in" && snapshot.profile !== null;
}

const queryClients: QueryClient[] = [];
const unstartedAuthServices: AuthService[] = [];
const mutationCacheUnsubscribers: Array<() => void> = [];
const consoleSpyRestorers: Array<() => void> = [];
let activeAuthHttpRestore: (() => void) | null = null;

function captureConsoleOutput(): unknown[][] {
  const output: unknown[][] = [];
  const debug = vi.spyOn(console, "debug").mockImplementation((...values) => {
    output.push(values);
  });
  const info = vi.spyOn(console, "info").mockImplementation((...values) => {
    output.push(values);
  });
  const log = vi.spyOn(console, "log").mockImplementation((...values) => {
    output.push(values);
  });
  const warn = vi.spyOn(console, "warn").mockImplementation((...values) => {
    output.push(values);
  });
  const error = vi.spyOn(console, "error").mockImplementation((...values) => {
    output.push(values);
  });
  consoleSpyRestorers.push(
    () => debug.mockRestore(),
    () => info.mockRestore(),
    () => log.mockRestore(),
    () => warn.mockRestore(),
    () => error.mockRestore(),
  );
  return output;
}

beforeEach(async () => {
  const queryClient = createAppQueryClient();
  queryClients.push(queryClient);
  const authService = await createVerifiedTeamAuthService(queryClient, null);
  authMocks.getAuthService.mockReturnValue(authService);
});

afterEach(() => {
  activeAuthHttpRestore?.();
  activeAuthHttpRestore = null;
  cleanup();
  authMocks.getAuthService.mockReset();
  resetTeamPageHarness();
  for (const authService of unstartedAuthServices.splice(0))
    authService.dispose();
  for (const unsubscribe of mutationCacheUnsubscribers.splice(0)) unsubscribe();
  for (const restore of consoleSpyRestorers.splice(0)) restore();
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
});

describe("one-shot auth mutation inputs", () => {
  it.each([
    {
      settles: "successfully" as const,
      replies: [
        {
          path: "/api/v3/auth/link/claim",
          status: 200,
          body: '{"status":"claimed","secret":"synthetic-link-poll-secret","interval":1}',
        },
        {
          path: "/api/v3/auth/link/token",
          status: 200,
          body: '{"token":"synthetic-link-access-token","refreshToken":"synthetic-link-refresh-token","familyId":"synthetic-link-family"}',
        },
      ],
      expectedKind: "signed-in",
    },
    {
      settles: "with a typed refusal" as const,
      replies: [{ path: "/api/v3/auth/link/claim", status: 401, body: "" }],
      expectedKind: "invalid-code",
    },
  ])(
    "sends a submitted link code and retains none after it settles $settles",
    async ({ replies, expectedKind }) => {
      const consoleOutput = captureConsoleOutput();
      const secret = "synthetic-link-sign-in-code";
      useAuthStore.getState().setSignedOut();
      const authService = createUnstartedAuthService();
      unstartedAuthServices.push(authService);
      authMocks.getAuthService.mockReturnValue(authService);
      const boundary = installAuthHttpBoundary(replies, secret);
      const queryClient = queryClients.at(-1);
      if (queryClient === undefined)
        throw new Error("Query client was not created");
      const observers = captureMutationObservers(queryClient);
      const { result } = renderHook(
        () => {
          const submittedCode = useSubmittedSecretInput<string>(
            "Link code input is unavailable.",
          );
          return {
            input: submittedCode,
            mutation: useLinkCodeSignInMutation(
              submittedCode.read,
              submittedCode.clear,
            ),
          };
        },
        { wrapper: withQueryClient(queryClient) },
      );

      await act(async () => {
        result.current.input.set(secret);
        await result.current.mutation.mutateAsync(undefined);
      });
      await waitFor(() => expect(result.current.mutation.isSuccess).toBe(true));
      const replayIsSafe = await replayRetainedMutationWithoutSecret({
        queryClient,
        boundary,
        variables: undefined,
        fixedRefusal: "Link code input is unavailable.",
        secret,
      });
      const retention = retainedStateDiagnostics({
        queryClient,
        observers,
        consoleOutput,
        hookResult: result.current,
        secret,
      });
      expect({
        mutationSettled: result.current.mutation.isSuccess,
        resultKindMatches:
          result.current.mutation.isSuccess &&
          result.current.mutation.data.kind === expectedKind,
        requestContainsCode: authHttpCallContainsSecret(
          boundary,
          "/api/v3/auth/link/claim",
        ),
        mutationAndObserverSecretFree:
          !retention.mutationAndObserverContainSecret,
        logSecretFree: !retention.logsContainSecret,
        hookResultSecretFree: !retention.hookResultContainsSecret,
        replayIsSafe,
      }).toEqual({
        mutationSettled: true,
        resultKindMatches: true,
        requestContainsCode: true,
        mutationAndObserverSecretFree: true,
        logSecretFree: true,
        hookResultSecretFree: true,
        replayIsSafe: true,
      });
    },
  );

  it.each([
    { status: 200, body: '{"ok":true}', outcome: "ok" as const },
    { status: 404, body: "", outcome: "gone" as const },
  ])(
    "sends the claimed code and retains none after the AuthService result is $outcome",
    async ({ status, body, outcome }) => {
      const consoleOutput = captureConsoleOutput();
      const secret = "synthetic-claimed-link-code";
      const boundary = installAuthHttpBoundary(
        [{ path: "/api/v3/auth/link/respond", status, body }],
        secret,
      );
      const queryClient = queryClients.at(-1);
      if (queryClient === undefined)
        throw new Error("Query client was not created");
      const observers = captureMutationObservers(queryClient);
      const { result } = renderHook(
        () => {
          const submittedCode = useSubmittedSecretInput<string>(
            "Link claim input is unavailable.",
          );
          return {
            input: submittedCode,
            mutation: useRespondLinkLoginMutation(
              submittedCode.read,
              submittedCode.clear,
            ),
          };
        },
        { wrapper: withQueryClient(queryClient) },
      );

      await act(async () => {
        result.current.input.set(secret);
        await result.current.mutation.mutateAsync({ approve: true });
      });
      await waitFor(() => expect(result.current.mutation.isSuccess).toBe(true));
      const replayIsSafe = await replayRetainedMutationWithoutSecret({
        queryClient,
        boundary,
        variables: { approve: true },
        fixedRefusal: "Link claim input is unavailable.",
        secret,
      });
      const retention = retainedStateDiagnostics({
        queryClient,
        observers,
        consoleOutput,
        hookResult: result.current,
        secret,
      });
      expect({
        mutationSettled: result.current.mutation.isSuccess,
        resultMatches: result.current.mutation.data === outcome,
        requestContainsCode: authHttpCallContainsSecret(
          boundary,
          "/api/v3/auth/link/respond",
        ),
        mutationAndObserverSecretFree:
          !retention.mutationAndObserverContainSecret,
        logSecretFree: !retention.logsContainSecret,
        hookResultSecretFree: !retention.hookResultContainsSecret,
        replayIsSafe,
      }).toEqual({
        mutationSettled: true,
        resultMatches: true,
        requestContainsCode: true,
        mutationAndObserverSecretFree: true,
        logSecretFree: true,
        hookResultSecretFree: true,
        replayIsSafe: true,
      });
    },
  );

  it.each([
    {
      status: 200,
      body: '{"access_token":"synthetic-step-up-token","token_type":"Bearer","expires_in":300}',
      settles: "successfully" as const,
    },
    {
      status: 400,
      body: '{"error":"invalid"}',
      settles: "with an error" as const,
    },
  ])(
    "sends a step-up code and retains none after it settles $settles",
    async ({ status, body }) => {
      const consoleOutput = captureConsoleOutput();
      const secret = "synthetic-step-up-code";
      const harness = mountTeamPageWithRealBoundary({});
      await waitFor(() =>
        expect(authServiceHasSignedInProfile(harness.auth)).toBe(true),
      );
      const boundary = installAuthHttpBoundary(
        [{ path: "/api/v3/user/step-up/verify", status, body }],
        secret,
      );
      const queryClient = createAppQueryClient();
      queryClients.push(harness.queryClient);
      queryClients.push(queryClient);
      const observers = captureMutationObservers(queryClient);
      const { result } = renderHook(
        () => {
          const submittedCode = useSubmittedSecretInput<string>(
            "Verification code input is unavailable.",
          );
          return {
            input: submittedCode,
            mutation: useAuthVerifyStepUpChallenge(
              submittedCode.read,
              submittedCode.clear,
            ),
          };
        },
        { wrapper: withTeamRuntime(harness, queryClient) },
      );
      const observations = {
        rejected: false,
        rejectionContainsSecret: false,
      };
      await act(async () => {
        result.current.input.set(secret);
        const execution = await observeMutationExecution(
          () => result.current.mutation.mutateAsync(undefined),
          secret,
        );
        observations.rejected = execution.rejected;
        observations.rejectionContainsSecret = execution.errorContainsSecret;
      });
      const expectedStatus = status === 400 ? "error" : "success";
      await waitFor(() =>
        expect(result.current.mutation.status).toBe(expectedStatus),
      );
      const replayIsSafe = await replayRetainedMutationWithoutSecret({
        queryClient,
        boundary,
        variables: undefined,
        fixedRefusal: "Verification code input is unavailable.",
        secret,
      });
      const retention = retainedStateDiagnostics({
        queryClient,
        observers,
        consoleOutput,
        hookResult: result.current,
        secret,
      });
      expect({
        mutationStatusMatches:
          result.current.mutation.status === expectedStatus,
        requestContainsCode: authHttpCallContainsSecret(
          boundary,
          "/api/v3/user/step-up/verify",
        ),
        mutationAndObserverSecretFree:
          !retention.mutationAndObserverContainSecret,
        logSecretFree: !retention.logsContainSecret,
        hookResultSecretFree: !retention.hookResultContainsSecret,
        rejectedMatchesResponse: observations.rejected === (status === 400),
        rejectionSecretFree: !observations.rejectionContainsSecret,
        replayIsSafe,
      }).toEqual({
        mutationStatusMatches: true,
        requestContainsCode: true,
        mutationAndObserverSecretFree: true,
        logSecretFree: true,
        hookResultSecretFree: true,
        rejectedMatchesResponse: true,
        rejectionSecretFree: true,
        replayIsSafe: true,
      });
    },
  );

  it("drops a link code on AuthService's native description refusal before HTTP", async () => {
    const consoleOutput = captureConsoleOutput();
    const secret = "synthetic-describer-link-code";
    const harness = mountTeamPageWithRealBoundary({});
    queryClients.push(harness.queryClient);
    const queryClient = createAppQueryClient();
    queryClients.push(queryClient);
    Object.defineProperty(harness.runnerHost, "deviceDescriber", {
      configurable: true,
      value: {
        describe: () =>
          Promise.reject(new Error("Safe device description failure")),
      },
    });
    authMocks.getAuthService.mockReturnValue(harness.auth);
    const boundary = installAuthHttpBoundary([], secret);
    const observers = captureMutationObservers(queryClient);
    const { result } = renderHook(
      () => {
        const submittedCode = useSubmittedSecretInput<string>(
          "Link code input is unavailable.",
        );
        return {
          input: submittedCode,
          mutation: useLinkCodeSignInMutation(
            submittedCode.read,
            submittedCode.clear,
          ),
        };
      },
      { wrapper: withTeamRuntime(harness, queryClient) },
    );
    const observations = {
      rejected: false,
      rejectionContainsSecret: false,
    };
    await act(async () => {
      result.current.input.set(secret);
      const execution = await observeMutationExecution(
        () => result.current.mutation.mutateAsync(undefined),
        secret,
      );
      observations.rejected = execution.rejected;
      observations.rejectionContainsSecret = execution.errorContainsSecret;
    });
    await waitFor(() => expect(result.current.mutation.isError).toBe(true));
    const replayIsSafe = await replayRetainedMutationWithoutSecret({
      queryClient,
      boundary,
      variables: undefined,
      fixedRefusal: "Link code input is unavailable.",
      secret,
    });
    const retention = retainedStateDiagnostics({
      queryClient,
      observers,
      consoleOutput,
      hookResult: result.current,
      secret,
    });
    expect({
      mutationIsError: result.current.mutation.isError,
      requestAbsent: boundary.calls.length === 0,
      mutationAndObserverSecretFree:
        !retention.mutationAndObserverContainSecret,
      logSecretFree: !retention.logsContainSecret,
      hookResultSecretFree: !retention.hookResultContainsSecret,
      mutationRejected: observations.rejected,
      rejectionSecretFree: !observations.rejectionContainsSecret,
      replayIsSafe,
    }).toEqual({
      mutationIsError: true,
      requestAbsent: true,
      mutationAndObserverSecretFree: true,
      logSecretFree: true,
      hookResultSecretFree: true,
      mutationRejected: true,
      rejectionSecretFree: true,
      replayIsSafe: true,
    });
  });

  it("clears an unsubmitted code when its input unmounts", () => {
    const consoleOutput = captureConsoleOutput();
    const secret = "synthetic-unmounted-link-code";
    const { result, unmount } = renderHook(() =>
      useSubmittedSecretInput<string>("Link code input is unavailable."),
    );
    result.current.set(secret);
    const readInput = result.current.read;
    unmount();
    expect(
      inputUnavailableWithoutSecret(
        readInput,
        "Link code input is unavailable.",
        secret,
      ) && !containsSecret(consoleOutput, secret),
    ).toBe(true);
  });

  it("clears a step-up snapshot after a pre-reader AuthService refusal", async () => {
    const consoleOutput = captureConsoleOutput();
    const secret = "synthetic-preflight-step-up-code";
    const boundary = installAuthHttpBoundary([], secret);
    const queryClient = queryClients.at(-1);
    if (queryClient === undefined)
      throw new Error("Query client was not created");
    const observers = captureMutationObservers(queryClient);
    const { result } = renderHook(
      () => {
        const submittedCode = useSubmittedSecretInput<string>(
          "Verification code input is unavailable.",
        );
        return {
          input: submittedCode,
          mutation: useAuthVerifyStepUpChallenge(
            submittedCode.read,
            submittedCode.clear,
          ),
        };
      },
      { wrapper: withQueryClient(queryClient) },
    );
    const observations = {
      rejected: false,
      rejectionContainsSecret: false,
    };
    await act(async () => {
      result.current.input.set(secret);
      const execution = await observeMutationExecution(
        () => result.current.mutation.mutateAsync(undefined),
        secret,
      );
      observations.rejected = execution.rejected;
      observations.rejectionContainsSecret = execution.errorContainsSecret;
    });
    await waitFor(() => expect(result.current.mutation.isError).toBe(true));
    const submittedSnapshotUnavailable = inputUnavailableWithoutSecret(
      result.current.input.read,
      "Verification code input is unavailable.",
      secret,
    );
    const replayIsSafe = await replayRetainedMutationWithoutSecret({
      queryClient,
      boundary,
      variables: undefined,
      fixedRefusal: "Sign in again to verify this action.",
      secret,
    });
    const retention = retainedStateDiagnostics({
      queryClient,
      observers,
      consoleOutput,
      hookResult: result.current,
      secret,
    });
    expect({
      mutationIsError: result.current.mutation.isError,
      requestAbsent: boundary.calls.length === 0,
      mutationAndObserverSecretFree:
        !retention.mutationAndObserverContainSecret,
      logSecretFree: !retention.logsContainSecret,
      hookResultSecretFree: !retention.hookResultContainsSecret,
      mutationRejected: observations.rejected,
      rejectionSecretFree: !observations.rejectionContainsSecret,
      submittedSnapshotUnavailable,
      replayIsSafe,
    }).toEqual({
      mutationIsError: true,
      requestAbsent: true,
      mutationAndObserverSecretFree: true,
      logSecretFree: true,
      hookResultSecretFree: true,
      mutationRejected: true,
      rejectionSecretFree: true,
      submittedSnapshotUnavailable: true,
      replayIsSafe: true,
    });
  });
});
