import "../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserViewportState } from "@traycer/protocol/host/browser/viewport";
import { BrowserViewportHandles } from "@/components/browser-tile/browser-viewport-handles";
import { BrowserViewportToolbar } from "@/components/browser-tile/browser-viewport-toolbar";
import type { BrowserViewportController } from "@/components/browser-tile/use-browser-viewport";

function viewportState(
  width: number,
  height: number,
  mode: "fixed" | "fit",
): BrowserViewportState {
  return {
    sessionId: "session-1",
    tabId: "tab-1",
    intent: mode === "fixed" ? { mode, width, height } : { mode },
    applied: mode === "fixed" ? { width, height, dpr: 1 } : null,
    revision: 1,
    source: "user",
    fitOwnerId: null,
  };
}

function makeController(
  overrides: Partial<BrowserViewportController>,
): BrowserViewportController {
  const state = overrides.state ?? viewportState(390, 844, "fixed");
  return {
    state,
    size: overrides.size === undefined ? state.applied : overrides.size,
    expanded: true,
    pending: false,
    disabled: false,
    error: null,
    dismissError: vi.fn(),
    previewScale: 1,
    previewScaleSetting: null,
    setPreviewScale: vi.fn(),
    previewOrigin: null,
    ratioLocked: false,
    ratio: null,
    resizeScale: 1,
    setRatio: vi.fn(),
    fitOwnedHere: true,
    open: vi.fn(),
    reset: vi.fn<BrowserViewportController["reset"]>(() => Promise.resolve()),
    resize: vi.fn<BrowserViewportController["resize"]>(() => Promise.resolve()),
    setRatioLocked: vi.fn(),
    claim: vi.fn(),
    setTrigger: vi.fn(),
    ...overrides,
  };
}

function renderToolbar(controller: BrowserViewportController): void {
  render(<BrowserViewportToolbar controller={controller} />);
}

function dimensionInput(axis: "width" | "height"): HTMLInputElement {
  const input = screen.getByRole("spinbutton", { name: `Viewport ${axis}` });
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`expected ${axis} viewport input`);
  }
  return input;
}

