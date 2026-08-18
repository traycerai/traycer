import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";

const mocks = vi.hoisted(() => ({
  useSessionHandle: vi.fn(() => null),
  adoptWarmSessionInstance: vi.fn(),
}));

vi.mock("@/lib/registries/terminal-session-registry", () => ({
  useTerminalSessionHandle: mocks.useSessionHandle,
}));

vi.mock("@/components/epic-canvas/renderers/xterm-host-registry", () => ({
  adoptWarmSessionInstance: mocks.adoptWarmSessionInstance,
  peekXtermHostGrid: () => null,
  peekXtermHostGridForSession: () => null,
}));

import {
  useHostTerminalBootstrap,
  type EnsureRunningMutation,
} from "../use-host-terminal-bootstrap";

function projection(
  runtime: PlainTerminalProjection["runtime"],
): PlainTerminalProjection {
  return {
    record: {
      terminalId: "terminal-1",
      hostId: "host-1",
      scope: { kind: "epic", epicId: "epic-1" },
      launch: {
        cwd: "/repo",
        shellCommand: "/bin/zsh",
        shellArgs: ["-l"],
      },
      manualTitle: null,
      revision: 4,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
    },
    runtime,
  };
}

function mutation(): EnsureRunningMutation {
  return {
    isIdle: true,
    isError: false,
    error: null,
    data: undefined,
    mutate: vi.fn<EnsureRunningMutation["mutate"]>(),
    reset: vi.fn<EnsureRunningMutation["reset"]>(),
  };
}

beforeEach(() => {
  mocks.useSessionHandle.mockClear();
  mocks.adoptWarmSessionInstance.mockClear();
});

describe("useHostTerminalBootstrap", () => {
  it("lazily revives a known dormant id through ensureRunning with the measured grid", () => {
    const ensureRunning = mutation();
    const { result } = renderHook(() =>
      useHostTerminalBootstrap({
        hostId: "host-1",
        epicId: "epic-1",
        terminalId: "terminal-1",
        instanceId: "instance-1",
        projection: projection({ status: "dormant" }),
        canMutate: true,
        ensureRunning,
      }),
    );

    expect(ensureRunning.mutate).not.toHaveBeenCalled();
    act(() => result.current.reportMeasuredGrid(132, 41));

    expect(ensureRunning.mutate).toHaveBeenCalledOnce();
    expect(ensureRunning.mutate).toHaveBeenCalledWith({
      terminalId: "terminal-1",
      cols: 132,
      rows: 41,
    });
    expect(mocks.useSessionHandle).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false, kind: "terminal" }),
    );
  });

  it("never revives a dormant record while capable authority is stale", () => {
    const ensureRunning = mutation();
    const { result } = renderHook(() =>
      useHostTerminalBootstrap({
        hostId: "host-1",
        epicId: "epic-1",
        terminalId: "terminal-1",
        instanceId: "instance-1",
        projection: projection({ status: "dormant" }),
        canMutate: false,
        ensureRunning,
      }),
    );

    act(() => result.current.reportMeasuredGrid(100, 30));
    expect(ensureRunning.mutate).not.toHaveBeenCalled();
  });

  it("never attaches a stale running projection while capable authority is unreachable", () => {
    const ensureRunning = mutation();
    const { result } = renderHook(() =>
      useHostTerminalBootstrap({
        hostId: "host-1",
        epicId: "epic-1",
        terminalId: "terminal-1",
        instanceId: "instance-1",
        projection: projection({
          status: "running",
          sessionId: "terminal-1",
          currentCwd: "/repo/live",
          activeProcessName: "bun",
          cols: 100,
          rows: 30,
        }),
        canMutate: false,
        ensureRunning,
      }),
    );

    act(() => result.current.reportMeasuredGrid(100, 30));
    expect(ensureRunning.mutate).not.toHaveBeenCalled();
    expect(mocks.useSessionHandle).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it("attaches a running host projection without dispatching ensure", () => {
    const ensureRunning = mutation();
    const { result } = renderHook(() =>
      useHostTerminalBootstrap({
        hostId: "host-1",
        epicId: "epic-1",
        terminalId: "terminal-1",
        instanceId: "instance-1",
        projection: projection({
          status: "running",
          sessionId: "terminal-1",
          currentCwd: "/repo/live",
          activeProcessName: "bun",
          cols: 100,
          rows: 30,
        }),
        canMutate: true,
        ensureRunning,
      }),
    );

    act(() => result.current.reportMeasuredGrid(100, 30));
    expect(ensureRunning.mutate).not.toHaveBeenCalled();
    expect(mocks.useSessionHandle).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: true,
        reattachMode: "live",
        sessionId: "terminal-1",
      }),
    );
  });
});
