import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { Terminal, type IDisposable, type IEvent } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { CanvasAddon } from "@xterm/addon-canvas";
import {
  __disposeAllXtermHostsForTests,
  acquireXtermHost,
  createXtermRendererController,
  releaseXtermHost,
  XTERM_CANVAS_DISPOSE_DELAY_MS,
  type XtermHostEntry,
  type XtermRendererController,
} from "@/components/epic-canvas/renderers/xterm-host-registry";
import { disposeAllTerminalSessions } from "@/lib/registries/terminal-session-registry";

function unusedCanvasEvent(): IEvent<HTMLCanvasElement> {
  const subscribe: IEvent<HTMLCanvasElement> = (): IDisposable => ({
    dispose: () => undefined,
  });
  return subscribe;
}

/**
 * jsdom has no canvas backend here, so this is not `@xterm/addon-canvas`.
 * When `container` is provided it models xterm's `BaseRenderLayer` DOM
 * contract: `_container.appendChild(this._canvas)` on construct,
 * `this._canvas.remove()` on dispose.
 */
function createFakeCanvasAddon(container: HTMLElement | null): {
  readonly addon: CanvasAddon;
  readonly dispose: Mock<() => void>;
} {
  const canvasEl = document.createElement("canvas");
  if (container !== null) {
    container.appendChild(canvasEl);
  }
  const dispose: Mock<() => void> = vi.fn(() => {
    if (dispose.mock.calls.length > 1) {
      throw new Error("CanvasAddon.dispose called twice");
    }
    canvasEl.remove();
  });
  const addon: CanvasAddon = {
    dispose,
    activate: (_terminal: Terminal) => undefined,
    clearTextureAtlas: () => undefined,
    onChangeTextureAtlas: unusedCanvasEvent(),
    onAddTextureAtlasCanvas: unusedCanvasEvent(),
  };
  return { addon, dispose };
}

function createTrackedController(container: HTMLElement | null): {
  readonly controller: XtermRendererController;
  readonly loadCanvasAddon: Mock<() => CanvasAddon | null>;
  readonly refreshAllRows: Mock<() => void>;
} {
  const loadCanvasAddon = vi.fn(
    (): CanvasAddon | null => createFakeCanvasAddon(container).addon,
  );
  const refreshAllRows = vi.fn(() => undefined);
  return {
    controller: createXtermRendererController({
      loadCanvasAddon,
      refreshAllRows,
    }),
    loadCanvasAddon,
    refreshAllRows,
  };
}

function makeCanvasHostEntry(): XtermHostEntry {
  const containerEl = document.createElement("div");
  const term = new Terminal();
  const rendererController = createXtermRendererController({
    loadCanvasAddon: () => createFakeCanvasAddon(containerEl).addon,
    refreshAllRows: () => undefined,
  });
  return {
    sessionId: "session-canvas",
    hostId: "host-1",
    containerEl,
    term,
    fitAddon: new FitAddon(),
    searchAddon: new SearchAddon(),
    rendererController,
    writerProxy: () => undefined,
    live: {
      onUserInput: () => undefined,
      onContainerResize: () => undefined,
      openLink: () => undefined,
      getFindTargetId: () => null,
      onSearchResults: () => undefined,
    },
    controls: {
      fitToContainer: () => undefined,
      reconcileWithHost: () => undefined,
    },
    disposeEngine: vi.fn(() => {
      rendererController.dispose();
      term.dispose();
    }),
  };
}

afterEach(() => {
  __disposeAllXtermHostsForTests();
  disposeAllTerminalSessions();
  vi.useRealTimers();
});

