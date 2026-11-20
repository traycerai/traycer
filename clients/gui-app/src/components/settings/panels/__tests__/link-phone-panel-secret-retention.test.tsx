import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkPhonePanel } from "../link-phone-panel";
import {
  claimedStatus,
  queryResultWithCode,
  statusResult,
} from "./link-phone-panel-test-support";
import {
  mountTeamPageWithRealBoundary,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { createAppQueryClient } from "@/lib/query-client";
import { AuthService } from "@/lib/auth/auth-service";

const linkMocks = vi.hoisted(() => ({
  useCode: vi.fn(),
  useStatus: vi.fn(),
  evict: vi.fn(),
}));

const submittedInputs = vi.hoisted(() => ({
  records: [] as Array<{
    readonly message: string;
    readonly read: () => unknown;
    readonly clear: () => void;
  }>,
}));

vi.mock("@/hooks/auth/use-link-login-code-query", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/auth/use-link-login-code-query")
    >();
  return {
    ...actual,
    useAuthLinkLoginCode: linkMocks.useCode,
    useEvictLinkLoginCode: () => linkMocks.evict,
  };
});

vi.mock("@/hooks/auth/use-link-login-status-query", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/auth/use-link-login-status-query")
    >();
  return { ...actual, useAuthLinkLoginStatus: linkMocks.useStatus };
});

vi.mock("@/hooks/use-submitted-secret-input", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-submitted-secret-input")>();
  return {
    ...actual,
    useSubmittedSecretInput: <Value,>(message: string) => {
      const submitted = actual.useSubmittedSecretInput<Value>(message);
      submittedInputs.records.push({
        message,
        read: submitted.read,
        clear: submitted.clear,
      });
      return submitted;
    },
  };
});

interface AuthHttpCall {
  readonly path: string;
  readonly method: string;
  readonly codePresent: boolean;
}

interface AuthHttpBoundary {
  readonly calls: AuthHttpCall[];
}

interface MutationObserverReference {
  readonly options: unknown;
  readonly getCurrentResult: () => unknown;
}

interface SubmittedInputReference {
  readonly read: () => unknown;
  readonly clear: () => void;
}

interface DeferredResponse {
  readonly promise: Promise<Response>;
  readonly resolve: (response: Response) => void;
}

interface MutationRetentionDiagnostics {
  readonly mutationStateContainsSecret: boolean;
  readonly observerOptionsContainSecret: boolean;
  readonly hookResultContainsSecret: boolean;
}

interface ReplayDiagnostics {
  readonly refused: boolean;
  readonly errorContainsSecret: boolean;
  readonly requestCountUnchanged: boolean;
}

function authRequestUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url);
  if (input instanceof URL) return input;
  return new URL(input);
}

function createResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createDeferredResponse(): DeferredResponse {
  const deferred = {
    resolve: null as ((response: Response) => void) | null,
  };
  const promise = new Promise<Response>((resolve) => {
    deferred.resolve = resolve;
  });
  return {
    promise,
    resolve: (response) => {
      const resolveResponse = deferred.resolve;
      if (resolveResponse === null)
        throw new Error("Deferred response was not initialized");
      resolveResponse(response);
    },
  };
}

