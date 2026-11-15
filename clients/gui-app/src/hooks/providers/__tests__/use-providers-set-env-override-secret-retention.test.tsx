import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { hostV115MutationV20Fixtures } from "@traycer/protocol/host/__tests__/__fixtures__/host-v1.1.5-mutation-v20";
import { providerMutationCliStateSchemaV21 } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { useProvidersSetEnvOverride } from "@/hooks/providers/use-providers-set-env-override-mutation";
import { useSubmittedSecretInput } from "@/hooks/use-submitted-secret-input";
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
} from "./secret-retention-test-support";

const FAKE_VALUE = "synthetic-provider-variable-value";
const UNAVAILABLE = "Provider variable input is unavailable.";
const active = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: (): HostClient<HostRpcRegistry> => {
      if (active.client === null)
        throw new Error("Provider variable test client is unavailable");
      return active.client;
    },
    useHostBinding: () => null,
  };
});

interface Row {
  readonly name: string;
  readonly fail: boolean;
}

const rows: readonly Row[] = [
  { name: "successful write", fail: false },
  { name: "refused write", fail: true },
];

const harnesses: SecretRetentionHarness[] = [];
const queryClients: QueryClient[] = [];

function wrapper(queryClient: QueryClient) {
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

afterEach(() => {
  cleanup();
  active.client = null;
  restoreConsoleCaptures();
  restoreMutationCacheObservers();
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
  for (const harness of harnesses.splice(0)) harness.client.dispose();
});

for (const row of rows) {
  it(`dispatches the variable and retains none after a ${row.name}`, async () => {
    const consoleCapture = captureConsoleOutput();
    const observation = {
      requestContainsValue: false,
      requestTargetMatches: false,
    };
    const state = providerMutationCliStateSchemaV21.parse({
      ...hostV115MutationV20Fixtures.minimalStatesByProviderId.codex,
      profiles: [],
    });
    const harness = createSecretRetentionHarness({
      "providers.setEnvOverride": (params) => {
        observation.requestContainsValue = params.value === FAKE_VALUE;
        observation.requestTargetMatches =
          params.providerId === "codex" &&
          params.key === "MODEL_PROVIDER_TOKEN" &&
          params.executableWriteGrant === null;
        observation.requestTargetMatches =
          observation.requestTargetMatches &&
          hasExactObjectKeys(params, [
            "providerId",
            "key",
            "value",
            "executableWriteGrant",
          ]);
        if (row.fail) throw new Error("Safe provider variable refusal");
        return { state };
      },
    });
    harnesses.push(harness);
    queryClients.push(harness.queryClient);
    active.client = harness.client.createRequester(mockLocalHostEntry);
    const observers: MutationObserverReference[] = [];
    captureMutationObservers(harness.queryClient, observers);

    const { result, unmount } = renderHook(
      () => {
        const submitted = useSubmittedSecretInput<string | null>(UNAVAILABLE);
        return {
          input: submitted,
          mutation: useProvidersSetEnvOverride(submitted.read, submitted.clear),
        };
      },
      { wrapper: wrapper(harness.queryClient) },
    );
    const variables = {
      providerId: "codex",
      key: "MODEL_PROVIDER_TOKEN",
      executableWriteGrant: null,
    } satisfies Omit<
      RequestOfMethod<HostRpcRegistry, "providers.setEnvOverride">,
      "value"
    >;
    let initialMutationRejected = false;
    let initialRejectionContainsValue = false;
    await act(async () => {
      result.current.input.set(FAKE_VALUE);
      try {
        await result.current.mutation.mutateAsync(variables);
      } catch (error) {
        initialMutationRejected = true;
        initialRejectionContainsValue = containsSyntheticInput(error, [
          FAKE_VALUE,
        ]);
        return;
      }
    });
    await waitFor(() =>
      expect(result.current.mutation.status).toBe(
        row.fail ? "error" : "success",
      ),
    );

    const mutation = harness.queryClient.getMutationCache().getAll().at(-1);
    if (mutation === undefined)
      throw new Error("Provider variable mutation was not retained");
    const mutationFn = mutation.options.mutationFn;
    if (mutationFn === undefined)
      throw new Error("Provider variable mutation has no function");
    const callsBeforeReplay = harness.messenger.calls.filter(
      (call) => call.method === "providers.setEnvOverride",
    ).length;
    let replayUnavailable = false;
    let replayContainsValue = false;
    try {
      await mutationFn(variables, {
        client: harness.queryClient,
        meta: mutation.options.meta,
        mutationKey: mutation.options.mutationKey ?? [],
      });
    } catch (error) {
      replayUnavailable =
        error instanceof Error && error.message === UNAVAILABLE;
      replayContainsValue = containsSyntheticInput(error, [FAKE_VALUE]);
    }
    const preUnmountStateContainsValue = mutationStateContainsSyntheticInput(
      harness.queryClient,
      observers,
      [FAKE_VALUE],
    );
    unmount();
    let helperUnavailable = false;
    try {
      result.current.input.read();
    } catch (error) {
      helperUnavailable =
        error instanceof Error && error.message === UNAVAILABLE;
    }
    expect({
      requestContainsValue: observation.requestContainsValue,
      requestTargetMatches: observation.requestTargetMatches,
      variablesContainOnlyTarget: hasExactObjectKeys(mutation.state.variables, [
        "providerId",
        "key",
        "executableWriteGrant",
      ]),
      mutationSettled:
        mutation.state.status === (row.fail ? "error" : "success"),
      initialMutationRejected,
      initialRejectionContainsValue,
      preUnmountStateContainsValue,
      logsContainValue: containsSyntheticInput(consoleCapture.output, [
        FAKE_VALUE,
      ]),
      resultContainsValue: containsSyntheticInput(result.current, [FAKE_VALUE]),
      replayUnavailable,
      replayContainsValue,
      replaySentNoRequest:
        harness.messenger.calls.filter(
          (call) => call.method === "providers.setEnvOverride",
        ).length === callsBeforeReplay,
      helperUnavailable,
      postUnmountStateContainsValue: mutationStateContainsSyntheticInput(
        harness.queryClient,
        observers,
        [FAKE_VALUE],
      ),
    }).toEqual({
      requestContainsValue: true,
      requestTargetMatches: true,
      variablesContainOnlyTarget: true,
      mutationSettled: true,
      initialMutationRejected: row.fail,
      initialRejectionContainsValue: false,
      preUnmountStateContainsValue: false,
      logsContainValue: false,
      resultContainsValue: false,
      replayUnavailable: true,
      replayContainsValue: false,
      replaySentNoRequest: true,
      helperUnavailable: true,
      postUnmountStateContainsValue: false,
    });
  });
}
