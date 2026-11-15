import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { hostV115MutationV20Fixtures } from "@traycer/protocol/host/__tests__/__fixtures__/host-v1.1.5-mutation-v20";
import { providerMutationCliStateSchemaV21 } from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import { ProviderEnvOverridesSection } from "@/components/settings/panels/provider-env-overrides-section";
import {
  captureConsoleOutput,
  captureMutationObservers,
  containsSyntheticInput,
  createSecretRetentionHarness,
  hasExactObjectKeys,
  mutationStateContainsSyntheticInput,
  restoreConsoleCaptures,
  restoreMutationCacheObservers,
  type MutationObserverReference,
  type SecretRetentionHarness,
} from "@/hooks/providers/__tests__/secret-retention-test-support";

const FAKE_VALUE = "synthetic-env-override-secret";
const UNAVAILABLE = "Provider variable input is unavailable.";
const HOST_ID = mockLocalHostEntry.hostId;
const providerInvalidationMethods = new Set<string>(PROVIDER_INVALIDATIONS);

const active = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
  readers: new Array<() => unknown>(),
  setRequestContainsValue: false,
  setRequestTargetMatches: false,
  setRequestShapeMatches: false,
  deleteRequestContainsValue: false,
  deleteRequestTargetMatches: false,
  deleteRequestShapeMatches: false,
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: (): HostClient<HostRpcRegistry> => {
      if (active.client === null)
        throw new Error("Environment override test client is unavailable");
      return active.client;
    },
    useHostBinding: () =>
      active.client === null ? null : { hostClient: active.client, auth: null },
  };
});
vi.mock("@/hooks/use-submitted-secret-input", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-submitted-secret-input")>();
  return {
    ...actual,
    useSubmittedSecretInput: <Value,>(message: string) => {
      const input = actual.useSubmittedSecretInput<Value>(message);
      active.readers.push(input.read);
      return input;
    },
  };
});
vi.mock(
  "@/components/settings/personal/personal-page-context",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/settings/personal/personal-page-context")
      >();
    return {
      ...actual,
      usePersonalPageHost: () => ({
        hostId: HOST_ID,
        client: active.client,
      }),
      usePersonalHostState: () => null,
      usePersonalHostName: () => null,
      usePersonalRowNotes: () => new Map(),
    };
  },
);
vi.mock(
  "@/stores/settings/settings-environment-pick-store",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/stores/settings/settings-environment-pick-store")
      >();
    return {
      ...actual,
      useEnvironmentPick: () => ({
        kind: "local",
        hostId: HOST_ID,
        hostName: "Test computer",
      }),
    };
  },
);
vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  () => ({
    useHostsRunningPersonal: () => ({
      hosts: [],
      state: "ready",
      thisComputerUnread: false,
      collisions: [],
      retry: () => undefined,
      reread: () => undefined,
    }),
  }),
);
vi.mock("@/components/settings/environment/use-configuration-key", () => ({
  useConfigurationKey: () => "configuration-test",
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/chats/use-cloud-chat-queries")
    >();
  return { ...actual, useCloudChatViewerId: () => "viewer-test" };
});
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => null,
}));
vi.mock("@/hooks/ui/use-small-viewport", () => ({
  useIsSmallViewport: () => false,
}));
vi.mock(
  "@/components/settings/environment/applied-provider-item-details",
  () => ({
    AppliedProviderItemDetails: () => null,
  }),
);

interface Row {
  readonly name: string;
  readonly failMethod:
    | "none"
    | "providers.setEnvOverride"
    | "providers.deleteEnvOverride";
  readonly expectedWriteCalls: number;
  readonly expectedDeleteCalls: number;
  readonly unmountWriteCalls: number;
  readonly unmountDeleteCalls: number;
}

interface DeferredOperation {
  callCount: number;
  readonly completions: Array<() => void>;
}