function installAuthHttpBoundary(
  code: string,
  respond: () => Promise<Response>,
): AuthHttpBoundary {
  const previousFetch = globalThis.fetch;
  const calls: AuthHttpCall[] = [];
  globalThis.fetch = async (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ): Promise<Response> => {
    const url = authRequestUrl(input);
    if (url.pathname !== "/api/v3/auth/link/respond") {
      return previousFetch(input, init);
    }
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({
      path: url.pathname,
      method: init?.method ?? "GET",
      codePresent: body.includes(code),
    });
    return respond();
  };
  const restore = (): void => {
    globalThis.fetch = previousFetch;
  };
  activeFetch.restore = restore;
  return { calls };
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

function mutationRetentionDiagnostics(
  queryClient: QueryClient,
  observers: readonly MutationObserverReference[],
  secret: string,
): MutationRetentionDiagnostics {
  const mutations = queryClient.getMutationCache().getAll();
  return {
    mutationStateContainsSecret: mutations.some((mutation) =>
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
    ),
    observerOptionsContainSecret: observers.some((observer) =>
      containsSecret(observer.options, secret),
    ),
    hookResultContainsSecret: observers.some((observer) =>
      containsSecret(observer.getCurrentResult(), secret),
    ),
  };
}

function latestMutation(queryClient: QueryClient) {
  const mutation = queryClient.getMutationCache().getAll().at(-1);
  if (mutation === undefined) throw new Error("Mutation was not retained");
  return mutation;
}

function readerFor(message: string): SubmittedInputReference {
  const record = submittedInputs.records
    .filter((candidate) => candidate.message === message)
    .at(-1);
  if (record === undefined)
    throw new Error("Submitted input handle was not recorded");
  return record;
}

function inputUnavailableWithoutSecret(
  input: SubmittedInputReference,
  message: string,
  secret: string,
): boolean {
  try {
    input.read();
  } catch (error) {
    return (
      error instanceof Error &&
      error.message === message &&
      !containsSecret(error, secret)
    );
  }
  return false;
}

async function replayRetainedMutation(
  queryClient: QueryClient,
  boundary: AuthHttpBoundary,
  secret: string,
): Promise<ReplayDiagnostics> {
  const mutation = latestMutation(queryClient);
  const mutationFn = mutation.options.mutationFn;
  if (mutationFn === undefined)
    throw new Error("Retained mutation has no mutation function");
  const requestCount = boundary.calls.length;
  try {
    await mutationFn(
      { approve: true },
      {
        client: queryClient,
        meta: mutation.options.meta,
        mutationKey: mutation.options.mutationKey ?? [],
      },
    );
  } catch (error) {
    return {
      refused:
        error instanceof Error &&
        error.message === "Link claim input is unavailable.",
      errorContainsSecret: containsSecret(error, secret),
      requestCountUnchanged: boundary.calls.length === requestCount,
    };
  }
  return {
    refused: false,
    errorContainsSecret: false,
    requestCountUnchanged: boundary.calls.length === requestCount,
  };
}

function withAppQueryClient(
  harness: TeamPageHarness,
  queryClient: QueryClient,
) {
  const TeamWrapper = harness.Wrapper;
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <TeamWrapper>
        <QueryClientProvider client={queryClient}>
          {props.children}
        </QueryClientProvider>
      </TeamWrapper>
    );
  };
}

function authServiceHasSignedInProfile(auth: AuthService): boolean {
  const snapshot = auth.getCurrentSessionSnapshot();
  return snapshot.status === "signed-in" && snapshot.profile !== null;
}

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

function withLinkClaim() {
  linkMocks.useCode.mockReturnValue(queryResultWithCode(Date.now()));
  linkMocks.useStatus.mockReturnValue(
    statusResult(claimedStatus(Date.now(), "TraycerMobile/1.0 (iPhone)")),
  );
}

const queryClients: QueryClient[] = [];
const mutationCacheUnsubscribers: Array<() => void> = [];
const consoleSpyRestorers: Array<() => void> = [];
const activeFetch: { restore: (() => void) | null } = { restore: null };

beforeEach(() => {
  linkMocks.useCode.mockReset();
  linkMocks.useStatus.mockReset();
  linkMocks.evict.mockReset();
  submittedInputs.records.length = 0;
});

afterEach(() => {
  activeFetch.restore?.();
  activeFetch.restore = null;
  cleanup();
  resetTeamPageHarness();
  for (const unsubscribe of mutationCacheUnsubscribers.splice(0)) unsubscribe();
  for (const restore of consoleSpyRestorers.splice(0)) restore();
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
  submittedInputs.records.length = 0;
});

