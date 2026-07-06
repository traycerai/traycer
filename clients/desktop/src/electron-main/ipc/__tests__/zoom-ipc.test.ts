import { describe, expect, it, vi } from "vitest";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../../ipc-contracts/ipc-channels";
import type { ZoomPercent } from "../../../ipc-contracts/zoom-types";
import { registerZoomIpc, type ZoomIpcBridge } from "../zoom-ipc";

type InvokeHandler = (
  event: unknown,
  ...args: unknown[]
) => unknown | Promise<unknown>;

class FakeZoomController {
  private percent: ZoomPercent = 100;
  private readonly handlers = new Set<(percent: ZoomPercent) => void>();
  readonly requests: string[] = [];

  getZoomPercent(): ZoomPercent {
    return this.percent;
  }

  zoomIn(): Promise<ZoomPercent> {
    this.requests.push("in");
    return this.setZoomPercent(110);
  }

  zoomOut(): Promise<ZoomPercent> {
    this.requests.push("out");
    return this.setZoomPercent(90);
  }

  reset(): Promise<ZoomPercent> {
    this.requests.push("reset");
    return this.setZoomPercent(100);
  }

  setZoomPercent(percent: number): Promise<ZoomPercent> {
    this.requests.push(`set:${percent}`);
    this.percent = normalizeTestPercent(percent);
    for (const handler of this.handlers) {
      handler(this.percent);
    }
    return Promise.resolve(this.percent);
  }

  onChange(listener: (percent: ZoomPercent) => void): () => void {
    this.handlers.add(listener);
    return () => {
      this.handlers.delete(listener);
    };
  }
}

describe("registerZoomIpc", () => {
  it("registers zoom invokes and broadcasts controller changes", async () => {
    const controller = new FakeZoomController();
    const handlers = new Map<string, InvokeHandler>();
    const fanOut = vi.fn();
    const bridge: ZoomIpcBridge = {
      zoomController: controller,
      disposeFns: [],
      handleInvoke: (channel, handler) => {
        handlers.set(channel, handler);
      },
      fanOut,
    };

    registerZoomIpc(bridge);

    expect(await handlers.get(RunnerHostInvoke.zoomGet)?.({}, null)).toBe(100);
    expect(await handlers.get(RunnerHostInvoke.zoomSet)?.({}, 125)).toBe(125);
    expect(await handlers.get(RunnerHostInvoke.zoomStepIn)?.({})).toBe(110);
    expect(await handlers.get(RunnerHostInvoke.zoomStepOut)?.({})).toBe(90);
    expect(await handlers.get(RunnerHostInvoke.zoomReset)?.({})).toBe(100);
    expect(fanOut).toHaveBeenLastCalledWith(RunnerHostEvent.zoomChange, 100);

    bridge.disposeFns[0]?.();
    await controller.setZoomPercent(125);
    expect(fanOut).toHaveBeenCalledTimes(4);
  });

  it("rejects malformed zoom set payloads", async () => {
    const controller = new FakeZoomController();
    const handlers = new Map<string, InvokeHandler>();
    const bridge: ZoomIpcBridge = {
      zoomController: controller,
      disposeFns: [],
      handleInvoke: (channel, handler) => {
        handlers.set(channel, handler);
      },
      fanOut: vi.fn(),
    };

    registerZoomIpc(bridge);

    await expect(
      Promise.resolve().then(() =>
        handlers.get(RunnerHostInvoke.zoomSet)?.({}, "125"),
      ),
    ).rejects.toThrow("Zoom percent must be a finite number");
    await expect(
      Promise.resolve().then(() =>
        handlers.get(RunnerHostInvoke.zoomSet)?.({}, Number.POSITIVE_INFINITY),
      ),
    ).rejects.toThrow("Zoom percent must be a finite number");
  });
});

function normalizeTestPercent(percent: number): ZoomPercent {
  if (percent === 90 || percent === 100 || percent === 110 || percent === 125) {
    return percent;
  }
  return 100;
}
