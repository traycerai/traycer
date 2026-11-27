/**
 * The Android bridge from the native window-pixel gesture geometry to the CSS
 * pixels the shared edge-swipe zones read. The native plugin is faked at the
 * package boundary; the gui-app stores are the real ones, so every assertion
 * reads what the recognizer would actually see.
 *
 * Native samples are in physical pixels, so the conversion to CSS pixels is the
 * device pixel ratio and nothing else. The viewport's width is deliberately NOT
 * an input: native and the WebView learn about a rotation at different moments,
 * and a ratio of two widths sampled at different moments converts a sample with
 * the wrong geometry. The cases below that vary the viewport width at a
 * constant ratio pin exactly that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginListenerHandle } from "@capacitor/core";
import type { SystemGestureInsets } from "@traycer-clients/gui-app/src/lib/system-gesture-insets";

interface NativeGeometry {
  readonly left: number;
  readonly right: number;
  readonly width: number;
  readonly sequence: number;
}

/** A promise the test can resolve from outside, for an acknowledgment. */
class Signal {
  readonly promise: Promise<void>;
  resolve: () => void = () => {};
  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }
}

/**
 * The native side. The bridge's own work is asynchronous, so completion is
 * ACKNOWLEDGED by the fake rather than guessed at: `attached` settles when the
 * listener attach has finished (either way), and `read` settles when the
 * bridge has taken what the startup read returned - at the moment it first
 * touches the sample (a synchronous handler, so it has finished by the time
 * the awaiting test continues) or when the read rejects, after which nothing
 * further can happen.
 */
class FakeNativePlugin {
  private listener: ((geometry: NativeGeometry) => void) | null = null;
  readonly attached = new Signal();
  readonly read = new Signal();
  getResult: () => Promise<NativeGeometry> = () =>
    Promise.reject(new Error("Window insets are not available yet"));
  addListenerResult: () => Promise<void> = () => Promise.resolve();
  readonly get = vi.fn(() =>
    this.getResult().then(
      (geometry): NativeGeometry => {
        const read = this.read;
        return {
          left: geometry.left,
          right: geometry.right,
          sequence: geometry.sequence,
          get width() {
            read.resolve();
            return geometry.width;
          },
        };
      },
      (error: Error) => {
        this.read.resolve();
        throw error;
      },
    ),
  );

  async addListener(
    _event: "change",
    listener: (geometry: NativeGeometry) => void,
  ): Promise<PluginListenerHandle> {
    try {
      await this.addListenerResult();
    } catch (error) {
      this.attached.resolve();
      throw error;
    }
    this.listener = listener;
    this.attached.resolve();
    return { remove: async () => {} };
  }

  emit(geometry: NativeGeometry): void {
    this.listener?.(geometry);
  }
}

const native = vi.hoisted(() => ({ current: null as object | null }));
vi.mock("@capacitor/core", () => ({
  registerPlugin: () => native.current,
}));

let plugin: FakeNativePlugin;
let readSystemGestureInsets: () => SystemGestureInsets;
let insetsReady: () => boolean;
let resetInsets: (() => void) | undefined;
let edgeSwipeDirectionAt: (clientX: number) => "back" | "forward" | null;
const resizeListeners: EventListener[] = [];

function defineWindowNumber(
  name: "innerWidth" | "devicePixelRatio",
  value: number,
) {
  Object.defineProperty(window, name, { value, configurable: true });
}

function resize(width: number): void {
  defineWindowNumber("innerWidth", width);
  window.dispatchEvent(new Event("resize"));
}

/** Native samples carry a window width the conversion must not depend on. */
function sample(left: number, right: number, sequence: number): NativeGeometry {
  return { left, right, width: 800, sequence };
}

async function startFresh(awaitsRead: boolean): Promise<void> {
  vi.resetModules();
  const app = await import("@traycer-clients/gui-app/src/lib/mobile-app");
  app.setMobileAppPlatform("android");
  const store =
    await import("@traycer-clients/gui-app/src/lib/system-gesture-insets");
  readSystemGestureInsets = store.readSystemGestureInsets;
  insetsReady = store.systemGestureInsetsReady;
  // Setting a valid zero is the store's own way back to "known", so a case
  // cannot hand a not-ready Android state to whatever runs after it.
  resetInsets = () => {
    store.setSystemGestureInsets({ left: 0, right: 0 });
  };
  ({ edgeSwipeDirectionAt } =
    await import("@traycer-clients/gui-app/src/lib/edge-swipe-zones"));
  const { startSystemGestureInsets } =
    await import("../src/system-gesture-insets");
  startSystemGestureInsets();
  // The read only starts once the listener has attached; a platform whose
  // attach rejects never reads at all, so it has nothing to wait for.
  await plugin.attached.promise;
  if (awaitsRead) await plugin.read.promise;
}

