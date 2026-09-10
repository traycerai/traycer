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
    previewScale: 1,
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

afterEach(cleanup);

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
    expect(resize).toHaveBeenCalledWith(500, 844);

    fireEvent.focus(width);
    fireEvent.change(width, { target: { value: "600" } });
    fireEvent.blur(width);
    expect(resize).toHaveBeenCalledWith(600, 844);

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
    expect(resize).not.toHaveBeenCalledWith(500, 844);

    fireEvent.focus(width);
    fireEvent.change(width, { target: { value: "600" } });
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Viewport dimensions" }),
      { button: 0 },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Desktop/ }));
    await act(() => Promise.resolve());
    expect(resize).toHaveBeenCalledWith(1440, 900);
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
    expect(resize).toHaveBeenCalledWith(844, 390);
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
});
