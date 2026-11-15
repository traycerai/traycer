import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { HostRpcRegistry } from "@/lib/host";
import {
  useProvidersSubmitLoginCode,
  useProvidersSubmitLoginCodeForClient,
} from "@/hooks/providers/use-providers-submit-login-code-mutation";
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

const FAKE_CODE = "synthetic-provider-login-code";
const UNAVAILABLE = "Provider login code input is unavailable.";
const active = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: (): HostClient<HostRpcRegistry> => {
      if (active.client === null)
        throw new Error("Login code test client is unavailable");
      return active.client;
    },
  };
});

interface Row {
  readonly name: string;
  readonly fail: boolean;
}

const rows: readonly Row[] = [
  { name: "successful transport", fail: false },
  { name: "refused transport", fail: true },
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
  it(`submits the login code at dispatch and retains none after ${row.name}`, async () => {
    const consoleCapture = captureConsoleOutput();
    const observation = {
      requestContainsCode: false,
      requestScopeMatches: false,
    };
    const harness = createSecretRetentionHarness({
      "providers.submitLoginCode": (params) => {
        observation.requestContainsCode = params.code === FAKE_CODE;
        observation.requestScopeMatches =
          params.providerId === "opencode" &&
          params.profileId === "profile-secret-retention";
        observation.requestScopeMatches =
          observation.requestScopeMatches &&
          hasExactObjectKeys(params, ["providerId", "profileId", "code"]);
        if (row.fail) throw new Error("Safe login submission refusal");
        return { outcome: "accepted" };
      },
    });
    harnesses.push(harness);
    queryClients.push(harness.queryClient);
    active.client = harness.client.createRequester(mockLocalHostEntry);
    const observers: MutationObserverReference[] = [];
    captureMutationObservers(harness.queryClient, observers);

    const { result, unmount } = renderHook(
      () => {
        const submitted = useSubmittedSecretInput<string>(UNAVAILABLE);
        return {
          input: submitted,
          mutation: useProvidersSubmitLoginCode(
            submitted.read,
            submitted.clear,
          ),
        };
      },
      { wrapper: wrapper(harness.queryClient) },
    );
    let initialMutationRejected = false;
    let initialRejectionContainsCode = false;
    await act(async () => {
      result.current.input.set(FAKE_CODE);
      try {
        await result.current.mutation.mutateAsync({
          providerId: "opencode",
          profileId: "profile-secret-retention",
        });
      } catch (error) {
        initialMutationRejected = true;
        initialRejectionContainsCode = containsSyntheticInput(error, [
          FAKE_CODE,
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
      throw new Error("Login code mutation was not retained");
    const mutationFn = mutation.options.mutationFn;
    if (mutationFn === undefined)
      throw new Error("Login code mutation has no function");
    const callsBeforeReplay = harness.messenger.calls.length;
    let replayUnavailable = false;
    let replayContainsCode = false;
    try {
      await mutationFn(
        { providerId: "opencode", profileId: "profile-secret-retention" },
        {
          client: harness.queryClient,
          meta: mutation.options.meta,
          mutationKey: mutation.options.mutationKey ?? [],
        },
      );
    } catch (error) {
      replayUnavailable =
        error instanceof Error && error.message === UNAVAILABLE;
      replayContainsCode = containsSyntheticInput(error, [FAKE_CODE]);
    }
    const preUnmountCacheContainsCode = mutationStateContainsSyntheticInput(
      harness.queryClient,
      observers,
      [FAKE_CODE],
    );
    unmount();
    const postUnmountCacheContainsCode = mutationStateContainsSyntheticInput(
      harness.queryClient,
      observers,
      [FAKE_CODE],
    );
    let helperUnavailable = false;
    try {
      result.current.input.read();
    } catch (error) {
      helperUnavailable =
        error instanceof Error && error.message === UNAVAILABLE;
    }
    expect({
      requestContainsCode: observation.requestContainsCode,
      requestScopeMatches: observation.requestScopeMatches,
      variablesContainOnlyTarget: hasExactObjectKeys(mutation.state.variables, [
        "providerId",
        "profileId",
      ]),
      mutationHasTerminalState:
        mutation.state.status === (row.fail ? "error" : "success"),
      initialMutationRejected,
      initialRejectionContainsCode,
      preUnmountCacheContainsCode,
      logsContainCode: containsSyntheticInput(consoleCapture.output, [
        FAKE_CODE,
      ]),
      resultContainsCode: containsSyntheticInput(result.current, [FAKE_CODE]),
      replayUnavailable,
      replayContainsCode,
      replaySentNoRequest: harness.messenger.calls.length === callsBeforeReplay,
      helperUnavailable,
      postUnmountCacheContainsCode,
    }).toEqual({
      requestContainsCode: true,
      requestScopeMatches: true,
      variablesContainOnlyTarget: true,
      mutationHasTerminalState: true,
      initialMutationRejected: row.fail,
      initialRejectionContainsCode: false,
      preUnmountCacheContainsCode: false,
      logsContainCode: false,
      resultContainsCode: false,
      replayUnavailable: true,
      replayContainsCode: false,
      replaySentNoRequest: true,
      helperUnavailable: true,
      postUnmountCacheContainsCode: false,
    });
  });
}

it("clears a login code when the client gate refuses before dispatch", async () => {
  const consoleCapture = captureConsoleOutput();
  const harness = createSecretRetentionHarness({
    "providers.submitLoginCode": () => ({ outcome: "accepted" }),
  });
  harnesses.push(harness);
  queryClients.push(harness.queryClient);
  const observers: MutationObserverReference[] = [];
  captureMutationObservers(harness.queryClient, observers);
  const { result, unmount } = renderHook(
    () => {
      const submitted = useSubmittedSecretInput<string>(UNAVAILABLE);
      return {
        input: submitted,
        mutation: useProvidersSubmitLoginCodeForClient(
          null,
          submitted.read,
          submitted.clear,
        ),
      };
    },
    { wrapper: wrapper(harness.queryClient) },
  );

  let initialMutationRejected = false;
  let initialRejectionMatchesGate = false;
  let initialRejectionContainsCode = false;
  await act(async () => {
    result.current.input.set(FAKE_CODE);
    try {
      await result.current.mutation.mutateAsync({
        providerId: "opencode",
        profileId: "profile-retention",
      });
    } catch (error) {
      initialMutationRejected = true;
      initialRejectionMatchesGate =
        error instanceof Error && error.message === "Host client unavailable";
      initialRejectionContainsCode = containsSyntheticInput(error, [FAKE_CODE]);
    }
  });
  await waitFor(() => expect(result.current.mutation.status).toBe("error"));

  const mutation = harness.queryClient.getMutationCache().getAll().at(-1);
  if (mutation === undefined)
    throw new Error("Gated login code mutation was not retained");
  const mutationFn = mutation.options.mutationFn;
  if (mutationFn === undefined)
    throw new Error("Gated login code mutation has no function");
  const helperUnavailableAfterSettle = (() => {
    try {
      result.current.input.read();
      return false;
    } catch (error) {
      return error instanceof Error && error.message === UNAVAILABLE;
    }
  })();
  const preUnmountCacheContainsCode = mutationStateContainsSyntheticInput(
    harness.queryClient,
    observers,
    [FAKE_CODE],
  );
  let replayMatchesGate = false;
  let replayContainsCode = false;
  const callsBeforeReplay = harness.messenger.calls.length;
  try {
    await mutationFn(
      { providerId: "opencode", profileId: "profile-retention" },
      {
        client: harness.queryClient,
        meta: mutation.options.meta,
        mutationKey: mutation.options.mutationKey ?? [],
      },
    );
  } catch (error) {
    replayMatchesGate =
      error instanceof Error && error.message === "Host client unavailable";
    replayContainsCode = containsSyntheticInput(error, [FAKE_CODE]);
  }
  const replaySentNoRequest =
    harness.messenger.calls.length === callsBeforeReplay;
  unmount();
  const helperUnavailableAfterUnmount = (() => {
    try {
      result.current.input.read();
      return false;
    } catch (error) {
      return error instanceof Error && error.message === UNAVAILABLE;
    }
  })();

  expect({
    initialMutationRejected,
    initialRejectionMatchesGate,
    initialRejectionContainsCode,
    helperUnavailableAfterSettle,
    preUnmountCacheContainsCode,
    replayMatchesGate,
    replayContainsCode,
    replaySentNoRequest,
    requestCount: harness.messenger.calls.length,
    variablesContainOnlyTarget: hasExactObjectKeys(mutation.state.variables, [
      "providerId",
      "profileId",
    ]),
    mutationStatusIsError: mutation.state.status === "error",
    stateContainsCode: mutationStateContainsSyntheticInput(
      harness.queryClient,
      observers,
      [FAKE_CODE],
    ),
    resultContainsCode: containsSyntheticInput(result.current, [FAKE_CODE]),
    logsContainCode: containsSyntheticInput(consoleCapture.output, [FAKE_CODE]),
    helperUnavailableAfterUnmount,
  }).toEqual({
    initialMutationRejected: true,
    initialRejectionMatchesGate: true,
    initialRejectionContainsCode: false,
    helperUnavailableAfterSettle: true,
    preUnmountCacheContainsCode: false,
    replayMatchesGate: true,
    replayContainsCode: false,
    replaySentNoRequest: true,
    requestCount: 0,
    variablesContainOnlyTarget: true,
    mutationStatusIsError: true,
    stateContainsCode: false,
    resultContainsCode: false,
    logsContainCode: false,
    helperUnavailableAfterUnmount: true,
  });
});
