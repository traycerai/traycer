import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  HostOperationStatusEnvelope,
  IHostManagement,
} from "@traycer-clients/shared/platform/runner-host";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { DesktopHostOperationStatusBridge } from "@/lib/windows/types";
import { HostOperationStatusListener } from "@/components/layout/bridges/host-operation-status-listener";
import { useRunnerHostOperationStatusQuery } from "@/hooks/runner/use-runner-host-operation-status-query";
import { runnerQueryKeys } from "@/lib/query-keys";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

const activeEnvelope: HostOperationStatusEnvelope = {
  revision: 1,
  status: {
    operationId: "op-stale",
    kind: "ensure",
    stage: "applying",
    percent: null,
    bytes: null,
    totalBytes: null,
    message: null,
    startedAt: "2026-07-21T00:00:00Z",
  },
  lastEnsureOutcome: null,
};

const settledEnvelope: HostOperationStatusEnvelope = {
  revision: 2,
  status: null,
  lastEnsureOutcome: null,
};

function createManagement(
  getOperationStatus: () => Promise<HostOperationStatusEnvelope>,
): IHostManagement {
  const notImplemented = (): Promise<never> =>
    Promise.reject(new Error("not implemented in this test"));
  return {
    installHost: notImplemented,
    updateHost: notImplemented,
    uninstallHost: notImplemented,
    restartHost: notImplemented,
    uninstallTraycer: notImplemented,
    getRemovalState: () => Promise.resolve({ removedByUser: false }),
    clearRemoval: () => Promise.resolve(),
    getHostLogs: notImplemented,
    runDoctor: notImplemented,
    availableVersions: notImplemented,
    installedRecord: () => Promise.resolve(null),
    registerService: notImplemented,
    ensureHost: notImplemented,
    deregisterService: notImplemented,
    registryCheck: notImplemented,
    getOperationStatus,
    freePortAndRestart: (input) => Promise.resolve(input),
    cliManifest: () => Promise.resolve(null),
    getHostName: () =>
      Promise.resolve({
        systemName: "test-host",
        customName: null,
        effectiveName: "test-host",
      }),
    setHostName: (input) =>
      Promise.resolve({
        systemName: "test-host",
        customName: input.customName,
        effectiveName: input.customName ?? "test-host",
      }),
  };
}

function createStatusBridge(): {
  readonly bridge: DesktopHostOperationStatusBridge;
  readonly emit: (envelope: HostOperationStatusEnvelope) => void;
  readonly subscriberCount: () => number;
} {
  const handlers = new Set<(envelope: HostOperationStatusEnvelope) => void>();
  return {
    bridge: {
      onChange: (handler) => {
        handlers.add(handler);
        return {
          dispose: () => {
            handlers.delete(handler);
          },
        };
      },
    },
    emit: (envelope) => {
      for (const handler of handlers) {
        handler(envelope);
      }
    },
    subscriberCount: () => handlers.size,
  };
}

function makeHost(
  management: IHostManagement,
  bridge: DesktopHostOperationStatusBridge,
) {
  return Object.assign(
    new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
      hostManagement: management,
    }),
    { hostOperationStatus: bridge },
  );
}

function OperationStatusProbe(props: {
  readonly management: IHostManagement;
}) {
  const { data } = useRunnerHostOperationStatusQuery(props.management);
  return <div data-testid="operation-status-revision">{data?.revision ?? "unknown"}</div>;
}

function renderListener(
  management: IHostManagement,
  bridge: DesktopHostOperationStatusBridge,
): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={makeHost(management, bridge)}>
        <HostOperationStatusListener />
        <OperationStatusProbe management={management} />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("HostOperationStatusListener", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("subscribes before reading and keeps a pushed terminal revision over a stale snapshot", async () => {
    let resolveSnapshot: (envelope: HostOperationStatusEnvelope) => void = () =>
      undefined;
    const snapshot = new Promise<HostOperationStatusEnvelope>((resolve) => {
      resolveSnapshot = resolve;
    });
    const bridge = createStatusBridge();
    const getOperationStatus = vi.fn(() => {
      expect(bridge.subscriberCount()).toBe(1);
      return snapshot;
    });
    const management = createManagement(getOperationStatus);

    renderListener(management, bridge.bridge);

    await waitFor(() => {
      expect(getOperationStatus).toHaveBeenCalledTimes(1);
    });
    act(() => {
      bridge.emit(settledEnvelope);
    });
    act(() => {
      resolveSnapshot(activeEnvelope);
    });

    await waitFor(() => {
      expect(screen.getByTestId("operation-status-revision").textContent).toBe(
        "2",
      );
    });
  });

  it("backs off failed snapshot reads while leaving the envelope unknown", async () => {
    vi.useFakeTimers();
    const bridge = createStatusBridge();
    let snapshotAttempts = 0;
    const getOperationStatus = vi.fn(() => {
      snapshotAttempts += 1;
      return snapshotAttempts === 1
        ? Promise.reject(new Error("snapshot failed"))
        : Promise.resolve(settledEnvelope);
    });
    const management = createManagement(getOperationStatus);

    const queryClient = renderListener(management, bridge.bridge);

    await act(async () => {
      await Promise.resolve();
    });
    expect(bridge.subscriberCount()).toBe(1);
    expect(getOperationStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("operation-status-revision").textContent).toBe(
      "unknown",
    );

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(getOperationStatus).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getOperationStatus).toHaveBeenCalledTimes(2);
    expect(
      queryClient.getQueryData<HostOperationStatusEnvelope>(
        runnerQueryKeys.hostOperationStatus(management),
      ),
    ).toEqual(settledEnvelope);
  });
});