const rows: readonly Row[] = [
  {
    name: "the write and rename delete succeed",
    failMethod: "none",
    expectedWriteCalls: 1,
    expectedDeleteCalls: 1,
    unmountWriteCalls: 0,
    unmountDeleteCalls: 0,
  },
  {
    name: "the first write is refused",
    failMethod: "providers.setEnvOverride",
    expectedWriteCalls: 1,
    expectedDeleteCalls: 0,
    unmountWriteCalls: 1,
    unmountDeleteCalls: 0,
  },
  {
    name: "the later old-key delete is refused",
    failMethod: "providers.deleteEnvOverride",
    expectedWriteCalls: 1,
    expectedDeleteCalls: 1,
    unmountWriteCalls: 1,
    unmountDeleteCalls: 1,
  },
];

const harnesses: SecretRetentionHarness[] = [];
const queryClients: QueryClient[] = [];

function wrapper(queryClient: QueryClient, children: ReactNode): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function variableState() {
  return providerMutationCliStateSchemaV21.parse({
    ...hostV115MutationV20Fixtures.minimalStatesByProviderId.codex,
    profiles: [],
  });
}

function namedMutations(queryClient: QueryClient, method: string) {
  return queryClient
    .getMutationCache()
    .getAll()
    .filter((mutation) => mutation.options.mutationKey?.[0] === method);
}

function mutationVariablesMatch(args: {
  readonly queryClient: QueryClient;
  readonly method: string;
  readonly count: number;
  readonly keys: readonly string[];
}): boolean {
  const mutations = namedMutations(args.queryClient, args.method);
  return (
    mutations.length === args.count &&
    mutations.every((mutation) =>
      hasExactObjectKeys(mutation.state.variables, args.keys),
    )
  );
}

function requireValue<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) throw new Error(message);
  return value;
}

async function recordReplayOutcome(args: {
  readonly messenger: SecretRetentionHarness["messenger"];
  readonly invoke: () => Promise<unknown>;
}): Promise<{
  readonly unavailable: boolean;
  readonly containsValue: boolean;
  readonly sentNoWrite: boolean;
}> {
  const requestsBefore = args.messenger.calls.filter(
    (call) => call.method === "providers.setEnvOverride",
  ).length;
  let unavailable = false;
  let containsValue = false;
  try {
    await args.invoke();
  } catch (error) {
    unavailable = error instanceof Error && error.message === UNAVAILABLE;
    containsValue = containsSyntheticInput(error, [FAKE_VALUE]);
  }
  return {
    unavailable,
    containsValue,
    sentNoWrite:
      args.messenger.calls.filter(
        (call) => call.method === "providers.setEnvOverride",
      ).length === requestsBefore,
  };
}

async function waitForEditorOutcome(args: {
  readonly row: Row;
  readonly nameInput: HTMLInputElement;
  readonly valueInput: HTMLInputElement;
}): Promise<void> {
  if (args.row.failMethod === "none") {
    await waitFor(() => {
      expect(args.nameInput.value).toBe("MODEL_LABEL");
      expect(args.valueInput.value).toBe("existing label");
    });
    return;
  }
  await waitFor(() =>
    expect(
      screen
        .getAllByRole("alert")
        .some(
          (alert) => alert.textContent === "Safe provider variable refusal",
        ),
    ).toBe(true),
  );
}

function outerCommitMutation(queryClient: QueryClient) {
  return queryClient
    .getMutationCache()
    .getAll()
    .find((mutation) => {
      const variables = mutation.state.variables;
      return (
        typeof variables === "object" &&
        variables !== null &&
        Object.hasOwn(variables, "oldKey") &&
        Object.hasOwn(variables, "newKey")
      );
    });
}

function pendingMutationMethods(queryClient: QueryClient): string[] {
  return queryClient
    .getMutationCache()
    .getAll()
    .filter((mutation) => mutation.state.status === "pending")
    .map((mutation) => {
      const method = mutation.options.mutationKey?.[0];
      return typeof method === "string" ? method : "unkeyed";
    });
}

function fetchingQueryMethods(queryClient: QueryClient): string[] {
  return queryClient
    .getQueryCache()
    .getAll()
    .filter((query) => query.state.fetchStatus === "fetching")
    .map((query) => {
      const second = query.queryKey[1];
      const third = query.queryKey[2];
      if (typeof second === "string" && providerInvalidationMethods.has(second))
        return second;
      if (typeof third === "string" && providerInvalidationMethods.has(third))
        return third;
      return "other";
    });
}

