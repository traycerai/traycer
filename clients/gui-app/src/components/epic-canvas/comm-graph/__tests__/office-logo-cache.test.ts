import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearOfficeLogoCache,
  officeHarnessLogo,
  onOfficeLogoReady,
} from "@/components/epic-canvas/comm-graph/office/office-logo-cache";

afterEach(() => {
  clearOfficeLogoCache();
});

/**
 * A stand-in for the browser's `Image` element. Schedules `onload` on a
 * MICROtask, the way a real decode resolves asynchronously relative to the
 * synchronous `src` assignment that starts it - `vi.stubGlobal` takes the
 * class as `unknown`, so no cast is needed to install it as `globalThis.Image`.
 */
class FakeLogoImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private assignedSrc = "";

  get src(): string {
    return this.assignedSrc;
  }

  set src(value: string) {
    this.assignedSrc = value;
    queueMicrotask(() => this.onload?.());
  }
}

/**
 * A macrotask boundary. Every microtask queued ahead of it - the fake
 * image's `onload` included - is guaranteed to have run by the time this
 * resolves, since a macrotask never starts while microtasks remain.
 */
function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Installs the whole decode pipeline jsdom does not have: an `Image` that
 * actually loads, a `URL` that hands back a fake blob URL, and a 2D canvas
 * context to draw into. Everything is torn down together, so a listener test
 * cannot leak a stub into the next one.
 */
function installLogoDecodePipeline(): () => void {
  vi.stubGlobal("Image", FakeLogoImage);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake-logo");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

  const contextStub: Partial<CanvasRenderingContext2D> = {
    imageSmoothingEnabled: false,
    drawImage: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((
    contextId: string,
  ): CanvasRenderingContext2D | null => {
    if (contextId !== "2d") return null;
    return contextStub as CanvasRenderingContext2D;
  }) as HTMLCanvasElement["getContext"]);

  return () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  };
}

/**
 * jsdom has no 2d canvas and no image decoder, so a logo can never become
 * ready here. That is the same state a real browser is in for the first frames
 * after a miss, which is why the contract under test is "returns null and does
 * not throw" rather than anything about pixels: the frame loop calls this on
 * every frame, and a throw would take the whole floor down.
 */
describe("officeHarnessLogo", () => {
  it("returns null and stays silent where nothing can be rasterized", () => {
    expect(() => officeHarnessLogo("claude")).not.toThrow();
    expect(officeHarnessLogo("claude")).toBeNull();
  });

  it("survives being called every frame for every harness on the floor", () => {
    expect(() => {
      for (let frame = 0; frame < 3; frame += 1) {
        officeHarnessLogo("claude");
        officeHarnessLogo("codex");
        officeHarnessLogo("cursor");
      }
    }).not.toThrow();
  });

  it("serves one raster per harness and forgets it all on a clear", () => {
    // The theme is NOT part of the key: the mark is recolored to the harness
    // accent, which is the same colour in both themes, so a per-theme entry
    // only ever held a second identical raster. Asking repeatedly is a hit
    // that starts no further work; clearing puts it back to a cold miss.
    officeHarnessLogo("claude");
    expect(officeHarnessLogo("claude")).toBeNull();
    clearOfficeLogoCache();
    expect(officeHarnessLogo("claude")).toBeNull();
  });
});

describe("onOfficeLogoReady", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not call a subscribed listener synchronously when nothing can decode", () => {
    // jsdom has no image decoder, so this call can only ever claim the slot
    // and return null - the ready notification is for a LATER frame, once a
    // real decode finishes, never for this call itself.
    const listener = vi.fn();
    const unsubscribe = onOfficeLogoReady(listener);

    expect(officeHarnessLogo("claude")).toBeNull();

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("stops notifying a listener once it has unsubscribed", async () => {
    installLogoDecodePipeline();
    const listener = vi.fn();
    const unsubscribe = onOfficeLogoReady(listener);

    officeHarnessLogo("claude");
    await flushMacrotask();

    // The decode actually finished this time, so the listener fires exactly
    // once for it.
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    clearOfficeLogoCache();
    officeHarnessLogo("claude");
    await flushMacrotask();

    // A second decode runs, but the unsubscribed listener is no longer in
    // the set - still one call, not two, is what proves the unsubscribe
    // actually removed it rather than merely returning a no-op.
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
