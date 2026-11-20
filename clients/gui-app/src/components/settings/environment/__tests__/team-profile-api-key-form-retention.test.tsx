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
import type { AuthService } from "@/lib/auth/auth-service";
import { TeamProfileApiKeyForm } from "@/components/settings/environment/team-profile-api-key-form";
import {
  createVerifiedTeamAuthService,
  resetTeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { teamProviderProfile } from "@/components/settings/environment/__tests__/team-providers-test-support";
import { createAppQueryClient } from "@/lib/query-client";

const authHolder = vi.hoisted(() => ({
  service: null as AuthService | null,
}));

const submittedInputs = vi.hoisted(() => ({
  records: [] as Array<{
    readonly message: string;
    readonly read: () => unknown;
    readonly clear: () => void;
  }>,
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => ({ auth: authHolder.service }),
  };
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
  readonly authorized: boolean;
  readonly keyPresent: boolean;
}

interface AuthHttpBoundary {
  readonly calls: AuthHttpCall[];
}

interface MutationObserverReference {
  readonly options: unknown;
  readonly getCurrentResult: () => unknown;
}

interface MutationRetentionDiagnostics {
  readonly mutationStateContainsSecret: boolean;
  readonly observerOptionsContainSecret: boolean;
  readonly hookResultContainsSecret: boolean;
}

interface ReplayDiagnostics {
  readonly refused: boolean;
  readonly returnedUnauthorized: boolean;
  readonly errorContainsSecret: boolean;
  readonly requestCountUnchanged: boolean;
}

interface MutationOutcome {
  readonly kind: string;
}

interface SubmittedInputReference {
  readonly read: () => unknown;
  readonly clear: () => void;
}

const queryClients: QueryClient[] = [];
const mutationCacheUnsubscribers: Array<() => void> = [];
const consoleRestorers: Array<() => void> = [];
const activeFetch: { restore: (() => void) | null } = { restore: null };

function urlOf(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url);
  if (input instanceof URL) return input;
  return new URL(input);
}

function jsonResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installAuthHttpBoundary(
  secret: string,
  writeStatus: number,
  listStatus: number,
): AuthHttpBoundary {
  const supportFetch = globalThis.fetch;
  const calls: AuthHttpCall[] = [];
  globalThis.fetch = async (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ): Promise<Response> => {
    const url = urlOf(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    if (
      url.pathname === "/api/v3/environments/env-a/secrets/harness-connections"
    ) {
      calls.push({
        path: url.pathname,
        method,
        authorized: headers.has("authorization"),
        keyPresent: body.includes(secret),
      });
      return listStatus === 200
        ? jsonResponse(
            200,
            '{"connections":[{"profileId":"profile-1","bindingVersion":1}]}',
          )
        : jsonResponse(listStatus, "");
    }
    if (
      url.pathname ===
      "/api/v3/environments/env-a/secrets/harness-connections/profile-1/connect"
    ) {
      calls.push({
        path: url.pathname,
        method,
        authorized: headers.has("authorization"),
        keyPresent: body.includes(secret),
      });
      return writeStatus === 200
        ? jsonResponse(
            200,
            '{"profileId":"profile-1","harnessId":"claude","kind":"api_key","status":"connected"}',
          )
        : jsonResponse(503, "");
    }
    return supportFetch(input, init);
  };
  activeFetch.restore = () => {
    globalThis.fetch = supportFetch;
  };
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

function isMutationOutcome(value: unknown): value is MutationOutcome {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof value.kind === "string"
  );
}

function latestMutationKind(queryClient: QueryClient): string | null {
  const data = latestMutation(queryClient).state.data;
  return isMutationOutcome(data) ? data.kind : null;
}

function latestSubmittedInput(message: string): SubmittedInputReference | null {
  const record = submittedInputs.records
    .filter((candidate) => candidate.message === message)
    .at(-1);
  return record ?? null;
}

function submittedInputIsEmpty(
  input: SubmittedInputReference | null,
  unavailableMessage: string,
  secret: string,
): boolean {
  if (input === null) return false;
  try {
    input.read();
  } catch (error) {
    return (
      error instanceof Error &&
      error.message === unavailableMessage &&
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
  const countBeforeReplay = boundary.calls.length;
  try {
    const outcome = await mutationFn(undefined, {
      client: queryClient,
      meta: mutation.options.meta,
      mutationKey: mutation.options.mutationKey ?? [],
    });
    return {
      refused: false,
      returnedUnauthorized:
        isMutationOutcome(outcome) && outcome.kind === "unauthorized",
      errorContainsSecret: false,
      requestCountUnchanged: boundary.calls.length === countBeforeReplay,
    };
  } catch (error) {
    return {
      refused:
        error instanceof Error &&
        error.message === "Profile key input is unavailable.",
      returnedUnauthorized: false,
      errorContainsSecret: containsSecret(error, secret),
      requestCountUnchanged: boundary.calls.length === countBeforeReplay,
    };
  }
  return {
    refused: false,
    returnedUnauthorized: false,
    errorContainsSecret: false,
    requestCountUnchanged: boundary.calls.length === countBeforeReplay,
  };
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
  consoleRestorers.push(
    () => debug.mockRestore(),
    () => info.mockRestore(),
    () => log.mockRestore(),
    () => warn.mockRestore(),
    () => error.mockRestore(),
  );
  return output;
}

function inputMatches(value: string): boolean {
  const input = screen.queryByLabelText("API key");
  return input instanceof HTMLInputElement && input.value === value;
}

function writeSentWithSecret(boundary: AuthHttpBoundary): boolean {
  return boundary.calls.some(
    (call) =>
      call.path ===
        "/api/v3/environments/env-a/secrets/harness-connections/profile-1/connect" &&
      call.method === "POST" &&
      call.authorized &&
      call.keyPresent,
  );
}

function renderForm(queryClient: QueryClient) {
  return render(
    <TeamProfileApiKeyForm
      providerId="claude-code"
      profile={teamProviderProfile({
        profileId: "profile-1",
        label: "Work account",
        authStatus: "authenticated",
        personNotice: null,
        apiKeyConfigured: true,
      })}
      environmentId="env-a"
      reread={() => Promise.resolve(undefined)}
    />,
    { wrapper: withQueryClient(queryClient) },
  );
}

beforeEach(() => {
  authHolder.service = null;
  submittedInputs.records.splice(0);
});

afterEach(() => {
  activeFetch.restore?.();
  activeFetch.restore = null;
  cleanup();
  authHolder.service = null;
  submittedInputs.records.splice(0);
  for (const unsubscribe of mutationCacheUnsubscribers.splice(0)) unsubscribe();
  for (const restore of consoleRestorers.splice(0)) restore();
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
  resetTeamPageHarness();
});

describe("team profile API key submitted input retention", () => {
  it.each([
    {
      status: 200,
      listStatus: 200,
      settles: "successfully" as const,
      result: "ok" as const,
    },
    {
      status: 503,
      listStatus: 200,
      settles: "with a refused HTTP response" as const,
      result: "failed" as const,
    },
  ])(
    "releases the submitted key when the real AuthService settles $settles",
    async ({ status, listStatus, result }) => {
      const secret = "synthetic-team-profile-api-key";
      const queryClient = createAppQueryClient();
      queryClients.push(queryClient);
      authHolder.service = await createVerifiedTeamAuthService(
        queryClient,
        null,
      );
      const boundary = installAuthHttpBoundary(secret, status, listStatus);
      const observers = captureMutationObservers(queryClient);
      const consoleOutput = captureConsoleOutput();
      const view = renderForm(queryClient);
      fireEvent.change(screen.getByLabelText("API key"), {
        target: { value: secret },
      });
      fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
      await waitFor(() => expect(writeSentWithSecret(boundary)).toBe(true));
      await waitFor(() =>
        expect(latestMutation(queryClient).state.status).toBe("success"),
      );
      await waitFor(() =>
        expect(
          result === "ok"
            ? inputMatches("")
            : inputMatches(secret) &&
                screen.queryByText("Couldn't save the API key.") !== null,
        ).toBe(true),
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
        requestContainsKey: writeSentWithSecret(boundary),
        resultMatches: latestMutationKind(queryClient) === result,
        successClearedDraft: result === "ok" && inputMatches(""),
        failureKeptDraft: result === "failed" && inputMatches(secret),
        failureVisible:
          result === "failed" &&
          screen.queryByText("Couldn't save the API key.") !== null,
        mutationStateSecretFree: !retention.mutationStateContainsSecret,
        observerOptionsSecretFree: !retention.observerOptionsContainSecret,
        hookResultSecretFree: !retention.hookResultContainsSecret,
        logsSecretFree: !containsSecret(consoleOutput, secret),
        replayRefused: replay.refused,
        replayReturnedUnauthorized: replay.returnedUnauthorized,
        replayErrorSecretFree: !replay.errorContainsSecret,
        replaySentNoRequest: replay.requestCountUnchanged,
      }).toEqual({
        requestContainsKey: true,
        resultMatches: true,
        successClearedDraft: result === "ok",
        failureKeptDraft: result === "failed",
        failureVisible: result === "failed",
        mutationStateSecretFree: true,
        observerOptionsSecretFree: true,
        hookResultSecretFree: true,
        logsSecretFree: true,
        replayRefused: true,
        replayReturnedUnauthorized: false,
        replayErrorSecretFree: true,
        replaySentNoRequest: true,
      });
      view.unmount();
      const postUnmountRetention = mutationRetentionDiagnostics(
        queryClient,
        observers,
        secret,
      );
      const postUnmountReplay = await replayRetainedMutation(
        queryClient,
        boundary,
        secret,
      );
      expect({
        mutationStateSecretFree:
          !postUnmountRetention.mutationStateContainsSecret,
        observerOptionsSecretFree:
          !postUnmountRetention.observerOptionsContainSecret,
        hookResultSecretFree: !postUnmountRetention.hookResultContainsSecret,
        logsSecretFree: !containsSecret(consoleOutput, secret),
        replayRefused: postUnmountReplay.refused,
        replayReturnedUnauthorized: postUnmountReplay.returnedUnauthorized,
        replayErrorSecretFree: !postUnmountReplay.errorContainsSecret,
        replaySentNoRequest: postUnmountReplay.requestCountUnchanged,
      }).toEqual({
        mutationStateSecretFree: true,
        observerOptionsSecretFree: true,
        hookResultSecretFree: true,
        logsSecretFree: true,
        replayRefused: true,
        replayReturnedUnauthorized: false,
        replayErrorSecretFree: true,
        replaySentNoRequest: true,
      });
    },
  );

  it("releases the submitted key when the binding pre-read is refused", async () => {
    const secret = "synthetic-team-profile-api-key";
    const queryClient = createAppQueryClient();
    queryClients.push(queryClient);
    authHolder.service = await createVerifiedTeamAuthService(queryClient, null);
    const boundary = installAuthHttpBoundary(secret, 200, 503);
    const observers = captureMutationObservers(queryClient);
    const consoleOutput = captureConsoleOutput();
    const view = renderForm(queryClient);
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: secret },
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
    await waitFor(() =>
      expect(latestMutation(queryClient).state.status).toBe("success"),
    );
    await waitFor(() =>
      expect(
        inputMatches(secret) &&
          screen.queryByText("Couldn't save the API key.") !== null,
      ).toBe(true),
    );
    const reader = latestSubmittedInput("Profile key input is unavailable.");
    const retention = mutationRetentionDiagnostics(
      queryClient,
      observers,
      secret,
    );
    const replay = await replayRetainedMutation(queryClient, boundary, secret);
    const readRefused = submittedInputIsEmpty(
      reader,
      "Profile key input is unavailable.",
      secret,
    );
    expect({
      onlyBindingRead: boundary.calls.length === 1,
      bindingReadAuthorized:
        boundary.calls[0]?.path ===
          "/api/v3/environments/env-a/secrets/harness-connections" &&
        boundary.calls[0]?.method === "GET" &&
        boundary.calls[0]?.authorized &&
        !boundary.calls[0]?.keyPresent,
      noWriteContainsKey: !writeSentWithSecret(boundary),
      resultFailed: latestMutationKind(queryClient) === "failed",
      draftKept: inputMatches(secret),
      errorVisible: screen.queryByText("Couldn't save the API key.") !== null,
      submittedInputEmpty: readRefused,
      mutationStateSecretFree: !retention.mutationStateContainsSecret,
      observerOptionsSecretFree: !retention.observerOptionsContainSecret,
      hookResultSecretFree: !retention.hookResultContainsSecret,
      logsSecretFree: !containsSecret(consoleOutput, secret),
      replayRefused: replay.refused,
      replayReturnedUnauthorized: replay.returnedUnauthorized,
      replayErrorSecretFree: !replay.errorContainsSecret,
      replaySentNoRequest: replay.requestCountUnchanged,
    }).toEqual({
      onlyBindingRead: true,
      bindingReadAuthorized: true,
      noWriteContainsKey: true,
      resultFailed: true,
      draftKept: true,
      errorVisible: true,
      submittedInputEmpty: true,
      mutationStateSecretFree: true,
      observerOptionsSecretFree: true,
      hookResultSecretFree: true,
      logsSecretFree: true,
      replayRefused: true,
      replayReturnedUnauthorized: false,
      replayErrorSecretFree: true,
      replaySentNoRequest: true,
    });
    view.unmount();
    const postUnmountRetention = mutationRetentionDiagnostics(
      queryClient,
      observers,
      secret,
    );
    const postUnmountReplay = await replayRetainedMutation(
      queryClient,
      boundary,
      secret,
    );
    expect({
      submittedInputEmpty: submittedInputIsEmpty(
        reader,
        "Profile key input is unavailable.",
        secret,
      ),
      mutationStateSecretFree:
        !postUnmountRetention.mutationStateContainsSecret,
      observerOptionsSecretFree:
        !postUnmountRetention.observerOptionsContainSecret,
      hookResultSecretFree: !postUnmountRetention.hookResultContainsSecret,
      logsSecretFree: !containsSecret(consoleOutput, secret),
      replayRefused: postUnmountReplay.refused,
      replayReturnedUnauthorized: postUnmountReplay.returnedUnauthorized,
      replayErrorSecretFree: !postUnmountReplay.errorContainsSecret,
      replaySentNoRequest: postUnmountReplay.requestCountUnchanged,
    }).toEqual({
      submittedInputEmpty: true,
      mutationStateSecretFree: true,
      observerOptionsSecretFree: true,
      hookResultSecretFree: true,
      logsSecretFree: true,
      replayRefused: true,
      replayReturnedUnauthorized: false,
      replayErrorSecretFree: true,
      replaySentNoRequest: true,
    });
  });

  it("keeps the pre-reader authorization gate and clears its submitted key", async () => {
    const secret = "synthetic-team-profile-api-key";
    const queryClient = createAppQueryClient();
    queryClients.push(queryClient);
    const boundary = installAuthHttpBoundary(secret, 200, 200);
    const observers = captureMutationObservers(queryClient);
    const consoleOutput = captureConsoleOutput();
    const view = renderForm(queryClient);
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: secret },
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
    await waitFor(() =>
      expect(latestMutation(queryClient).state.status).toBe("success"),
    );
    await waitFor(() =>
      expect(
        inputMatches(secret) &&
          screen.queryByText("Please sign in again.") !== null,
      ).toBe(true),
    );
    const reader = latestSubmittedInput("Profile key input is unavailable.");
    const retention = mutationRetentionDiagnostics(
      queryClient,
      observers,
      secret,
    );
    const replay = await replayRetainedMutation(queryClient, boundary, secret);
    const readRefused = submittedInputIsEmpty(
      reader,
      "Profile key input is unavailable.",
      secret,
    );
    expect({
      noHttpRequest: boundary.calls.length === 0,
      authorizationResult: latestMutationKind(queryClient) === "unauthorized",
      draftKept: inputMatches(secret),
      refusalVisible: screen.queryByText("Please sign in again.") !== null,
      submittedInputEmpty: readRefused,
      mutationStateSecretFree: !retention.mutationStateContainsSecret,
      observerOptionsSecretFree: !retention.observerOptionsContainSecret,
      hookResultSecretFree: !retention.hookResultContainsSecret,
      logsSecretFree: !containsSecret(consoleOutput, secret),
      replayRefused: replay.refused,
      replayReturnedUnauthorized: replay.returnedUnauthorized,
      replayErrorSecretFree: !replay.errorContainsSecret,
      replaySentNoRequest: replay.requestCountUnchanged,
    }).toEqual({
      noHttpRequest: true,
      authorizationResult: true,
      draftKept: true,
      refusalVisible: true,
      submittedInputEmpty: true,
      mutationStateSecretFree: true,
      observerOptionsSecretFree: true,
      hookResultSecretFree: true,
      logsSecretFree: true,
      replayRefused: false,
      replayReturnedUnauthorized: true,
      replayErrorSecretFree: true,
      replaySentNoRequest: true,
    });
    view.unmount();
    const postUnmountRetention = mutationRetentionDiagnostics(
      queryClient,
      observers,
      secret,
    );
    const postUnmountReplay = await replayRetainedMutation(
      queryClient,
      boundary,
      secret,
    );
    expect({
      submittedInputEmpty: submittedInputIsEmpty(
        reader,
        "Profile key input is unavailable.",
        secret,
      ),
      mutationStateSecretFree:
        !postUnmountRetention.mutationStateContainsSecret,
      observerOptionsSecretFree:
        !postUnmountRetention.observerOptionsContainSecret,
      hookResultSecretFree: !postUnmountRetention.hookResultContainsSecret,
      logsSecretFree: !containsSecret(consoleOutput, secret),
      replayRefused: postUnmountReplay.refused,
      replayReturnedUnauthorized: postUnmountReplay.returnedUnauthorized,
      replayErrorSecretFree: !postUnmountReplay.errorContainsSecret,
      replaySentNoRequest: postUnmountReplay.requestCountUnchanged,
    }).toEqual({
      submittedInputEmpty: true,
      mutationStateSecretFree: true,
      observerOptionsSecretFree: true,
      hookResultSecretFree: true,
      logsSecretFree: true,
      replayRefused: false,
      replayReturnedUnauthorized: true,
      replayErrorSecretFree: true,
      replaySentNoRequest: true,
    });
  });
});