function handlesScrollRef(clientWidth: number): { current: HTMLDivElement } {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { value: clientWidth });
  Object.defineProperty(element, "clientHeight", { value: 700 });
  return { current: element };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BrowserViewportToolbar", () => {
  it("keeps a focused draft while an agent update replaces the host state", () => {
    const controller = makeController({});
    const view = render(<BrowserViewportToolbar controller={controller} />);

    const width = dimensionInput("width");
    fireEvent.focus(width);
    fireEvent.change(width, { target: { value: "500" } });

    const updated = makeController({
      state: viewportState(412, 915, "fixed"),
      size: { width: 412, height: 915 },
      resize: controller.resize,
    });
    view.rerender(<BrowserViewportToolbar controller={updated} />);

    expect(dimensionInput("width").value).toBe("500");
    expect(dimensionInput("height").value).toBe("844");
  });

  it("commits on Enter and blur, while Escape cancels the draft", () => {
    const resize = vi.fn<BrowserViewportController["resize"]>(() =>
      Promise.resolve(),
    );
    const controller = makeController({ resize });
    renderToolbar(controller);
    const width = dimensionInput("width");

    fireEvent.focus(width);
    fireEvent.change(width, { target: { value: "500" } });
    fireEvent.keyDown(width, { key: "Enter" });
    expect(resize).toHaveBeenCalledWith(500, 844, null);

    fireEvent.focus(width);
    fireEvent.change(width, { target: { value: "600" } });
    fireEvent.blur(width);
    expect(resize).toHaveBeenCalledWith(600, 844, null);

    fireEvent.focus(width);
    fireEvent.change(width, { target: { value: "700" } });
    fireEvent.keyDown(width, { key: "Escape" });
    expect(resize).toHaveBeenCalledTimes(2);
    expect(width.value).toBe("390");
  });

  it("does not commit a stale draft when Reset to Fit or a preset is chosen", async () => {
    const resize = vi.fn<BrowserViewportController["resize"]>(() =>
      Promise.resolve(),
    );
    const reset = vi.fn<BrowserViewportController["reset"]>(() =>
      Promise.resolve(),
    );
    const controller = makeController({ resize, reset });
    renderToolbar(controller);
    const width = dimensionInput("width");
    fireEvent.focus(width);
    fireEvent.change(width, { target: { value: "500" } });

    fireEvent.click(screen.getByRole("button", { name: "Reset to Fit" }));
    await act(() => Promise.resolve());
    expect(reset).toHaveBeenCalledOnce();
    expect(resize).not.toHaveBeenCalledWith(500, 844, null);

    fireEvent.focus(width);
    fireEvent.change(width, { target: { value: "600" } });
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Viewport dimensions" }),
      { button: 0 },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Desktop/ }));
    await act(() => Promise.resolve());
    expect(resize).toHaveBeenCalledWith(1440, 900, null);
  });

  it("latches ratio edits and rotates from the current host size", async () => {
    const resize = vi.fn<BrowserViewportController["resize"]>(() =>
      Promise.resolve(),
    );
    const setRatioLocked = vi.fn();
    const controller = makeController({ resize, setRatioLocked });
    const view = render(<BrowserViewportToolbar controller={controller} />);

    fireEvent.click(screen.getByRole("button", { name: "Lock aspect ratio" }));
    expect(setRatioLocked).toHaveBeenCalledWith(true);
    view.rerender(
      <BrowserViewportToolbar
        controller={makeController({
          resize,
          ratioLocked: true,
          ratio: 390 / 844,
          setRatioLocked,
        })}
      />,
    );
    fireEvent.focus(screen.getByRole("spinbutton", { name: "Viewport width" }));
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Viewport width" }),
      {
        target: { value: "780" },
      },
    );
    expect(dimensionInput("height").value).toBe("1688");

    fireEvent.click(screen.getByRole("button", { name: "Rotate viewport" }));
    await act(() => Promise.resolve());
    expect(resize).toHaveBeenCalledWith(844, 390, null);
  });

  it("ignores a superseded resize result", async () => {
    const rejectors: Array<(error: Error) => void> = [];
    const resize = vi.fn<BrowserViewportController["resize"]>(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectors.push(reject);
        }),
    );
    const controller = makeController({ resize });
    renderToolbar(controller);
    const width = dimensionInput("width");
    fireEvent.focus(width);
    fireEvent.change(width, { target: { value: "500" } });
    fireEvent.keyDown(width, { key: "Enter" });
    fireEvent.focus(width);
    fireEvent.change(width, { target: { value: "600" } });
    fireEvent.keyDown(width, { key: "Enter" });
    await act(async () => {
      rejectors[0]?.(new Error("stale"));
      await Promise.resolve();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("coalesces handle moves and abandons the focused draft before dragging", () => {
    let flushFrame: ((time: number) => void) | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      flushFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
    const resize = vi.fn<BrowserViewportController["resize"]>(() =>
      Promise.resolve(),
    );
    const controller = makeController({ resize, resizeScale: 2 });
    render(
      <>
        <BrowserViewportToolbar controller={controller} />
        <BrowserViewportHandles
          controller={controller}
          scrollRef={handlesScrollRef(1048)}
        />
      </>,
    );

    const width = dimensionInput("width");
    act(() => {
      width.focus();
    });
    expect(document.activeElement).toBe(width);
    fireEvent.change(width, { target: { value: "500" } });
    const handle = screen.getByRole("separator", {
      name: "Resize viewport width",
    });
    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    expect(document.activeElement).toBe(handle);
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      clientX: 20,
      clientY: 10,
    });
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      clientX: 30,
      clientY: 10,
    });

    expect(resize).not.toHaveBeenCalled();
    act(() => {
      flushFrame?.(0);
    });
    expect(resize).toHaveBeenCalledOnce();
    expect(resize).toHaveBeenCalledWith(400, 844, expect.any(Object));
  });

  it("flushes the final pointer move on pointerup and ignores its queued frame", () => {
    let flushFrame: ((time: number) => void) | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      flushFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
    const resize = vi.fn<BrowserViewportController["resize"]>(() =>
      Promise.resolve(),
    );
    const controller = makeController({ resize, resizeScale: 2 });
    render(
      <BrowserViewportHandles
        controller={controller}
        scrollRef={handlesScrollRef(1048)}
      />,
    );
    const handle = screen.getByRole("separator", {
      name: "Resize viewport width",
    });

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      clientX: 30,
      clientY: 10,
    });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(resize).toHaveBeenCalledOnce();
    expect(resize).toHaveBeenCalledWith(400, 844, expect.any(Object));
    act(() => {
      flushFrame?.(0);
    });
    expect(resize).toHaveBeenCalledOnce();
  });

  it("does not replay a pointer move after pointerup and a newer reset", () => {
    let flushFrame: ((time: number) => void) | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      flushFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
    const resize = vi.fn<BrowserViewportController["resize"]>(() =>
      Promise.resolve(),
    );
    const reset = vi.fn<BrowserViewportController["reset"]>(() =>
      Promise.resolve(),
    );
    const controller = makeController({ resize, reset, resizeScale: 2 });
    render(
      <>
        <BrowserViewportToolbar controller={controller} />
        <BrowserViewportHandles
          controller={controller}
          scrollRef={handlesScrollRef(1048)}
        />
      </>,
    );
    const handle = screen.getByRole("separator", {
      name: "Resize viewport width",
    });

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      clientX: 30,
      clientY: 10,
    });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Reset to Fit" }));
    act(() => {
      flushFrame?.(0);
    });

    expect(reset).toHaveBeenCalledOnce();
    expect(resize).toHaveBeenCalledOnce();
    expect(resize).toHaveBeenCalledWith(400, 844, expect.any(Object));
  });

  it("drops a queued move on pointercancel", () => {
    let flushFrame: ((time: number) => void) | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      flushFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
    const resize = vi.fn<BrowserViewportController["resize"]>(() =>
      Promise.resolve(),
    );
    const controller = makeController({ resize, resizeScale: 2 });
    render(
      <BrowserViewportHandles
        controller={controller}
        scrollRef={handlesScrollRef(1048)}
      />,
    );
    const handle = screen.getByRole("separator", {
      name: "Resize viewport width",
    });

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      clientX: 30,
      clientY: 10,
    });
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    act(() => {
      flushFrame?.(0);
    });

    expect(resize).not.toHaveBeenCalled();
  });

  it("drops a queued move when pointer capture is lost", () => {
    let flushFrame: ((time: number) => void) | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      flushFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
    const resize = vi.fn<BrowserViewportController["resize"]>(() =>
      Promise.resolve(),
    );
    const controller = makeController({ resize, resizeScale: 2 });
    render(
      <BrowserViewportHandles
        controller={controller}
        scrollRef={handlesScrollRef(1048)}
      />,
    );
    const handle = screen.getByRole("separator", {
      name: "Resize viewport width",
    });

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      clientX: 30,
      clientY: 10,
    });
    fireEvent.lostPointerCapture(handle, { pointerId: 1 });
    act(() => {
      flushFrame?.(0);
    });

    expect(resize).not.toHaveBeenCalled();
  });

  it("cancels a queued drag before sending a keyboard step", () => {
    let flushFrame: ((time: number) => void) | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      flushFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
    const resize = vi.fn<BrowserViewportController["resize"]>(() =>
      Promise.resolve(),
    );
    const controller = makeController({ resize, resizeScale: 2 });
    render(
      <BrowserViewportHandles
        controller={controller}
        scrollRef={handlesScrollRef(1048)}
      />,
    );
    const handle = screen.getByRole("separator", {
      name: "Resize viewport width",
    });

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      clientX: 30,
      clientY: 10,
    });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    act(() => {
      flushFrame?.(0);
    });

    expect(resize).toHaveBeenCalledOnce();
    expect(resize).toHaveBeenCalledWith(391, 844, null);
  });

  it("increments keyboard steps from the pending size while acknowledgements are held", async () => {
    const acknowledgements: Array<() => void> = [];
    const rejectors: Array<(error: Error) => void> = [];
    const resize = vi.fn<BrowserViewportController["resize"]>(
      () =>
        new Promise<void>((resolve, reject) => {
          acknowledgements.push(resolve);
          rejectors.push(reject);
        }),
    );
    const controller = makeController({ resize });
    render(
      <BrowserViewportHandles
        controller={controller}
        scrollRef={handlesScrollRef(1048)}
      />,
    );
    const handle = screen.getByRole("separator", {
      name: "Resize viewport width",
    });

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });

    expect(resize.mock.calls.map(([width, height]) => [width, height])).toEqual(
      [
        [391, 844],
        [392, 844],
        [393, 844],
      ],
    );
    await act(async () => {
      rejectors[0]?.(new Error("older keyboard request"));
      await Promise.resolve();
    });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(resize).toHaveBeenLastCalledWith(394, 844, null);

    await act(async () => {
      acknowledgements[3]?.();
      await Promise.resolve();
    });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(resize).toHaveBeenLastCalledWith(391, 844, null);
    acknowledgements.forEach((resolve) => resolve());
  });

  it("resizes from the left and from an unlocked lower corner", () => {
    let flushFrame: ((time: number) => void) | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      flushFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
    const resize = vi.fn<BrowserViewportController["resize"]>(() =>
      Promise.resolve(),
    );
    const controller = makeController({ resize });
    render(
      <BrowserViewportHandles
        controller={controller}
        scrollRef={handlesScrollRef(1048)}
      />,
    );

    const left = screen.getByRole("separator", {
      name: "Resize viewport width from left",
    });
    fireEvent.pointerDown(left, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(left, {
      pointerId: 1,
      clientX: 0,
      clientY: 10,
    });
    act(() => {
      flushFrame?.(0);
    });
    expect(resize).toHaveBeenCalledWith(400, 844, expect.any(Object));

    const corner = screen.getByRole("button", {
      name: "Resize viewport from bottom left",
    });
    fireEvent.pointerDown(corner, {
      button: 0,
      pointerId: 2,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(corner, {
      pointerId: 2,
      clientX: 0,
      clientY: 20,
    });
    act(() => {
      flushFrame?.(0);
    });
    expect(resize).toHaveBeenCalledWith(400, 854, expect.any(Object));
  });

  it("uses the dominant axis to preserve ratio from a locked corner", () => {
    let flushFrame: ((time: number) => void) | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      flushFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
    const resize = vi.fn<BrowserViewportController["resize"]>(() =>
      Promise.resolve(),
    );
    const controller = makeController({
      resize,
      ratioLocked: true,
      ratio: 390 / 844,
    });
    render(
      <BrowserViewportHandles
        controller={controller}
        scrollRef={handlesScrollRef(1048)}
      />,
    );

    const corner = screen.getByRole("button", {
      name: "Resize viewport from bottom right",
    });
    fireEvent.pointerDown(corner, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(corner, {
      pointerId: 1,
      clientX: 20,
      clientY: 20,
    });
    act(() => {
      flushFrame?.(0);
    });

    expect(resize).toHaveBeenCalledOnce();
    expect(resize).toHaveBeenCalledWith(400, 866, expect.any(Object));
  });

  it("freezes AutoFit scale and preserves both horizontal drag edges", () => {
    let flushFrame: ((time: number) => void) | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      flushFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
    const resize = vi.fn<BrowserViewportController["resize"]>(() =>
      Promise.resolve(),
    );
    const setPreviewScale = vi.fn();
    const controller = makeController({
      resize,
      previewScale: 1,
      previewScaleSetting: null,
      size: { width: 300, height: 600 },
      resizeScale: 1,
      setPreviewScale,
    });
    const scrollRef = handlesScrollRef(500);
    render(
      <div data-testid="viewport-frame">
        <BrowserViewportHandles controller={controller} scrollRef={scrollRef} />
      </div>,
    );
    const frame = screen.getByTestId("viewport-frame");
    Object.defineProperty(frame, "getBoundingClientRect", {
      value: () => ({
        bottom: 700,
        height: 600,
        left: 100,
        right: 400,
        top: 100,
        width: 300,
        x: 100,
        y: 100,
      }),
    });

    const right = screen.getByRole("separator", {
      name: "Resize viewport width",
    });
    fireEvent.pointerDown(right, {
      button: 0,
      pointerId: 1,
      clientX: 100,
      clientY: 10,
    });
    fireEvent.pointerMove(right, {
      pointerId: 1,
      clientX: 175,
      clientY: 10,
    });
    act(() => {
      flushFrame?.(0);
    });
    fireEvent.pointerUp(right, { pointerId: 1 });

    expect(setPreviewScale).toHaveBeenCalledWith(1);
    expect(resize).toHaveBeenCalledWith(
      375,
      600,
      expect.objectContaining({
        anchor: 0,
        availableHeight: 652,
        availableWidth: 452,
        scrollLeft: 0,
        scrollTop: 0,
        x: 76,
      }),
    );

    const left = screen.getByRole("separator", {
      name: "Resize viewport width from left",
    });
    fireEvent.pointerDown(left, {
      button: 0,
      pointerId: 2,
      clientX: 100,
      clientY: 10,
    });
    fireEvent.pointerMove(left, {
      pointerId: 2,
      clientX: 75,
      clientY: 10,
    });
    act(() => {
      flushFrame?.(0);
    });
    fireEvent.pointerMove(left, {
      pointerId: 2,
      clientX: 125,
      clientY: 10,
    });
    act(() => {
      flushFrame?.(0);
    });

    expect(resize).toHaveBeenCalledWith(
      325,
      600,
      expect.objectContaining({
        anchor: 1,
        availableHeight: 652,
        availableWidth: 452,
        scrollLeft: 0,
        scrollTop: 0,
        x: 376,
      }),
    );
    expect(resize).toHaveBeenLastCalledWith(
      275,
      600,
      expect.objectContaining({
        anchor: 1,
        availableHeight: 652,
        availableWidth: 452,
        scrollLeft: 0,
        scrollTop: 0,
        x: 376,
      }),
    );
  });
});
