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
import type { ModelProviderEntry } from "@traycer/protocol/host/provider-native-schemas";
import type {
  ProvidersModelProviderAuthRequest,
  ProvidersModelProviderAuthResponse,
} from "@traycer/protocol/host/provider-schemas";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  MockHostMessenger,
  type MockHandlerMap,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { ProviderModelProvidersTab } from "../provider-model-providers-tab";
import { entry } from "./provider-model-providers-tab-test-support";
import { createAppQueryClient } from "@/lib/query-client";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { useModelProviderPendingAuthStore } from "@/stores/settings/model-provider-pending-auth-store";

const submittedInputs = vi.hoisted(() => ({
  records: [] as Array<{
    readonly message: string;
    readonly read: () => unknown;
    readonly clear: () => void;
  }>,
}));

const clientHolder = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
  setShown: vi.fn(),
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: (): HostClient<HostRpcRegistry> => {
      if (clientHolder.client === null)
        throw new Error("Custom provider test client is unavailable");
      return clientHolder.client;
    },
  };
});

vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return { ...actual, useHostBinding: () => null };
});

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => mockLocalHostEntry.hostId,
}));

vi.mock("@/hooks/host/use-host-credential-refusal", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-credential-refusal")
    >();
  return { ...actual, useHostCredentialRefusal: () => null };
});

vi.mock(
  "@/hooks/providers/use-model-provider-visibility",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/providers/use-model-provider-visibility")
      >();
    return {
      ...actual,
      useModelProviderVisibility: () => ({
        supported: false,
        isShown: () => true,
        isSettling: () => false,
        setShown: clientHolder.setShown,
      }),
    };
  },
);

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

interface MutationObserverReference {
  readonly options: unknown;
  readonly getCurrentResult: () => unknown;
}

interface SubmittedInputReference {
  readonly read: () => unknown;
}

interface DeferredAuthResult {
  readonly promise: Promise<ProvidersModelProviderAuthResponse>;
  readonly resolve: () => void;
}

interface RetentionDiagnostics {
  readonly mutationStateContainsSecret: boolean;
  readonly observerOptionsContainSecret: boolean;
  readonly hookResultContainsSecret: boolean;
}

interface AuthObservations {
  keyPresent: boolean;
  headerPresent: boolean;
  reenableHasNoCredential: boolean;
}

interface ReplayDiagnostics {
  readonly refused: boolean;
  readonly errorContainsSecret: boolean;
  readonly requestCountUnchanged: boolean;
}

function createDeferredAuthResult(detail: string): DeferredAuthResult {
  const deferred = { resolve: null as (() => void) | null };
  const promise = new Promise<ProvidersModelProviderAuthResponse>((resolve) => {
    deferred.resolve = () =>
      resolve({
        result: { kind: "error", code: "invalid_input", detail },
      });
  });
  return {
    promise,
    resolve: () => {
      const resolve = deferred.resolve;
      if (resolve === null)
        throw new Error("Deferred auth result was not initialized");
      resolve();
    },
  };
}