describe("startSystemGestureInsets", () => {
  beforeEach(() => {
    plugin = new FakeNativePlugin();
    native.current = plugin;
    defineWindowNumber("innerWidth", 400);
    defineWindowNumber("devicePixelRatio", 2);
    // The bridge registers its resize listener for the life of the document;
    // each case owns the listeners it caused and removes them afterwards.
    const add = window.addEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation(
      (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options: boolean | AddEventListenerOptions | undefined,
      ) => {
        if (type === "resize" && typeof listener === "function") {
          resizeListeners.push(listener);
        }
        add(type, listener, options);
      },
    );
  });
  afterEach(() => {
    for (const listener of resizeListeners.splice(0)) {
      window.removeEventListener("resize", listener);
    }
    resetInsets?.();
    vi.restoreAllMocks();
    document.documentElement.style.removeProperty("--safe-area-inset-left");
    document.documentElement.style.removeProperty("--safe-area-inset-right");
  });

  it("converts the native sample to CSS pixels by the device pixel ratio", async () => {
    plugin.getResult = () => Promise.resolve(sample(80, 120, 1));

    await startFresh(true);

    expect(readSystemGestureInsets()).toEqual({ left: 40, right: 60 });
  });

  it("converts by the ratio whatever the viewport width is", async () => {
    defineWindowNumber("devicePixelRatio", 3);
    defineWindowNumber("innerWidth", 1200);
    plugin.getResult = () => Promise.resolve(sample(90, 150, 1));

    await startFresh(true);

    expect(readSystemGestureInsets()).toEqual({ left: 30, right: 50 });
  });

  it("leaves the insets alone when the viewport resizes at a constant ratio", async () => {
    plugin.getResult = () => Promise.resolve(sample(80, 120, 1));
    await startFresh(true);

    resize(200);
    expect(readSystemGestureInsets()).toEqual({ left: 40, right: 60 });

    resize(1000);
    expect(readSystemGestureInsets()).toEqual({ left: 40, right: 60 });
  });

  it("rescales when the ratio itself changes and the window reports a resize", async () => {
    plugin.getResult = () => Promise.resolve(sample(80, 120, 1));
    await startFresh(true);

    defineWindowNumber("devicePixelRatio", 4);
    resize(400);

    expect(readSystemGestureInsets()).toEqual({ left: 20, right: 30 });
  });

  it("takes a later native update", async () => {
    plugin.getResult = () => Promise.resolve(sample(80, 120, 1));
    await startFresh(true);

    plugin.emit(sample(30, 90, 2));

    expect(readSystemGestureInsets()).toEqual({ left: 15, right: 45 });
  });

  // Native knows the new orientation first: its sample describes the rotated
  // window while the WebView still reports the old width. Converting by the
  // ratio is right at once; a width-based scale would be wrong until the
  // resize arrived and wrong again after it.
  it("is right when the native rotation sample arrives before the WebView resizes", async () => {
    plugin.getResult = () => Promise.resolve(sample(80, 120, 1));
    await startFresh(true);

    plugin.emit(sample(30, 90, 2));
    expect(readSystemGestureInsets()).toEqual({ left: 15, right: 45 });

    resize(900);
    expect(readSystemGestureInsets()).toEqual({ left: 15, right: 45 });
  });

  it("is right when the WebView resizes before the native rotation sample arrives", async () => {
    plugin.getResult = () => Promise.resolve(sample(80, 120, 1));
    await startFresh(true);

    resize(900);
    // Still the last native sample, not a rescale of it by the new width.
    expect(readSystemGestureInsets()).toEqual({ left: 40, right: 60 });

    plugin.emit(sample(30, 90, 2));
    expect(readSystemGestureInsets()).toEqual({ left: 15, right: 45 });
  });

  it("ignores a sample older than the newest one it has taken", async () => {
    plugin.getResult = () => Promise.resolve(sample(80, 120, 1));
    await startFresh(true);
    plugin.emit(sample(30, 90, 5));

    plugin.emit(sample(200, 200, 4));

    expect(readSystemGestureInsets()).toEqual({ left: 15, right: 45 });
    // And a later resize keeps the newest sample, not the stale one.
    resize(200);
    expect(readSystemGestureInsets()).toEqual({ left: 15, right: 45 });
  });

  // The startup read can resolve after a change event already delivered newer
  // geometry; the read must not overwrite it.
  it("does not let a slow startup read overwrite a newer event", async () => {
    let resolveRead: (value: NativeGeometry) => void = () => {};
    plugin.getResult = () =>
      new Promise<NativeGeometry>((resolve) => {
        resolveRead = resolve;
      });
    // The read is held open, so only the attach is awaited; the bridge asks
    // for the read once it is attached, and that call is what is waited for.
    await startFresh(false);
    await vi.waitFor(() => {
      expect(plugin.get).toHaveBeenCalled();
    });
    plugin.emit(sample(30, 90, 7));

    resolveRead(sample(80, 120, 3));
    await plugin.read.promise;

    expect(readSystemGestureInsets()).toEqual({ left: 15, right: 45 });
  });

  it("accepts a sample whose sequence equals the current one", async () => {
    plugin.getResult = () => Promise.resolve(sample(80, 120, 3));
    await startFresh(true);

    plugin.emit(sample(40, 60, 3));

    expect(readSystemGestureInsets()).toEqual({ left: 20, right: 30 });
  });

  it("leaves the insets at zero while the native side is not ready, then takes the first event", async () => {
    await startFresh(true);
    expect(readSystemGestureInsets()).toEqual({ left: 0, right: 0 });
    // Zones fail closed rather than guess an OS strip of zero.
    expect(edgeSwipeDirectionAt(8)).toBeNull();

    plugin.emit(sample(80, 120, 1));

    expect(readSystemGestureInsets()).toEqual({ left: 40, right: 60 });
    expect(edgeSwipeDirectionAt(50)).toBe("back");
  });

  it("does not move the insets on a resize before any geometry has arrived", async () => {
    await startFresh(true);

    resize(300);

    expect(readSystemGestureInsets()).toEqual({ left: 0, right: 0 });
  });

  // iOS has no implementation behind the plugin name: every call rejects. That
  // must leave the insets at the zero that preserves the old geometry, and
  // nothing may surface as an unhandled rejection (vitest fails the run on one).
  it("leaves the insets at zero when the platform implements nothing", async () => {
    plugin.addListenerResult = () =>
      Promise.reject(
        new Error('"SystemGestureInsets" plugin is not implemented'),
      );
    plugin.getResult = () =>
      Promise.reject(
        new Error('"SystemGestureInsets" plugin is not implemented'),
      );

    await startFresh(false);
    resize(500);

    expect(readSystemGestureInsets()).toEqual({ left: 0, right: 0 });
  });

  // Unknown and a valid zero read the same numbers and are opposite answers:
  // zero is "the OS owns no strip", unknown is "the OS may own one we have not
  // been told about". Android leaves the band closed until native has spoken.
  it("keeps the band closed until the first sample, which a valid zero then opens", async () => {
    await startFresh(true);
    expect(insetsReady()).toBe(false);
    expect(readSystemGestureInsets()).toEqual({ left: 0, right: 0 });
    expect(edgeSwipeDirectionAt(8)).toBeNull();

    plugin.emit(sample(0, 0, 1));

    expect(insetsReady()).toBe(true);
    expect(readSystemGestureInsets()).toEqual({ left: 0, right: 0 });
    expect(edgeSwipeDirectionAt(8)).toBe("back");
  });

  it("leaves a platform that never starts the bridge on the original band", async () => {
    vi.resetModules();
    ({ edgeSwipeDirectionAt } =
      await import("@traycer-clients/gui-app/src/lib/edge-swipe-zones"));

    expect(edgeSwipeDirectionAt(8)).toBe("back");
  });

  it("stays closed on Android when the native side never answers", async () => {
    plugin.addListenerResult = () =>
      Promise.reject(new Error("not implemented"));
    await startFresh(false);

    expect(insetsReady()).toBe(false);
    expect(edgeSwipeDirectionAt(8)).toBeNull();
  });

  // A sample with no usable width is not geometry, so it must not become the
  // newest one either: if it did, its sequence would make every real sample
  // that follows look stale.
  it("does not let a sample with no width take the newest sequence", async () => {
    plugin.getResult = () => Promise.resolve(sample(80, 120, 1));
    await startFresh(true);
    plugin.emit(sample(30, 90, 5));

    plugin.emit({ left: 200, right: 200, width: 0, sequence: 9 });
    expect(readSystemGestureInsets()).toEqual({ left: 15, right: 45 });

    plugin.emit(sample(60, 60, 6));
    expect(readSystemGestureInsets()).toEqual({ left: 30, right: 30 });
  });

  // The CSS safe area has its own cache that only a viewport event retires. A
  // native sample can land at the same viewport width with the CSS inset
  // changed underneath it (the housing moved with no resize), and the zones it
  // feeds must be measured from the CSS inset as it is now, not as it was when
  // the cache warmed.
  it("measures the zones from the CSS safe area as it is now, at an unchanged width", async () => {
    plugin.getResult = () => Promise.resolve(sample(0, 0, 1));
    await startFresh(true);
    document.documentElement.style.setProperty(
      "--safe-area-inset-left",
      "60px",
    );
    window.dispatchEvent(new Event("resize"));
    expect(edgeSwipeDirectionAt(30)).toBeNull();
    expect(edgeSwipeDirectionAt(70)).toBe("back");

    document.documentElement.style.setProperty(
      "--safe-area-inset-left",
      "10px",
    );
    plugin.emit(sample(0, 0, 2));

    expect(edgeSwipeDirectionAt(30)).toBe("back");
    expect(edgeSwipeDirectionAt(70)).toBeNull();
  });
});