describe("LinkPhonePanel submitted claim retention", () => {
  it.each([
    {
      status: 200,
      body: '{"ok":true}',
      settles: "successfully" as const,
      outcome: "ok" as const,
    },
    {
      status: 503,
      body: "",
      settles: "with a typed network failure" as const,
      outcome: "failed" as const,
    },
  ])(
    "releases submitted claim inputs after the real AuthService result settles $settles",
    async ({ status, body, outcome }) => {
      const secret = "ABCDE-FGHJK";
      const harness = mountTeamPageWithRealBoundary({});
      queryClients.push(harness.queryClient);
      await waitFor(() =>
        expect(authServiceHasSignedInProfile(harness.auth)).toBe(true),
      );
      withLinkClaim();
      const queryClient = createAppQueryClient();
      queryClients.push(queryClient);
      const observers = captureMutationObservers(queryClient);
      const consoleOutput = captureConsoleOutput();
      const boundary = installAuthHttpBoundary(secret, () =>
        Promise.resolve(createResponse(status, body)),
      );
      const view = render(<LinkPhonePanel />, {
        wrapper: withAppQueryClient(harness, queryClient),
      });
      await waitFor(() =>
        expect(screen.getByTestId("link-phone-confirm")).toBeTruthy(),
      );
      fireEvent.click(screen.getByTestId("link-phone-approve"));
      await waitFor(() => expect(boundary.calls.length).toBe(1));
      await waitFor(() =>
        expect(
          screen.queryByTestId(
            outcome === "ok"
              ? "link-phone-approved"
              : "link-phone-respond-failed",
          ),
        ).not.toBeNull(),
      );
      await waitFor(() =>
        expect(latestMutation(queryClient).state.status).toBe("success"),
      );
      const codeInputSpent = inputUnavailableWithoutSecret(
        readerFor("Link claim input is unavailable."),
        "Link claim input is unavailable.",
        secret,
      );
      const decisionInputSpent = inputUnavailableWithoutSecret(
        readerFor("Link decision input is unavailable."),
        "Link decision input is unavailable.",
        secret,
      );
      const retention = mutationRetentionDiagnostics(
        queryClient,
        observers,
        secret,
      );
      const replay = await replayRetainedMutation(
        queryClient,
        boundary,
        secret,
      );
      expect({
        requestContainsCode:
          boundary.calls[0]?.path === "/api/v3/auth/link/respond" &&
          boundary.calls[0]?.method === "POST" &&
          boundary.calls[0]?.codePresent,
        mutationSucceeded:
          latestMutation(queryClient).state.status === "success",
        resultMatches: latestMutation(queryClient).state.data === outcome,
        confirmCardVisible: screen.queryByTestId("link-phone-confirm") !== null,
        approvedUiVisible: screen.queryByTestId("link-phone-approved") !== null,
        failedUiVisible:
          screen.queryByTestId("link-phone-respond-failed") !== null,
        codeInputSpent,
        decisionInputSpent,
        mutationStateSecretFree: !retention.mutationStateContainsSecret,
        observerOptionsSecretFree: !retention.observerOptionsContainSecret,
        hookResultSecretFree: !retention.hookResultContainsSecret,
        logsSecretFree: !containsSecret(consoleOutput, secret),
        replayRefused: replay.refused,
        replayErrorSecretFree: !replay.errorContainsSecret,
        replaySentNoRequest: replay.requestCountUnchanged,
      }).toEqual({
        requestContainsCode: true,
        mutationSucceeded: true,
        resultMatches: true,
        confirmCardVisible: outcome === "failed",
        approvedUiVisible: outcome === "ok",
        failedUiVisible: outcome === "failed",
        codeInputSpent: true,
        decisionInputSpent: true,
        mutationStateSecretFree: true,
        observerOptionsSecretFree: true,
        hookResultSecretFree: true,
        logsSecretFree: true,
        replayRefused: true,
        replayErrorSecretFree: true,
        replaySentNoRequest: true,
      });
      view.unmount();
      const postUnmountRetention = mutationRetentionDiagnostics(
        queryClient,
        observers,
        secret,
      );
      const codeInputEmptyAfterUnmount = inputUnavailableWithoutSecret(
        readerFor("Link claim input is unavailable."),
        "Link claim input is unavailable.",
        secret,
      );
      const decisionInputEmptyAfterUnmount = inputUnavailableWithoutSecret(
        readerFor("Link decision input is unavailable."),
        "Link decision input is unavailable.",
        secret,
      );
      expect({
        codeInputEmptyAfterUnmount,
        decisionInputEmptyAfterUnmount,
        mutationStateSecretFree:
          !postUnmountRetention.mutationStateContainsSecret,
        observerOptionsSecretFree:
          !postUnmountRetention.observerOptionsContainSecret,
        hookResultSecretFree: !postUnmountRetention.hookResultContainsSecret,
        logsSecretFree: !containsSecret(consoleOutput, secret),
      }).toEqual({
        codeInputEmptyAfterUnmount: true,
        decisionInputEmptyAfterUnmount: true,
        mutationStateSecretFree: true,
        observerOptionsSecretFree: true,
        hookResultSecretFree: true,
        logsSecretFree: true,
      });
    },
  );

  it("clears submitted claim inputs before an in-flight result settles after unmount", async () => {
    const secret = "ABCDE-FGHJK";
    const harness = mountTeamPageWithRealBoundary({});
    queryClients.push(harness.queryClient);
    await waitFor(() =>
      expect(authServiceHasSignedInProfile(harness.auth)).toBe(true),
    );
    withLinkClaim();
    const queryClient = createAppQueryClient();
    queryClients.push(queryClient);
    const observers = captureMutationObservers(queryClient);
    const consoleOutput = captureConsoleOutput();
    const deferred = createDeferredResponse();
    const boundary = installAuthHttpBoundary(secret, () => deferred.promise);
    const view = render(<LinkPhonePanel />, {
      wrapper: withAppQueryClient(harness, queryClient),
    });
    await waitFor(() =>
      expect(screen.getByTestId("link-phone-confirm")).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("link-phone-approve"));
    await waitFor(() => expect(boundary.calls.length).toBe(1));
    const codeInput = readerFor("Link claim input is unavailable.");
    const decisionInput = readerFor("Link decision input is unavailable.");
    view.unmount();
    const codeInputCleared = inputUnavailableWithoutSecret(
      codeInput,
      "Link claim input is unavailable.",
      secret,
    );
    const decisionInputCleared = inputUnavailableWithoutSecret(
      decisionInput,
      "Link decision input is unavailable.",
      secret,
    );
    deferred.resolve(createResponse(503, ""));
    await waitFor(() =>
      expect(latestMutation(queryClient).state.status).toBe("success"),
    );
    const retention = mutationRetentionDiagnostics(
      queryClient,
      observers,
      secret,
    );
    const replay = await replayRetainedMutation(queryClient, boundary, secret);
    expect({
      requestContainsCode:
        boundary.calls[0]?.path === "/api/v3/auth/link/respond" &&
        boundary.calls[0]?.method === "POST" &&
        boundary.calls[0]?.codePresent,
      codeInputCleared,
      decisionInputCleared,
      mutationStateSecretFree: !retention.mutationStateContainsSecret,
      observerOptionsSecretFree: !retention.observerOptionsContainSecret,
      hookResultSecretFree: !retention.hookResultContainsSecret,
      logsSecretFree: !containsSecret(consoleOutput, secret),
      replayRefused: replay.refused,
      replayErrorSecretFree: !replay.errorContainsSecret,
      replaySentNoRequest: replay.requestCountUnchanged,
    }).toEqual({
      requestContainsCode: true,
      codeInputCleared: true,
      decisionInputCleared: true,
      mutationStateSecretFree: true,
      observerOptionsSecretFree: true,
      hookResultSecretFree: true,
      logsSecretFree: true,
      replayRefused: true,
      replayErrorSecretFree: true,
      replaySentNoRequest: true,
    });
  });
});