interface RequestPhaseCounts {
  open: number;
  close: number;
}

function unfinishedRequestCounts(
  messenger: SecretRetentionHarness["messenger"],
): Array<{
  readonly method: string;
  readonly open: number;
  readonly close: number;
}> {
  const counts = new Map<string, RequestPhaseCounts>();
  for (const phase of messenger.phases) {
    if (phase.kind !== "open" && phase.kind !== "close") continue;
    const current = counts.get(phase.method) ?? { open: 0, close: 0 };
    counts.set(
      phase.method,
      phase.kind === "open"
        ? { open: current.open + 1, close: current.close }
        : { open: current.open, close: current.close + 1 },
    );
  }
  return [...counts.entries()]
    .filter(([, counts]) => counts.open !== counts.close)
    .map(([method, counts]) => ({
      method,
      open: counts.open,
      close: counts.close,
    }));
}

function helperIsUnavailable(reader: (() => unknown) | undefined): boolean {
  if (reader === undefined) return false;
  try {
    reader();
    return false;
  } catch (error) {
    return error instanceof Error && error.message === UNAVAILABLE;
  }
}

async function completeDeferredOperation(args: {
  readonly operation: DeferredOperation;
  readonly callIndex: number;
  readonly expectedCallCount: number;
  readonly missingMessage: string;
}): Promise<void> {
  await waitFor(() =>
    expect(args.operation.callCount).toBe(args.expectedCallCount),
  );
  const complete = args.operation.completions.at(args.callIndex);
  if (complete === undefined) throw new Error(args.missingMessage);
  act(() => complete());
}

function operationActivity(harness: SecretRetentionHarness) {
  return {
    activeMutations: harness.queryClient.isMutating(),
    pendingMutationMethods: pendingMutationMethods(harness.queryClient),
    activeQueries: harness.queryClient.isFetching(),
    fetchingQueryMethods: fetchingQueryMethods(harness.queryClient),
    unfinishedRequests: unfinishedRequestCounts(harness.messenger),
  };
}

async function settleUnmountAutosave(args: {
  readonly row: Row;
  readonly unmount: () => void;
  readonly harness: SecretRetentionHarness;
  readonly writes: DeferredOperation;
  readonly deletes: DeferredOperation;
  readonly writesBeforeUnmount: number;
  readonly deletesBeforeUnmount: number;
}): Promise<void> {
  args.unmount();

  if (args.row.unmountWriteCalls === 1) {
    await completeDeferredOperation({
      operation: args.writes,
      callIndex: args.writesBeforeUnmount,
      expectedCallCount: args.writesBeforeUnmount + args.row.unmountWriteCalls,
      missingMessage: "Provider variable unmount write was not prepared",
    });
  }

  if (args.row.unmountDeleteCalls === 1) {
    await completeDeferredOperation({
      operation: args.deletes,
      callIndex: args.deletesBeforeUnmount,
      expectedCallCount:
        args.deletesBeforeUnmount + args.row.unmountDeleteCalls,
      missingMessage: "Provider variable unmount delete was not prepared",
    });
  }

  await waitFor(() =>
    expect(operationActivity(args.harness)).toEqual({
      activeMutations: 0,
      pendingMutationMethods: [],
      activeQueries: 0,
      fetchingQueryMethods: [],
      unfinishedRequests: [],
    }),
  );
}

