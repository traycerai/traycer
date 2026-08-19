import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type {
  ConvergeReadyOk,
  IHostManagement,
  IRunnerHost,
  ITraycerCli,
  MutationOutcome,
} from "@traycer-clients/shared/platform/runner-host";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { runnerQueryKeys } from "@/lib/query-keys";
import { buildOverviewManagement } from "@/components/settings/panels/__tests__/host-overview-test-support";
import { useRunnerReinstallTraycer } from "../use-runner-reinstall-traycer-mutation";

/**
 * `useRunnerReinstallTraycer` at the HOOK level, because the invalidations it
 * owes are not observable from the Overview panel: the only query mounted
 * there on `hostInstalledRecord` is the empty-account recovery zone, whose
 * `enabled` requires `scope.host === null` - the exact opposite of the
 * down-local scenario the Reinstall verb renders in, and `traycerCli` is
 * `undefined` in those fixtures besides. A UI-level assertion on either key
 * would pass no matter what this hook did, so it is made here against the
 * cache itself.
 */
function createManagement(
  outcome: MutationOutcome<ConvergeReadyOk>,
): IHostManagement {
  return buildOverviewManagement({
    getRemovalState: vi.fn(() => Promise.resolve({ removedByUser: true })),
    clearRemoval: vi.fn(() => Promise.resolve()),
    convergeReady: vi.fn(() => Promise.resolve(outcome)),
  });
}

function createWrapper(options: {
  readonly management: IHostManagement;
  readonly traycerCli: ITraycerCli;
  readonly queryClient: QueryClient;
}): (props: { readonly children: ReactNode }) => ReactNode {
  const host: IRunnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.test/sign-in",
    authnBaseUrl: "https://auth.traycer.test",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: options.traycerCli,
    hostManagement: options.management,
  });
  return function ReinstallWrapper(props: { readonly children: ReactNode }) {
    return (
      <QueryClientProvider client={options.queryClient}>
        <RunnerHostContext.Provider value={host}>
          {props.children}
        </RunnerHostContext.Provider>
      </QueryClientProvider>
    );
  };
}

describe("useRunnerReinstallTraycer", () => {
  it("rejects a BUSY converge - nothing was reinstalled, and busy is a fail-safe", async () => {
    // `busy` is the CLI declining to swap the bytes of a live host, so the
    // reinstall did not happen - and `E_HOST_BUSY` is raised as a FAIL-SAFE
    // whenever a live PID's idle state cannot be determined at all, so it is
    // not even evidence the host serves. A leftover process from the removal
    // is exactly that case. Resolving it ran the success toast and, with the
    // sentinel now cleared, left `isError` false - which is what takes the
    // Reinstall verb off the page for a computer that still has no host.
    const management = createManagement({
      kind: "busy",
      continuation: "retry-with-force",
      message: "The running host has work in progress",
    });
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const { result } = renderHook(useRunnerReinstallTraycer, {
      wrapper: createWrapper({
        management,
        traycerCli: new MockTraycerCli(),
        queryClient,
      }),
    });

    await expect(result.current.mutateAsync()).rejects.toThrow(
      "The running host has work in progress",
    );
  });

  it("rejects an ok converge that started NO host - the sentinel clear did not take", async () => {
    // `ok` with `running: false` is `HostController.convergeReady`'s removal
    // -sentinel short-circuit, which after `clearRemoval` means the clear did
    // not land: the converge did nothing, under consent that was supposed to
    // have been revoked. Same shape as the `busy` case above and the ensure
    // port's, and the same rule - an `ok`-ish outcome is not an answer to the
    // question this verb asked.
    const management = createManagement({
      kind: "ok",
      value: { running: false, version: null },
    });
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const { result } = renderHook(useRunnerReinstallTraycer, {
      wrapper: createWrapper({
        management,
        traycerCli: new MockTraycerCli(),
        queryClient,
      }),
    });

    await expect(result.current.mutateAsync()).rejects.toThrow(
      "no host started on this computer",
    );
  });

  it("refreshes install state after a converge that FAILED with the bytes already committed", async () => {
    // `installed-not-converged` says in as many words that the install
    // committed and only the post-commit service invariant failed. The
    // mutation still rejects, so while these invalidations lived in
    // `onSuccess` they never ran for it, and Settings went on reporting "Not
    // installed" for a machine whose bytes had landed.
    //
    // Without the move to `onSettled`, the two assertions after the removal
    // one below fail: the sentinel key would be the ONLY entry dropped.
    const management = createManagement({
      kind: "installed-not-converged",
      message: "the service did not come up after the swap",
    });
    const traycerCli: ITraycerCli = new MockTraycerCli();
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(useRunnerReinstallTraycer, {
      wrapper: createWrapper({ management, traycerCli, queryClient }),
    });

    await expect(result.current.mutateAsync()).rejects.toThrow(
      "the service did not come up after the swap",
    );

    // The sentinel read: already `onSettled` before this change, asserted
    // here as the POSITIVE CONTROL. If the mutation had not run its settle
    // handler at all, this would fail too - which is what separates "the fix
    // works" from "nothing invalidated anything".
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: runnerQueryKeys.hostRemovalState(management),
      });
    });
    // Keyed on the management/CLI INSTANCE, so these assert the exact cache
    // entries a landed install changes - not merely that something was
    // invalidated some number of times.
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: runnerQueryKeys.hostInstalledRecord(management),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: runnerQueryKeys.traycerHostStatus(traycerCli),
    });
  });
});