describe("createXtermRendererController", () => {
  it("reattach after grace loads a new canvas addon and refreshes all rows", () => {
    // Invariant 1: Reattach paints with the canvas renderer.
    vi.useFakeTimers();
    const { controller, loadCanvasAddon, refreshAllRows } =
      createTrackedController(null);

    expect(controller.currentCanvas()).toBeNull();
    expect(loadCanvasAddon).toHaveBeenCalledTimes(0);
    expect(refreshAllRows).toHaveBeenCalledTimes(0);

    controller.present();
    const first = controller.currentCanvas();
    expect(first).not.toBeNull();
    expect(loadCanvasAddon).toHaveBeenCalledTimes(1);
    expect(refreshAllRows).toHaveBeenCalledTimes(1);

    controller.unpresent();
    expect(controller.currentCanvas()).toBe(first);

    vi.advanceTimersByTime(XTERM_CANVAS_DISPOSE_DELAY_MS);
    expect(controller.currentCanvas()).toBeNull();

    controller.present();
    const second = controller.currentCanvas();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(loadCanvasAddon).toHaveBeenCalledTimes(2);
    expect(refreshAllRows).toHaveBeenCalledTimes(2);
  });

  it("unpresented engine holds no canvas addon or canvas DOM after the grace", () => {
    // Invariant 2: Unpresented engines hold no canvas.
    vi.useFakeTimers();
    const container = document.createElement("div");
    const { controller } = createTrackedController(container);

    expect(controller.currentCanvas()).toBeNull();
    expect(container.querySelectorAll("canvas")).toHaveLength(0);

    controller.present();
    expect(controller.currentCanvas()).not.toBeNull();
    expect(container.querySelectorAll("canvas").length).toBeGreaterThan(0);

    controller.unpresent();
    expect(controller.currentCanvas()).not.toBeNull();
    expect(container.querySelectorAll("canvas").length).toBeGreaterThan(0);

    vi.advanceTimersByTime(XTERM_CANVAS_DISPOSE_DELAY_MS);
    expect(controller.currentCanvas()).toBeNull();
    expect(container.querySelectorAll("canvas")).toHaveLength(0);
  });

  it("a flicker inside the grace keeps the same canvas addon and does not load another", () => {
    // Invariant 3: A flicker within the grace costs nothing.
    vi.useFakeTimers();
    const { controller, loadCanvasAddon, refreshAllRows } =
      createTrackedController(null);

    controller.present();
    const first = controller.currentCanvas();
    expect(first).not.toBeNull();
    expect(loadCanvasAddon).toHaveBeenCalledTimes(1);
    expect(refreshAllRows).toHaveBeenCalledTimes(1);

    controller.unpresent();
    vi.advanceTimersByTime(XTERM_CANVAS_DISPOSE_DELAY_MS - 1);
    expect(controller.currentCanvas()).toBe(first);
    expect(loadCanvasAddon).toHaveBeenCalledTimes(1);

    controller.present();
    expect(controller.currentCanvas()).toBe(first);
    expect(loadCanvasAddon).toHaveBeenCalledTimes(1);
    expect(refreshAllRows).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2);
    expect(controller.currentCanvas()).toBe(first);
    expect(loadCanvasAddon).toHaveBeenCalledTimes(1);
  });

  it("overlapping presented mounts keep the canvas live after one presented release", () => {
    // Invariant 4: Overlapping mounts do not flip the state.
    vi.useFakeTimers();
    const instanceId = "overlap-instance";
    const entry = acquireXtermHost(instanceId, makeCanvasHostEntry);
    entry.rendererController.present();
    const reused = acquireXtermHost(instanceId, () => {
      throw new Error("second mount must reuse the engine");
    });
    expect(reused).toBe(entry);
    reused.rendererController.present();

    const canvasBefore = entry.rendererController.currentCanvas();
    expect(canvasBefore).not.toBeNull();

    releaseXtermHost(instanceId, true, true);
    vi.advanceTimersByTime(XTERM_CANVAS_DISPOSE_DELAY_MS);
    expect(entry.rendererController.currentCanvas()).toBe(canvasBefore);

    // The first release must have dropped exactly one presented mount: a
    // remaining unpresent is what finally arms disposal. If the release was a
    // no-op, this unpresent would leave the count at 1 and the canvas would
    // still be live after the grace.
    entry.rendererController.unpresent();
    expect(entry.rendererController.currentCanvas()).toBe(canvasBefore);
    vi.advanceTimersByTime(XTERM_CANVAS_DISPOSE_DELAY_MS);
    expect(entry.rendererController.currentCanvas()).toBeNull();
  });

  it("dispose is idempotent while a grace timer is pending and the timer is a no-op", () => {
    // Invariant 6: Disposal is idempotent under teardown.
    vi.useFakeTimers();
    const fake = createFakeCanvasAddon(null);
    const loadCanvasAddon = vi.fn((): CanvasAddon | null => fake.addon);
    const controller = createXtermRendererController({
      loadCanvasAddon,
      refreshAllRows: () => undefined,
    });

    controller.present();
    expect(controller.currentCanvas()).toBe(fake.addon);
    expect(fake.dispose).toHaveBeenCalledTimes(0);

    controller.unpresent();
    expect(fake.dispose).toHaveBeenCalledTimes(0);

    controller.dispose();
    expect(fake.dispose).toHaveBeenCalledTimes(1);
    expect(controller.currentCanvas()).toBeNull();

    expect(() => {
      vi.advanceTimersByTime(XTERM_CANVAS_DISPOSE_DELAY_MS);
    }).not.toThrow();
    expect(fake.dispose).toHaveBeenCalledTimes(1);

    controller.dispose();
    controller.present();
    controller.unpresent();
    expect(fake.dispose).toHaveBeenCalledTimes(1);
    expect(loadCanvasAddon).toHaveBeenCalledTimes(1);
    expect(controller.currentCanvas()).toBeNull();
  });

  it("loads the addon before refreshing, and refreshes only after it is installed", () => {
    // Invariant 1, the ordering half. Final call counts cannot tell
    // load-then-refresh from refresh-then-load; only the callback ORDER can,
    // and only reading the controller from inside the refresh callback shows
    // that the addon was already installed when the repaint was asked for.
    const calls: string[] = [];
    let canvasDuringRefresh: CanvasAddon | null | "not-called" = "not-called";
    let controller: XtermRendererController | null = null;
    const loaded = createFakeCanvasAddon(null).addon;
    controller = createXtermRendererController({
      loadCanvasAddon: () => {
        calls.push("load");
        return loaded;
      },
      refreshAllRows: () => {
        calls.push("refresh");
        canvasDuringRefresh = controller?.currentCanvas() ?? null;
      },
    });

    expect(calls).toEqual([]);
    expect(canvasDuringRefresh).toBe("not-called");

    controller.present();

    expect(calls).toEqual(["load", "refresh"]);
    // The repaint was requested against the installed addon, not ahead of it.
    expect(canvasDuringRefresh).toBe(loaded);
  });

  it("reports the renderer as unsettled only between disposal and the next present", () => {
    // Finding 1's gate at the controller boundary: `isRendererSettled()` is
    // what stops a grid measured through the temporary DOM renderer reaching
    // the host.
    vi.useFakeTimers();
    const { controller } = createTrackedController(null);

    // Before the first present the engine could still get a canvas, so no
    // measurement it takes now is the one it will agree with later.
    expect(controller.isRendererSettled()).toBe(false);

    controller.present();
    expect(controller.isRendererSettled()).toBe(true);

    controller.unpresent();
    // Still settled through the grace - the canvas renderer is still installed.
    expect(controller.isRendererSettled()).toBe(true);

    vi.advanceTimersByTime(XTERM_CANVAS_DISPOSE_DELAY_MS);
    expect(controller.isRendererSettled()).toBe(false);

    controller.present();
    expect(controller.isRendererSettled()).toBe(true);
  });

  it("a null canvas loader is latched and never retried", () => {
    const loadCanvasAddon = vi.fn((): CanvasAddon | null => null);
    const refreshAllRows = vi.fn(() => undefined);
    const controller = createXtermRendererController({
      loadCanvasAddon,
      refreshAllRows,
    });

    expect(loadCanvasAddon).toHaveBeenCalledTimes(0);
    controller.present();
    expect(loadCanvasAddon).toHaveBeenCalledTimes(1);
    expect(controller.currentCanvas()).toBeNull();
    expect(refreshAllRows).toHaveBeenCalledTimes(0);

    controller.present();
    controller.unpresent();
    controller.present();
    expect(loadCanvasAddon).toHaveBeenCalledTimes(1);
    expect(controller.currentCanvas()).toBeNull();
    expect(refreshAllRows).toHaveBeenCalledTimes(0);
    // A permanently DOM-rendered engine is SETTLED: nothing will swap under it,
    // so its grid measurements stay self-consistent and may still be reported.
    // (The rollback the loader owes before returning null is production's job
    // and is pinned against the real catch in
    // terminal-xterm-host-presentation.test.tsx.)
    expect(controller.isRendererSettled()).toBe(true);
  });
});