function containsSecret(value: unknown, secrets: readonly string[]): boolean {
  const seen = new WeakSet<object>();
  function contains(current: unknown): boolean {
    if (typeof current === "string")
      return secrets.some((secret) => current.includes(secret));
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
      (secrets.some((secret) => current.message.includes(secret)) ||
        contains(current.cause))
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

function retentionDiagnostics(
  queryClient: QueryClient,
  observers: readonly MutationObserverReference[],
  secrets: readonly string[],
): RetentionDiagnostics {
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
        secrets,
      ),
    ),
    observerOptionsContainSecret: observers.some((observer) =>
      containsSecret(observer.options, secrets),
    ),
    hookResultContainsSecret: observers.some((observer) =>
      containsSecret(observer.getCurrentResult(), secrets),
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
  secrets: readonly string[],
): boolean {
  try {
    input.read();
  } catch (error) {
    return (
      error instanceof Error &&
      error.message === message &&
      !containsSecret(error, secrets)
    );
  }
  return false;
}

async function replayRetainedMutation(
  queryClient: QueryClient,
  requestCount: () => number,
  secrets: readonly string[],
): Promise<ReplayDiagnostics> {
  const mutation = latestMutation(queryClient);
  const mutationFn = mutation.options.mutationFn;
  if (mutationFn === undefined)
    throw new Error("Retained mutation has no mutation function");
  const countBeforeReplay = requestCount();
  try {
    await mutationFn(
      {
        providerId: "opencode",
        action: {
          action: "createCustom",
          modelProviderId: "retention-gateway",
        },
      },
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
        error.message === "Model provider input is unavailable.",
      errorContainsSecret: containsSecret(error, secrets),
      requestCountUnchanged: requestCount() === countBeforeReplay,
    };
  }
  return {
    refused: false,
    errorContainsSecret: false,
    requestCountUnchanged: requestCount() === countBeforeReplay,
  };
}

function withAppQueryClient(queryClient: QueryClient) {
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
  consoleSpyRestorers.push(
    () => debug.mockRestore(),
    () => info.mockRestore(),
    () => log.mockRestore(),
    () => warn.mockRestore(),
    () => error.mockRestore(),
  );
  return output;
}

function hasInputValue(label: string, value: string): boolean {
  const input = screen.queryByLabelText(label);
  return input instanceof HTMLInputElement && input.value === value;
}

function firstInputHasValue(label: string, value: string): boolean {
  const input = screen.queryAllByLabelText(label)[0];
  return input instanceof HTMLInputElement && input.value === value;
}

function renderProviderTab(queryClient: QueryClient) {
  return renderProviderTabWith(queryClient, ["createCustom"]);
}

function renderProviderTabWith(
  queryClient: QueryClient,
  actions: readonly ("createCustom" | "updateCustom")[],
) {
  return render(
    <ProviderModelProvidersTab
      providerId="opencode"
      providerLabel="OpenCode"
      capabilities={{ actions: [...actions] }}
      packPreparing={null}
      hiddenModelProviders={undefined}
    />,
    {
      wrapper: withAppQueryClient(queryClient),
    },
  );
}

function requestCount(messenger: MockHostMessenger<HostRpcRegistry>): number {
  return messenger.calls.filter(
    (call) => call.method === "providers.modelProviderAuth",
  ).length;
}

function makeHandlers(args: {
  readonly response: () => Promise<ProvidersModelProviderAuthResponse>;
  readonly observations: AuthObservations;
  readonly key: string;
  readonly header: string;
  readonly provider: ModelProviderEntry;
}): MockHandlerMap<HostRpcRegistry> {
  return {
    "providers.listModelProviders": () => ({
      result: { ok: true as const, providers: [args.provider] },
    }),
    "providers.modelProviderAuth": (
      params: ProvidersModelProviderAuthRequest,
    ) => {
      if (params.action.action === "createCustom") {
        args.observations.keyPresent = params.action.key === args.key;
        args.observations.headerPresent = params.action.headers.some(
          (item) => item.value === args.header,
        );
      } else if (params.action.action === "updateCustom") {
        args.observations.reenableHasNoCredential =
          params.action.key === null && params.action.env === null;
      }
      return args.response();
    },
  };
}

interface ModelProviderRpcHarness {
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
}

function createModelProviderRpcHarness(
  queryClient: QueryClient,
  handlers: MockHandlerMap<HostRpcRegistry>,
): ModelProviderRpcHarness {
  const requestIds = { next: 0 };
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => {
      requestIds.next += 1;
      return `req-custom-provider-${String(requestIds.next)}`;
    },
    handlers,
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
  });
  clients.push(client);
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "synthetic-model-session",
    }),
  );
  clientHolder.client = client.createRequester(mockLocalHostEntry);
  return { messenger };
}

const mutationCacheUnsubscribers: Array<() => void> = [];
const consoleSpyRestorers: Array<() => void> = [];
const queryClients: QueryClient[] = [];
const clients: HostClient<HostRpcRegistry>[] = [];

