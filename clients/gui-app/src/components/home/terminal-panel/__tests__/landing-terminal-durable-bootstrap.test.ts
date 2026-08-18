import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import {
  resolveLandingTerminalDurableBootstrapAction,
  useLandingTerminalDurableLifecycle,
  type LandingTerminalDurableBootstrapAction,
} from "@/components/home/terminal-panel/landing-terminal-durable-bootstrap";

type RuntimeStatus = "running" | "dormant" | "missing";

function projection(status: "running" | "dormant"): PlainTerminalProjection {
  return {
    record: {
      terminalId: "terminal-1",
      hostId: "host-1",
      scope: { kind: "independent" },
      launch: { cwd: "/repo", shellCommand: "/bin/zsh", shellArgs: [] },
      manualTitle: null,
      revision: 1,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
    },
    runtime:
      status === "dormant"
        ? { status: "dormant" }
        : {
            status: "running",
            sessionId: "terminal-1",
            currentCwd: "/repo",
            activeProcessName: "zsh",
            cols: 80,
            rows: 24,
          },
  };
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolvePromise: ((value: Value) => void) | null = null;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}

describe("durable landing-terminal bootstrap", () => {
  it("lazily ensures a dormant record only when its local tab becomes active", () => {
    expect(
      resolveLandingTerminalDurableBootstrapAction({
        projectionStatus: "dormant",
        pendingCreate: false,
        active: false,
      }),
    ).toBe("none");
    expect(
      resolveLandingTerminalDurableBootstrapAction({
        projectionStatus: "dormant",
        pendingCreate: false,
        active: true,
      }),
    ).toBe("ensure-running");
  });

  it("uses create only for an explicitly new local terminal", () => {
    expect(
      resolveLandingTerminalDurableBootstrapAction({
        projectionStatus: "missing",
        pendingCreate: true,
        active: true,
      }),
    ).toBe("create");
    expect(
      resolveLandingTerminalDurableBootstrapAction({
        projectionStatus: "missing",
        pendingCreate: false,
        active: true,
      }),
    ).toBe("none");
    expect(
      resolveLandingTerminalDurableBootstrapAction({
        projectionStatus: "running",
        pendingCreate: true,
        active: true,
      }),
    ).toBe("none");
  });

  it("re-arms a newly-created mounted tab across repeated restart cycles", async () => {
    const dispatch = vi.fn(
      (_action: Exclude<LandingTerminalDurableBootstrapAction, "none">) =>
        Promise.resolve(projection("running")),
    );
    const adopt = vi.fn();
    const rendered = renderHook(
      (props: {
        readonly status: RuntimeStatus;
        readonly pendingCreate: boolean;
      }) =>
        useLandingTerminalDurableLifecycle({
          projectionStatus: props.status,
          pendingCreate: props.pendingCreate,
          active: true,
          canMutate: true,
          gridReady: true,
          dispatch,
          adopt,
        }),
      { initialProps: { status: "missing", pendingCreate: true } },
    );
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(dispatch).toHaveBeenNthCalledWith(1, "create");

    rendered.rerender({ status: "running", pendingCreate: false });
    rendered.rerender({ status: "dormant", pendingCreate: false });
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(dispatch).toHaveBeenNthCalledWith(2, "ensure-running");
    rendered.rerender({ status: "dormant", pendingCreate: false });
    expect(dispatch).toHaveBeenCalledTimes(2);

    rendered.rerender({ status: "running", pendingCreate: false });
    rendered.rerender({ status: "dormant", pendingCreate: false });
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(3));
    expect(dispatch).toHaveBeenNthCalledWith(3, "ensure-running");
  });

  it("re-arms an initially-discovered tab across two restart cycles", async () => {
    const dispatch = vi.fn(() => Promise.resolve(projection("running")));
    const rendered = renderHook(
      (status: RuntimeStatus) =>
        useLandingTerminalDurableLifecycle({
          projectionStatus: status,
          pendingCreate: false,
          active: true,
          canMutate: true,
          gridReady: true,
          dispatch,
          adopt: vi.fn(),
        }),
      { initialProps: "running" as RuntimeStatus },
    );
    expect(dispatch).not.toHaveBeenCalled();

    rendered.rerender("dormant");
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    rendered.rerender("running");
    rendered.rerender("dormant");
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
  });

  it("exposes requestPending while a deferred dispatch is in flight and clears it after settlement", async () => {
    const pending = deferred<PlainTerminalProjection>();
    const dispatch = vi.fn(() => pending.promise);
    const adopt = vi.fn();
    const rendered = renderHook(() =>
      useLandingTerminalDurableLifecycle({
        projectionStatus: "dormant",
        pendingCreate: false,
        active: true,
        canMutate: true,
        gridReady: true,
        dispatch,
        adopt,
      }),
    );
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(rendered.result.current.requestPending).toBe(true);
    expect(rendered.result.current.requestSettled).toBe(false);

    await act(() => {
      pending.resolve(projection("running"));
      return Promise.resolve();
    });
    await waitFor(() =>
      expect(rendered.result.current.requestPending).toBe(false),
    );
    expect(rendered.result.current.requestSettled).toBe(true);
    expect(adopt).toHaveBeenCalledTimes(1);
  });

  it("retains the error presentation while an explicit retry is pending", async () => {
    const retryRequest = deferred<PlainTerminalProjection>();
    const dispatch = vi
      .fn<() => Promise<PlainTerminalProjection>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(retryRequest.promise);
    const rendered = renderHook(() =>
      useLandingTerminalDurableLifecycle({
        projectionStatus: "dormant",
        pendingCreate: false,
        active: true,
        canMutate: true,
        gridReady: true,
        dispatch,
        adopt: vi.fn(),
      }),
    );
    await waitFor(() =>
      expect(rendered.result.current.requestError?.message).toBe("offline"),
    );
    rendered.rerender();
    expect(dispatch).toHaveBeenCalledTimes(1);

    act(() => rendered.result.current.retry());
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(rendered.result.current.requestError?.message).toBe("offline");
    expect(rendered.result.current.requestPending).toBe(true);

    await act(() => {
      retryRequest.resolve(projection("running"));
      return Promise.resolve();
    });
    await waitFor(() =>
      expect(rendered.result.current.requestPending).toBe(false),
    );
    expect(rendered.result.current.requestError).toBeNull();
  });

  it("ignores stale responses after a runtime transition and unmount", async () => {
    const first = deferred<PlainTerminalProjection>();
    const second = deferred<PlainTerminalProjection>();
    const dispatch = vi
      .fn<
        (
          action: Exclude<LandingTerminalDurableBootstrapAction, "none">,
        ) => Promise<PlainTerminalProjection>
      >()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const adopt = vi.fn();
    const rendered = renderHook(
      (status: RuntimeStatus) =>
        useLandingTerminalDurableLifecycle({
          projectionStatus: status,
          pendingCreate: false,
          active: true,
          canMutate: true,
          gridReady: true,
          dispatch,
          adopt,
        }),
      { initialProps: "dormant" as RuntimeStatus },
    );
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    rendered.rerender("running");
    await act(() => {
      first.resolve(projection("running"));
      return Promise.resolve();
    });
    expect(adopt).not.toHaveBeenCalled();

    rendered.rerender("dormant");
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    rendered.unmount();
    await act(() => {
      second.resolve(projection("running"));
      return Promise.resolve();
    });
    expect(adopt).not.toHaveBeenCalled();
  });
});
