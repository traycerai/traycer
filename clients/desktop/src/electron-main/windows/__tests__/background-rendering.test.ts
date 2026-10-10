import { describe, expect, it } from "vitest";
import {
  installBackgroundRenderingReset,
  setBackgroundRenderingRequired,
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

describe("setBackgroundRenderingRequired", () => {
  it("makes no Electron call when throttling already has the requested value", () => {
    const target = new FakeWebContents();

    // Throttled already: releasing a demand that was never made is a no-op.
    setBackgroundRenderingRequired(target, false);
    expect(target.setCalls).toBe(0);

    setBackgroundRenderingRequired(target, true);
    expect(target.throttling).toBe(false);
    expect(target.setCalls).toBe(1);

    // The same demand again changes nothing, so it must not reach Electron.
    setBackgroundRenderingRequired(target, true);
    expect(target.setCalls).toBe(1);

    setBackgroundRenderingRequired(target, false);
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
      setBackgroundRenderingRequired(target, true);
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
    setBackgroundRenderingRequired(target, true);

    target.emitLoadFailure("did-fail-load", false);

    expect(target.throttling).toBe(false);
    expect(target.setCalls).toBe(1);
  });
});