beforeEach(() => {
  submittedInputs.records.length = 0;
  useModelProviderPendingAuthStore.setState({ entries: {} });
});

afterEach(() => {
  cleanup();
  clientHolder.client = null;
  for (const unsubscribe of mutationCacheUnsubscribers.splice(0)) unsubscribe();
  for (const restore of consoleSpyRestorers.splice(0)) restore();
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
  for (const client of clients.splice(0)) client.dispose();
  submittedInputs.records.length = 0;
});

function fillCustomProviderForm(key: string, header: string): void {
  fireEvent.click(screen.getByRole("button", { name: "Add custom provider" }));
  fireEvent.change(screen.getByLabelText("Display name"), {
    target: { value: "Retention gateway" },
  });
  fireEvent.change(screen.getByLabelText("Base URL"), {
    target: { value: "https://api.example.test/v1" },
  });
  fireEvent.change(screen.getByLabelText("API key"), {
    target: { value: key },
  });
  fireEvent.change(screen.getAllByLabelText("ID")[0], {
    target: { value: "model-a" },
  });
  fireEvent.change(screen.getAllByLabelText("Name")[0], {
    target: { value: "Model A" },
  });
  fireEvent.change(screen.getByLabelText("Header"), {
    target: { value: "Authorization" },
  });
  fireEvent.change(screen.getByLabelText("Value"), {
    target: { value: header },
  });
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
}

