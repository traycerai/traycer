/**
 * The native window background sync: the colour behind the page and the
 * status-bar icon style follow what the page draws at its edge.
 *
 * The document is a real jsdom one, so the theme attribute, the custom
 * properties and the mounted surfaces are the page's own. Only the animation
 * frame (flushed by hand) and the colour resolver (a lookup) are stubbed.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  barStyleForBackground,
  startWindowBackgroundSync,
  type WindowBarStyle,
} from "../src/window-background";

const CANVAS_LIGHT = "#ffffff";
const CANVAS_DARK = "#18181b";
const GROUND = "#09090b";

describe("barStyleForBackground", () => {
  it("picks DARK for a dark colour", () => {
    expect(barStyleForBackground("#09090b")).toBe("DARK");
    expect(barStyleForBackground("#000000")).toBe("DARK");
  });

  it("picks LIGHT for a light colour", () => {
    expect(barStyleForBackground("#ffffff")).toBe("LIGHT");
    expect(barStyleForBackground("#f4f4f5")).toBe("LIGHT");
  });
});

describe("startWindowBackgroundSync", () => {
  let frames: FrameRequestCallback[];

  const flushFrames = (): void => {
    const pending = frames;
    frames = [];
    for (const frame of pending) frame(0);
  };

  const setTheme = (theme: "light" | "dark"): void => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.setProperty(
      "--canvas",
      theme === "light" ? CANVAS_LIGHT : CANVAS_DARK,
    );
  };

  const start = (): {
    setBackground: Mock<(color: string) => void>;
    setBarStyle: Mock<(style: WindowBarStyle) => void>;
  } => {
    const setBackground = vi.fn<(color: string) => void>();
    const setBarStyle = vi.fn<(style: WindowBarStyle) => void>();
    startWindowBackgroundSync({
      document,
      setBackground,
      setBarStyle,
      toHex: (cssColor) => cssColor.trim(),
    });
    return { setBackground, setBarStyle };
  };

  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    document.documentElement.style.setProperty("--color-zinc-950", GROUND);
    setTheme("light");
  });

  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("style");
    vi.unstubAllGlobals();
  });

  it("applies the canvas colour and bar style once on start", () => {
    const { setBackground, setBarStyle } = start();

    expect(setBackground).toHaveBeenCalledExactlyOnceWith(CANVAS_LIGHT);
    expect(setBarStyle).toHaveBeenCalledExactlyOnceWith("LIGHT");
  });

  it("reaches native when the theme attribute on <html> changes", async () => {
    const { setBackground, setBarStyle } = start();

    setTheme("dark");
    await Promise.resolve();
    flushFrames();

    expect(setBackground).toHaveBeenLastCalledWith(CANVAS_DARK);
    expect(setBarStyle).toHaveBeenLastCalledWith("DARK");
  });

  it("switches to the dark ground while a full-bleed surface is mounted and back after", async () => {
    const { setBackground, setBarStyle } = start();

    const surface = document.createElement("div");
    surface.setAttribute("data-full-bleed-surface", "");
    document.body.append(surface);
    await Promise.resolve();
    flushFrames();

    expect(setBackground).toHaveBeenLastCalledWith(GROUND);
    expect(setBarStyle).toHaveBeenLastCalledWith("DARK");

    surface.remove();
    await Promise.resolve();
    flushFrames();

    expect(setBackground).toHaveBeenLastCalledWith(CANVAS_LIGHT);
    expect(setBarStyle).toHaveBeenLastCalledWith("LIGHT");
  });

  it("does not call native when the resolved colour did not change", async () => {
    const { setBackground, setBarStyle } = start();

    document.body.append(document.createElement("div"));
    document.documentElement.setAttribute("class", "unrelated");
    await Promise.resolve();
    flushFrames();

    expect(setBackground).toHaveBeenCalledTimes(1);
    expect(setBarStyle).toHaveBeenCalledTimes(1);
  });
});