function postUnmountRetentionScan(args: {
  readonly row: Row;
  readonly harness: SecretRetentionHarness;
  readonly observers: readonly MutationObserverReference[];
  readonly consoleOutput: unknown[][];
  readonly submittedReader: (() => unknown) | undefined;
  readonly setRequestsBeforeUnmount: number;
  readonly deleteRequestsBeforeUnmount: number;
  readonly replayMutationCount: number;
}): {
  readonly stateContainsValue: boolean;
  readonly logsContainValue: boolean;
  readonly readerUnavailable: boolean;
  readonly setVariableShapesMatch: boolean;
  readonly deleteVariableShapesMatch: boolean;
  readonly requestCountsMatch: boolean;
  readonly requestTargetsMatch: boolean;
} {
  const expectedWriteCount =
    args.row.expectedWriteCalls + args.row.unmountWriteCalls;
  const expectedDeleteCount =
    args.row.expectedDeleteCalls + args.row.unmountDeleteCalls;
  const requestCountsMatch =
    args.harness.messenger.calls.filter(
      (call) => call.method === "providers.setEnvOverride",
    ).length ===
      args.setRequestsBeforeUnmount + args.row.unmountWriteCalls &&
    args.harness.messenger.calls.filter(
      (call) => call.method === "providers.deleteEnvOverride",
    ).length ===
      args.deleteRequestsBeforeUnmount + args.row.unmountDeleteCalls;
  const setRequestMatches =
    active.setRequestContainsValue &&
    active.setRequestTargetMatches &&
    active.setRequestShapeMatches;
  const deleteRequestMatches =
    expectedDeleteCount === 0 ||
    (active.deleteRequestTargetMatches && active.deleteRequestShapeMatches);

  return {
    stateContainsValue: mutationStateContainsSyntheticInput(
      args.harness.queryClient,
      args.observers,
      [FAKE_VALUE],
    ),
    logsContainValue: containsSyntheticInput(args.consoleOutput, [FAKE_VALUE]),
    readerUnavailable: helperIsUnavailable(args.submittedReader),
    setVariableShapesMatch: mutationVariablesMatch({
      queryClient: args.harness.queryClient,
      method: "providers.setEnvOverride",
      count: expectedWriteCount + args.replayMutationCount,
      keys: ["providerId", "key", "executableWriteGrant"],
    }),
    deleteVariableShapesMatch: mutationVariablesMatch({
      queryClient: args.harness.queryClient,
      method: "providers.deleteEnvOverride",
      count: expectedDeleteCount,
      keys: ["providerId", "key"],
    }),
    requestCountsMatch,
    requestTargetsMatch:
      setRequestMatches &&
      !active.deleteRequestContainsValue &&
      deleteRequestMatches,
  };
}

async function completeInitialOperations(args: {
  readonly row: Row;
  readonly writes: DeferredOperation;
  readonly deletes: DeferredOperation;
}): Promise<void> {
  await completeDeferredOperation({
    operation: args.writes,
    callIndex: 0,
    expectedCallCount: args.row.expectedWriteCalls,
    missingMessage: "Provider variable write was not prepared",
  });
  if (args.row.expectedDeleteCalls === 1) {
    await completeDeferredOperation({
      operation: args.deletes,
      callIndex: 0,
      expectedCallCount: args.row.expectedDeleteCalls,
      missingMessage: "Provider variable delete was not prepared",
    });
  }
}

afterEach(() => {
  cleanup();
  active.client = null;
  active.readers.length = 0;
  active.setRequestContainsValue = false;
  active.setRequestTargetMatches = false;
  active.setRequestShapeMatches = false;
  active.deleteRequestContainsValue = false;
  active.deleteRequestTargetMatches = false;
  active.deleteRequestShapeMatches = false;
  restoreConsoleCaptures();
  restoreMutationCacheObservers();
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
  for (const harness of harnesses.splice(0)) harness.client.dispose();
});