describe("custom provider form submitted inputs", () => {
  it.each([
    { settles: "successfully" as const, fail: false },
    { settles: "with a typed refusal" as const, fail: true },
  ])(
    "releases key and header snapshots after the real provider RPC settles $settles",
    async ({ fail }) => {
      const key = "synthetic-custom-provider-key";
      const header = "synthetic-custom-provider-header";
      const observations: AuthObservations = {
        keyPresent: false,
        headerPresent: false,
        reenableHasNoCredential: false,
      };
      const failResponse = {
        result: {
          kind: "error" as const,
          code: "invalid_input" as const,
          detail: "The host refused these custom provider details.",
        },
      };
      const successResponse = { result: { kind: "done" as const } };
      const queryClient = createAppQueryClient();
      queryClients.push(queryClient);
      const rpc = createModelProviderRpcHarness(
        queryClient,
        makeHandlers({
          response: () =>
            Promise.resolve(fail ? failResponse : successResponse),
          observations,
          key,
          header,
          provider: entry({}),
        }),
      );
      const observers = captureMutationObservers(queryClient);
      const consoleOutput = captureConsoleOutput();
      const view = renderProviderTab(queryClient);
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Add custom provider" }),
        ).toBeTruthy(),
      );
      fillCustomProviderForm(key, header);
      await waitFor(() => expect(requestCount(rpc.messenger)).toBe(1));
      await waitFor(() =>
        expect(latestMutation(queryClient).state.status).toBe("success"),
      );
      await waitFor(() => {
        if (fail) expect(screen.getByRole("alert")).toBeTruthy();
        else expect(screen.queryByRole("dialog")).toBeNull();
      });
      const inputSnapshotSpent = inputUnavailableWithoutSecret(
        readerFor("Custom provider draft input is unavailable."),
        "Custom provider draft input is unavailable.",
        [key, header],
      );
      const actionSnapshotSpent = inputUnavailableWithoutSecret(
        readerFor("Model provider input is unavailable."),
        "Model provider input is unavailable.",
        [key, header],
      );
      const retained = retentionDiagnostics(queryClient, observers, [
        key,
        header,
      ]);
      const replay = await replayRetainedMutation(
        queryClient,
        () => requestCount(rpc.messenger),
        [key, header],
      );
      expect({
        keySent: observations.keyPresent,
        headerSent: observations.headerPresent,
        mutationSucceeded:
          latestMutation(queryClient).state.status === "success",
        dialogOpen: screen.queryByRole("dialog") !== null,
        typedRefusalVisible: screen.queryByRole("alert") !== null,
        keyDraftPreserved: fail && hasInputValue("API key", key),
        displayNameDraftPreserved:
          fail && hasInputValue("Display name", "Retention gateway"),
        baseUrlDraftPreserved:
          fail && hasInputValue("Base URL", "https://api.example.test/v1"),
        modelIdDraftPreserved: fail && firstInputHasValue("ID", "model-a"),
        modelNameDraftPreserved: fail && firstInputHasValue("Name", "Model A"),
        headerNameDraftPreserved:
          fail && hasInputValue("Header", "Authorization"),
        headerDraftPreserved: fail && hasInputValue("Value", header),
        mutationStateSecretFree: !retained.mutationStateContainsSecret,
        observerOptionsSecretFree: !retained.observerOptionsContainSecret,
        hookResultSecretFree: !retained.hookResultContainsSecret,
        logsSecretFree: !containsSecret(consoleOutput, [key, header]),
        inputSnapshotSpent,
        actionSnapshotSpent,
        replayRefused: replay.refused,
        replayErrorSecretFree: !replay.errorContainsSecret,
        replaySentNoRequest: replay.requestCountUnchanged,
      }).toEqual({
        keySent: true,
        headerSent: true,
        mutationSucceeded: true,
        dialogOpen: fail,
        typedRefusalVisible: fail,
        keyDraftPreserved: fail,
        displayNameDraftPreserved: fail,
        baseUrlDraftPreserved: fail,
        modelIdDraftPreserved: fail,
        modelNameDraftPreserved: fail,
        headerNameDraftPreserved: fail,
        headerDraftPreserved: fail,
        mutationStateSecretFree: true,
        observerOptionsSecretFree: true,
        hookResultSecretFree: true,
        logsSecretFree: true,
        inputSnapshotSpent: true,
        actionSnapshotSpent: true,
        replayRefused: true,
        replayErrorSecretFree: true,
        replaySentNoRequest: true,
      });
      view.unmount();
      const postUnmountRetention = retentionDiagnostics(
        queryClient,
        observers,
        [key, header],
      );
      const inputEmptyAfterUnmount = inputUnavailableWithoutSecret(
        readerFor("Custom provider draft input is unavailable."),
        "Custom provider draft input is unavailable.",
        [key, header],
      );
      const actionEmptyAfterUnmount = inputUnavailableWithoutSecret(
        readerFor("Model provider input is unavailable."),
        "Model provider input is unavailable.",
        [key, header],
      );
      expect({
        inputEmptyAfterUnmount,
        actionEmptyAfterUnmount,
        mutationStateSecretFree:
          !postUnmountRetention.mutationStateContainsSecret,
        observerOptionsSecretFree:
          !postUnmountRetention.observerOptionsContainSecret,
        hookResultSecretFree: !postUnmountRetention.hookResultContainsSecret,
        logsSecretFree: !containsSecret(consoleOutput, [key, header]),
      }).toEqual({
        inputEmptyAfterUnmount: true,
        actionEmptyAfterUnmount: true,
        mutationStateSecretFree: true,
        observerOptionsSecretFree: true,
        hookResultSecretFree: true,
        logsSecretFree: true,
      });
    },
  );

  it("opens a blank key field when bare re-enable is refused", async () => {
    const observations: AuthObservations = {
      keyPresent: false,
      headerPresent: false,
      reenableHasNoCredential: false,
    };
    const disabledProvider = entry({
      id: "retention-gateway",
      name: "Retention gateway",
      source: "config",
      canDisconnect: true,
      configDeclaredCustom: true,
      custom: {
        baseUrl: "https://api.example.test/v1",
        models: [{ id: "model-a", name: "Model A" }],
        headers: [],
        env: [],
      },
    });
    const queryClient = createAppQueryClient();
    queryClients.push(queryClient);
    const rpc = createModelProviderRpcHarness(
      queryClient,
      makeHandlers({
        response: () =>
          Promise.resolve({
            result: {
              kind: "error" as const,
              code: "invalid_input" as const,
              detail: "The host refused these custom provider details.",
            },
          }),
        observations,
        key: "unavailable-stored-key",
        header: "unavailable-stored-header",
        provider: disabledProvider,
      }),
    );
    const view = renderProviderTabWith(queryClient, ["updateCustom"]);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Re-enable Retention gateway" }),
      ).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Re-enable Retention gateway" }),
    );
    await waitFor(() => expect(requestCount(rpc.messenger)).toBe(1));
    await waitFor(() =>
      expect(latestMutation(queryClient).state.status).toBe("success"),
    );
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect({
      reenableSentNoCredential: observations.reenableHasNoCredential,
      editorOpened: screen.queryByRole("dialog") !== null,
      keyBlank: hasInputValue("API key", ""),
      baseUrlPreserved: hasInputValue(
        "Base URL",
        "https://api.example.test/v1",
      ),
      modelIdPreserved: firstInputHasValue("ID", "model-a"),
      modelNamePreserved: firstInputHasValue("Name", "Model A"),
      refusalVisible: screen.queryByRole("alert") !== null,
    }).toEqual({
      reenableSentNoCredential: true,
      editorOpened: true,
      keyBlank: true,
      baseUrlPreserved: true,
      modelIdPreserved: true,
      modelNamePreserved: true,
      refusalVisible: true,
    });
    view.unmount();
  });

  it("clears both submitted snapshots when the custom form unmounts in flight", async () => {
    const key = "synthetic-unmounted-custom-provider-key";
    const header = "synthetic-unmounted-custom-provider-header";
    const observations: AuthObservations = {
      keyPresent: false,
      headerPresent: false,
      reenableHasNoCredential: false,
    };
    const deferred = createDeferredAuthResult(
      "The host refused these custom provider details.",
    );
    const queryClient = createAppQueryClient();
    queryClients.push(queryClient);
    const rpc = createModelProviderRpcHarness(
      queryClient,
      makeHandlers({
        response: () => deferred.promise,
        observations,
        key,
        header,
        provider: entry({}),
      }),
    );
    const observers = captureMutationObservers(queryClient);
    const consoleOutput = captureConsoleOutput();
    const view = renderProviderTab(queryClient);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Add custom provider" }),
      ).toBeTruthy(),
    );
    fillCustomProviderForm(key, header);
    await waitFor(() => expect(requestCount(rpc.messenger)).toBe(1));
    const inputSnapshot = readerFor(
      "Custom provider draft input is unavailable.",
    );
    const actionSnapshot = readerFor("Model provider input is unavailable.");
    view.unmount();
    const inputSnapshotCleared = inputUnavailableWithoutSecret(
      inputSnapshot,
      "Custom provider draft input is unavailable.",
      [key, header],
    );
    const actionSnapshotCleared = inputUnavailableWithoutSecret(
      actionSnapshot,
      "Model provider input is unavailable.",
      [key, header],
    );
    deferred.resolve();
    await waitFor(() =>
      expect(latestMutation(queryClient).state.status).toBe("success"),
    );
    const retained = retentionDiagnostics(queryClient, observers, [
      key,
      header,
    ]);
    const replay = await replayRetainedMutation(
      queryClient,
      () => requestCount(rpc.messenger),
      [key, header],
    );
    expect({
      keySent: observations.keyPresent,
      headerSent: observations.headerPresent,
      inputSnapshotCleared,
      actionSnapshotCleared,
      mutationStateSecretFree: !retained.mutationStateContainsSecret,
      observerOptionsSecretFree: !retained.observerOptionsContainSecret,
      hookResultSecretFree: !retained.hookResultContainsSecret,
      logsSecretFree: !containsSecret(consoleOutput, [key, header]),
      replayRefused: replay.refused,
      replayErrorSecretFree: !replay.errorContainsSecret,
      replaySentNoRequest: replay.requestCountUnchanged,
    }).toEqual({
      keySent: true,
      headerSent: true,
      inputSnapshotCleared: true,
      actionSnapshotCleared: true,
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
