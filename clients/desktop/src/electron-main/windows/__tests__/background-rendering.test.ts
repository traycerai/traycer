import { describe, expect, it } from "vitest";
import { RunnerHostInvoke } from "../../../ipc-contracts/ipc-channels";
import {
  installBackgroundRenderingReset,
  registerBackgroundRenderingIpc,
  type BackgroundRenderingTarget,
  type BackgroundRenderingWindow,
} from "../background-rendering";

type ResetEvent = "did-navigate" | "did-fail-load" | "render-process-gone";

/** Electron's did-fail-load argument list; the other events pass none. */
type ResetListener = (
  event: unknown,
  errorCode: number,
  errorDescription: string,
  validatedURL: string,
  isMainFrame: boolean,
) => void;

/**
 * A WebContents that models Electron's real throttling state: one boolean,
 * `true` by default, that `get` and `set` share. `setCalls` counts every call
 * that reaches Electron, because each one re-shows a hidden widget whatever
 * the value.
 */
class FakeWebContents implements BackgroundRenderingWindow {
  throttling = true;
  setCalls = 0;
  private readonly listeners = new Map<ResetEvent, ResetListener[]>();

  getBackgroundThrottling(): boolean {
    return this.throttling;
  }

  setBackgroundThrottling(allowed: boolean): void {
    this.setCalls += 1;
    this.throttling = allowed;
  }

  on(event: ResetEvent, listener: ResetListener): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  emit(event: ResetEvent): void {
    this.emitLoadFailure(event, true);
  }

  /** `isMainFrame` is only read by did-fail-load. */
  emitLoadFailure(event: ResetEvent, isMainFrame: boolean): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(
        {},
        -105,
        "ERR_NAME_NOT_RESOLVED",
        "https://example.test/",
        isMainFrame,
      );
    }
  }
}

/**
 * The renderer's demand as main receives it: through the handler
 * `registerBackgroundRenderingIpc` registers, with the asking window's
 * WebContents as `event.sender`.
 */
function rendererDemand(): (
  target: BackgroundRenderingTarget,
  required: boolean,
) => void {
  let registered:
    | ((
        event: { readonly sender: BackgroundRenderingTarget },
        ...args: unknown[]
      ) => unknown)
    | null = null;
  registerBackgroundRenderingIpc({
    handleInvoke: (channel, handler) => {
      expect(channel).toBe(RunnerHostInvoke.backgroundRenderingSet);
      registered = handler;
    },
  });
  return (target, required) => {
    if (registered === null) throw new Error("no handler registered");
    registered({ sender: target }, required);
  };
}

describe("registerBackgroundRenderingIpc", () => {
  it("makes no Electron call when throttling already has the requested value", () => {
    const target = new FakeWebContents();
    const demand = rendererDemand();

    // Throttled already: releasing a demand that was never made is a no-op.
    demand(target, false);
    expect(target.setCalls).toBe(0);

    demand(target, true);
    expect(target.throttling).toBe(false);
    expect(target.setCalls).toBe(1);

    // The same demand again changes nothing, so it must not reach Electron.
    demand(target, true);
    expect(target.setCalls).toBe(1);

    demand(target, false);
    expect(target.throttling).toBe(true);
    expect(target.setCalls).toBe(2);
  });
});

describe("installBackgroundRenderingReset", () => {
  it.each<ResetEvent>(["did-navigate", "did-fail-load", "render-process-gone"])(
    "restores throttling on %s while a demand is outstanding",
    (event) => {
      const target = new FakeWebContents();
      installBackgroundRenderingReset(target);
      rendererDemand()(target, true);
      expect(target.throttling).toBe(false);

      target.emit(event);

      expect(target.throttling).toBe(true);
      expect(target.setCalls).toBe(2);
    },
  );

  it.each<ResetEvent>(["did-navigate", "did-fail-load", "render-process-gone"])(
    "makes no Electron call on %s when no demand is outstanding",
    (event) => {
      const target = new FakeWebContents();
      installBackgroundRenderingReset(target);

      target.emit(event);

      expect(target.setCalls).toBe(0);
    },
  );

  it("leaves a demand alone when a SUBFRAME fails to load", () => {
    const target = new FakeWebContents();
    installBackgroundRenderingReset(target);
    rendererDemand()(target, true);

    target.emitLoadFailure("did-fail-load", false);

    expect(target.throttling).toBe(false);
    expect(target.setCalls).toBe(1);
  });
});
