import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";

const mocks = vi.hoisted(() => ({
  useSessionHandle: vi.fn(() => null),
  adoptWarmSessionInstance: vi.fn(),
}));

vi.mock(
  "@/lib/registries/terminal-session-registry",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/registries/terminal-session-registry")
    >()),
    useTerminalSessionHandle: mocks.useSessionHandle,
  }),
);

// The real engine registry, so a kept-alive engine's grid is what the
// bootstrap peeks; only the warm-session adoption is stubbed.
vi.mock(
  "@/components/epic-canvas/renderers/xterm-host-registry",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-canvas/renderers/xterm-host-registry")
    >()),
    adoptWarmSessionInstance: mocks.adoptWarmSessionInstance,
  }),
);

import { __disposeAllXtermHostsForTests } from "@/components/epic-canvas/renderers/xterm-host-registry";
import { acquireMountedXtermEngine } from "@/components/epic-canvas/renderers/__tests__/xterm-host-entry-fixture";
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

afterEach(() => {
  __disposeAllXtermHostsForTests();
  vi.useRealTimers();
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
      hostId: "host-1",
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

  // A reopened terminal in a pane that cannot measure itself falls back to the
  // kept-alive engine's grid after the measure wait. The engine's grid moves
  // while the tile waits (the host echoes a new effective size); a stale memo
  // of the first peek subscribed the session at the old grid.
  it("subscribes at the kept-alive engine's grid as it is when the measure wait ends", () => {
    vi.useFakeTimers();
    const term = acquireMountedXtermEngine({
      instanceId: "warm-instance",
      sessionId: "terminal-1",
      hostId: "host-1",
      cols: 100,
      rows: 30,
    });

    renderHook(() =>
      useHostTerminalBootstrap({
        hostId: "host-1",
        epicId: "epic-1",
        terminalId: "terminal-1",
        instanceId: "reopened-instance",
        projection: projection({
          status: "running",
          sessionId: "terminal-1",
          currentCwd: "/repo/live",
          activeProcessName: "bun",
          cols: 100,
          rows: 30,
        }),
        canMutate: true,
        ensureRunning: mutation(),
      }),
    );
    term.resize(140, 45);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(mocks.useSessionHandle).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true, cols: 140, rows: 45 }),
    );
  });
});