for (const row of rows) {
  it(`retains no submitted value when ${row.name}`, async () => {
    const consoleCapture = captureConsoleOutput();
    const writes: DeferredOperation = { callCount: 0, completions: [] };
    const deletes: DeferredOperation = { callCount: 0, completions: [] };
    const state = variableState();
    const harness = createSecretRetentionHarness({
      "providers.setEnvOverride": (params) => {
        writes.callCount += 1;
        active.setRequestContainsValue = params.value === FAKE_VALUE;
        active.setRequestTargetMatches =
          params.providerId === "codex" &&
          params.key === "MODEL_LABEL_NEXT" &&
          params.executableWriteGrant === null;
        active.setRequestShapeMatches = hasExactObjectKeys(params, [
          "providerId",
          "key",
          "value",
          "executableWriteGrant",
        ]);
        return new Promise((resolve, reject) => {
          writes.completions.push(() => {
            if (row.failMethod === "providers.setEnvOverride") {
              reject(new Error("Safe provider variable refusal"));
              return;
            }
            resolve({ state });
          });
        });
      },
      "providers.deleteEnvOverride": (params) => {
        deletes.callCount += 1;
        active.deleteRequestContainsValue = Object.values(params).some(
          (value) => typeof value === "string" && value === FAKE_VALUE,
        );
        active.deleteRequestTargetMatches =
          params.providerId === "codex" && params.key === "MODEL_LABEL";
        active.deleteRequestShapeMatches = hasExactObjectKeys(params, [
          "providerId",
          "key",
        ]);
        return new Promise((resolve, reject) => {
          deletes.completions.push(() => {
            if (row.failMethod === "providers.deleteEnvOverride") {
              reject(new Error("Safe provider variable refusal"));
              return;
            }
            resolve({ state });
          });
        });
      },
    });
    harnesses.push(harness);
    queryClients.push(harness.queryClient);
    active.client = harness.client.createRequester(mockLocalHostEntry);
    const observers: MutationObserverReference[] = [];
    captureMutationObservers(harness.queryClient, observers);

    const view = render(
      wrapper(
        harness.queryClient,
        <ProviderEnvOverridesSection
          providerId="codex"
          overrides={[{ key: "MODEL_LABEL", value: "existing label" }]}
          envOverrideScope={
            DEFAULT_PROVIDER_NATIVE_CAPABILITIES.envOverrideScope
          }
        />,
      ),
    );
    const nameInput = screen.getByLabelText<HTMLInputElement>(
      "Name for MODEL_LABEL",
    );
    const valueInput = screen.getByLabelText<HTMLInputElement>(
      "Value for MODEL_LABEL",
    );
    fireEvent.change(nameInput, { target: { value: "MODEL_LABEL_NEXT" } });
    fireEvent.change(valueInput, { target: { value: FAKE_VALUE } });
    fireEvent.blur(valueInput);

    const submittedReader = active.readers.at(0);
    await completeInitialOperations({ row, writes, deletes });

    const commit = requireValue(
      outerCommitMutation(harness.queryClient),
      "Provider variable commit mutation was not retained",
    );
    await waitFor(() =>
      expect(commit.state.status).toBe(
        row.failMethod === "none" ? "success" : "error",
      ),
    );
    const replay = await recordReplayOutcome({
      messenger: harness.messenger,
      invoke: async () => {
        const outerFunction = requireValue(
          commit.options.mutationFn,
          "Provider variable commit has no function",
        );
        return outerFunction(
          { oldKey: "MODEL_LABEL", newKey: "MODEL_LABEL_NEXT" },
          {
            client: harness.queryClient,
            meta: commit.options.meta,
            mutationKey: commit.options.mutationKey ?? [],
          },
        );
      },
    });
    expect(operationActivity(harness)).toEqual({
      activeMutations: 0,
      pendingMutationMethods: [],
      activeQueries: 0,
      fetchingQueryMethods: [],
      unfinishedRequests: [],
    });
    const readerUnavailable = helperIsUnavailable(submittedReader);
    const replayMutationCount = 1;
    const setVariablesMatch = mutationVariablesMatch({
      queryClient: harness.queryClient,
      method: "providers.setEnvOverride",
      count: row.expectedWriteCalls + replayMutationCount,
      keys: ["providerId", "key", "executableWriteGrant"],
    });
    const deleteVariablesMatch = mutationVariablesMatch({
      queryClient: harness.queryClient,
      method: "providers.deleteEnvOverride",
      count: row.expectedDeleteCalls,
      keys: ["providerId", "key"],
    });
    expect({
      setRequestContainsValue: active.setRequestContainsValue,
      setRequestTargetMatches: active.setRequestTargetMatches,
      setRequestShapeMatches: active.setRequestShapeMatches,
      deleteRequestContainsValue: active.deleteRequestContainsValue,
      deleteRequestTargetMatches: active.deleteRequestTargetMatches,
      deleteRequestShapeMatches: active.deleteRequestShapeMatches,
      observedWriteCount: writes.callCount,
      observedDeleteCount: deletes.callCount,
      setVariablesMatch,
      deleteVariablesMatch,
      outerVariablesMatch: hasExactObjectKeys(commit.state.variables, [
        "oldKey",
        "newKey",
      ]),
      expectedWriteCount: row.expectedWriteCalls,
      expectedDeleteCount: row.expectedDeleteCalls,
      retainedStateContainsValue: mutationStateContainsSyntheticInput(
        harness.queryClient,
        observers,
        [FAKE_VALUE],
      ),
      logsContainValue: containsSyntheticInput(consoleCapture.output, [
        FAKE_VALUE,
      ]),
      replayUnavailable: replay.unavailable,
      replayContainsValue: replay.containsValue,
      replaySentNoWrite: replay.sentNoWrite,
      readerUnavailable,
    }).toEqual({
      setRequestContainsValue: true,
      setRequestTargetMatches: true,
      setRequestShapeMatches: true,
      deleteRequestContainsValue: false,
      deleteRequestTargetMatches: row.expectedDeleteCalls === 1,
      deleteRequestShapeMatches: row.expectedDeleteCalls === 1,
      observedWriteCount: row.expectedWriteCalls,
      observedDeleteCount: row.expectedDeleteCalls,
      setVariablesMatch: true,
      deleteVariablesMatch: true,
      outerVariablesMatch: true,
      expectedWriteCount: row.expectedWriteCalls,
      expectedDeleteCount: row.expectedDeleteCalls,
      retainedStateContainsValue: false,
      logsContainValue: false,
      replayUnavailable: true,
      replayContainsValue: false,
      replaySentNoWrite: true,
      readerUnavailable: true,
    });

    await waitForEditorOutcome({ row, nameInput, valueInput });

    const writesBeforeUnmount = writes.callCount;
    const deletesBeforeUnmount = deletes.callCount;
    const setRequestsBeforeUnmount = harness.messenger.calls.filter(
      (call) => call.method === "providers.setEnvOverride",
    ).length;
    const deleteRequestsBeforeUnmount = harness.messenger.calls.filter(
      (call) => call.method === "providers.deleteEnvOverride",
    ).length;

    await settleUnmountAutosave({
      row,
      unmount: () => view.unmount(),
      harness,
      writes,
      deletes,
      writesBeforeUnmount,
      deletesBeforeUnmount,
    });

    const postUnmountRetention = postUnmountRetentionScan({
      row,
      harness,
      observers,
      consoleOutput: consoleCapture.output,
      submittedReader,
      setRequestsBeforeUnmount,
      deleteRequestsBeforeUnmount,
      replayMutationCount,
    });
    expect(postUnmountRetention).toEqual({
      stateContainsValue: false,
      logsContainValue: false,
      readerUnavailable: true,
      setVariableShapesMatch: true,
      deleteVariableShapesMatch: true,
      requestCountsMatch: true,
      requestTargetsMatch: true,
    });
    expect({
      unmountWriteCalls: writes.callCount - writesBeforeUnmount,
      unmountDeleteCalls: deletes.callCount - deletesBeforeUnmount,
      writesBeforeUnmount,
      deletesBeforeUnmount,
      expectedUnmountWriteCalls: row.unmountWriteCalls,
      expectedUnmountDeleteCalls: row.unmountDeleteCalls,
      replaySentNoWrite: replay.sentNoWrite,
      unmountRequestMethods: {
        set: harness.messenger.calls.filter(
          (call) => call.method === "providers.setEnvOverride",
        ).length,
        delete: harness.messenger.calls.filter(
          (call) => call.method === "providers.deleteEnvOverride",
        ).length,
      },
    }).toEqual({
      unmountWriteCalls: row.unmountWriteCalls,
      unmountDeleteCalls: row.unmountDeleteCalls,
      writesBeforeUnmount: row.expectedWriteCalls,
      deletesBeforeUnmount: row.expectedDeleteCalls,
      expectedUnmountWriteCalls: row.unmountWriteCalls,
      expectedUnmountDeleteCalls: row.unmountDeleteCalls,
      replaySentNoWrite: true,
      unmountRequestMethods: {
        set: setRequestsBeforeUnmount + row.unmountWriteCalls,
        delete: deleteRequestsBeforeUnmount + row.unmountDeleteCalls,
      },
    });
  });
}
