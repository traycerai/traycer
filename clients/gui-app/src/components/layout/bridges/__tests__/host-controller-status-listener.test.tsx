import { Profiler, type ProfilerOnRenderCallback } from "react";
import {
  defaultScheduler,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostControllerStatus,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import { HostControllerStatusListener } from "@/components/layout/bridges/host-controller-status-listener";
import { useRunnerHostControllerStatusQuery } from "@/hooks/runner/use-runner-host-controller-status-query";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";

const pushed = vi.hoisted(() => ({
  listener: null as ((status: HostControllerStatus) => void) | null,
}));

function status(checkedAt: string): HostControllerStatus {
  return {
    localAttempt: null,
    download: null,
    mutation: null,
    installedVersion: "1.0.0",
    latestVersion: "1.0.0",
    stagedVersion: null,
    installedRuntimeVersion: "1.0.0",
    runningRuntimeVersion: "1.0.0",
    updateReady: false,
    activation: "activated",
    reachable: true,
    removedByUser: false,
    checkedAt,
    lastEnsureFailure: null,
    updateDeferral: null,
  };
}

function StatusReader() {
  const query = useRunnerHostControllerStatusQuery();
  return (
    <output>
      {query.data === undefined ? "pending" : String(query.data.updateReady)}
    </output>
  );
}

function mount(queryClient: QueryClient, runnerHost: IRunnerHost) {
  const readerCommits = vi.fn<ProfilerOnRenderCallback>();
  const view = render(
    <RunnerHostContext.Provider value={runnerHost}>
      <QueryClientProvider client={queryClient}>
        <HostControllerStatusListener />
        <Profiler id="status-reader" onRender={readerCommits}>
          <StatusReader />
        </Profiler>
      </QueryClientProvider>
    </RunnerHostContext.Provider>,
  );
  return { ...view, readerCommits };
}

function runnerHostWithStatusBridge(): {
  readonly runnerHost: IRunnerHost;
  readonly management: object;
} {
  const management = {
    getHostControllerStatus: vi.fn(() => Promise.resolve(status("initial"))),
  };
  const runnerHost = Object.assign(createFakeRunnerHost({}), {
    hostManagement: management,
    hostControllerStatus: {
      onChange: (listener: (value: HostControllerStatus) => void) => {
        pushed.listener = listener;
        return { dispose: () => (pushed.listener = null) };
      },
    },
  });
  return { runnerHost, management };
}

// Each push reaches its readers before the next one, so a stored push
// commits the reader on its own instead of batching with the next.
beforeEach(() => {
  notifyManager.setScheduler((notify) => notify());
});

afterEach(() => {
  cleanup();
  pushed.listener = null;
  notifyManager.setScheduler(defaultScheduler);
});

describe("HostControllerStatusListener", () => {
  it("stores a push that differs only in checkedAt nowhere, and a changed lane once", async () => {
    const { runnerHost, management } = runnerHostWithStatusBridge();
    const queryClient = new QueryClient();
    const key = runnerQueryKeys.hostControllerStatus(management);
    const cached = status("initial");
    queryClient.setQueryData(key, cached);
    const { readerCommits } = mount(queryClient, runnerHost);
    await waitFor(() => expect(screen.getByText("false")).not.toBeNull());
    readerCommits.mockClear();

    act(() => pushed.listener?.(status("later")));
    expect(readerCommits).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(key)).toBe(cached);

    const changed = { ...status("latest"), updateReady: true };
    act(() => pushed.listener?.(changed));
    await waitFor(() => expect(screen.getByText("true")).not.toBeNull());
    expect(queryClient.getQueryData(key)).toEqual(changed);
    // One commit, for the changed lane: a stored checkedAt-only push would
    // have committed the reader a second time.
    expect(readerCommits).toHaveBeenCalledTimes(1);
  });
});
