/**
 * The native window background sync: the colour behind the page and the
 * status-bar icon style follow what the page draws at its edge.
 *
 * The document is a real jsdom one, so the custom properties, the mounted
 * surfaces and their computed colours are the page's own. jsdom has no layout,
 * so the hit test is stubbed along with the animation frame (flushed by hand)
 * and the colour blender (a lookup).
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
  type WindowBands,
  type WindowBarStyle,
} from "../src/window-background";

const HEADER_LIGHT = "rgb(246, 249, 248)";
const CONTENT_LIGHT = "rgb(255, 255, 255)";
const HEADER_DARK = "rgb(18, 23, 21)";
const CONTENT_DARK = "rgb(15, 15, 15)";
const SCRIM = "rgba(0, 0, 0, 0.8)";
const GROUND = "rgb(9, 9, 11)";

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

  const surface = (color: string): HTMLElement => {
    const element = document.createElement("div");
    element.style.backgroundColor = color;
    document.body.append(element);
    return element;
  };

  /** What the hit test finds at the page's top and bottom edges, topmost first. */
  const paint = (top: HTMLElement[], bottom: HTMLElement[]): void => {
    const at = (_x: number, y: number): HTMLElement[] =>
      y === window.innerHeight - 1 ? bottom : top;
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: at,
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: (x: number, y: number): HTMLElement | null => at(x, y)[0] ?? null,
    });
  };

  const settle = async (): Promise<void> => {
    await Promise.resolve();
    flushFrames();
  };

  const start = (): {
    setBackground: Mock<(bands: WindowBands) => void>;
    setBarStyle: Mock<(style: WindowBarStyle) => void>;
    toHex: Mock<(layers: readonly string[]) => string>;
  } => {
    const setBackground = vi.fn<(bands: WindowBands) => void>();
    const setBarStyle = vi.fn<(style: WindowBarStyle) => void>();
    const toHex = vi.fn<(layers: readonly string[]) => string>((layers) => {
      const hex = {
        [HEADER_LIGHT]: "#f6f9f8",
        [CONTENT_LIGHT]: "#ffffff",
        [HEADER_DARK]: "#121715",
        [CONTENT_DARK]: "#0f0f0f",
        [GROUND]: "#09090b",
        [`${HEADER_LIGHT}+${SCRIM}`]: "#313232",
      }[layers.join("+")];
      if (hex === undefined) throw new Error(`unexpected layers ${layers}`);
      return hex;
    });
    startWindowBackgroundSync({ document, setBackground, setBarStyle, toHex });
    return { setBackground, setBarStyle, toHex };
  };

  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    document.documentElement.style.setProperty("--color-zinc-950", GROUND);
  });

  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute("style");
    paint([], []);
    vi.unstubAllGlobals();
  });

  it("paints each band from the page's own edge, and the icons from the top one", () => {
    paint([surface(HEADER_DARK)], [surface(CONTENT_DARK)]);

    const { setBackground, setBarStyle } = start();

    expect(setBackground).toHaveBeenCalledExactlyOnceWith({
      top: "#121715",
      topDepth: 0,
      rest: "#0f0f0f",
    });
    expect(setBarStyle).toHaveBeenCalledExactlyOnceWith("DARK");
  });

  it("dims a band with a scrim over the page, and looks through an unfilled layer", () => {
    const ground = surface(HEADER_LIGHT);
    paint([surface(SCRIM), ground], [surface("rgba(0, 0, 0, 0)"), ground]);

    const { setBackground, setBarStyle } = start();

    expect(setBackground).toHaveBeenCalledExactlyOnceWith({
      top: "#313232",
      topDepth: 0,
      rest: "#f6f9f8",
    });
    expect(setBarStyle).toHaveBeenCalledExactlyOnceWith("DARK");
  });

  it("carries the top colour down to the bottom of the surface it came from", () => {
    const header = surface(HEADER_DARK);
    vi.spyOn(header, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 412, 40),
    );
    paint([header], [surface(CONTENT_DARK)]);

    const { setBackground } = start();

    expect(setBackground).toHaveBeenCalledExactlyOnceWith({
      top: "#121715",
      topDepth: 40,
      rest: "#0f0f0f",
    });
  });

  it("reads below #root's top band and paints only its side strips", () => {
    const root = document.createElement("div");
    root.id = "root";
    root.style.padding = "28px 0px 0px 50px";
    document.body.append(root);
    const header = surface(HEADER_DARK);
    vi.spyOn(header, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 28, 864, 40),
    );
    const hitYs: number[] = [];
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: (): null => null,
    });
    const content = surface(CONTENT_DARK);
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: (_x: number, y: number): HTMLElement[] => {
        hitYs.push(y);
        return y === 28 ? [header] : [content];
      },
    });

    start();

    expect(hitYs[0]).toBe(28);
    const painted = root.getAttribute("style") ?? "";
    expect(painted).toContain(
      `linear-gradient(${HEADER_DARK} 68px, ${CONTENT_DARK} 68px)`,
    );
    expect(painted).toContain("left");
    expect(painted).toContain("50px");
  });

  it("reads the bottom corner inside #root's right strip, not the strip itself", () => {
    const root = document.createElement("div");
    root.id = "root";
    root.style.paddingRight = "50px";
    document.body.append(root);
    const strip = surface(HEADER_DARK);
    const content = surface(CONTENT_DARK);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: (): null => null,
    });
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: (x: number): HTMLElement[] =>
        x > window.innerWidth - 51 ? [strip] : [content],
    });

    const { setBackground } = start();

    expect(setBackground.mock.lastCall?.[0].rest).toBe("#0f0f0f");
  });

  it("leaves #root's side strips alone under a dim", () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    const header = surface(HEADER_LIGHT);
    paint([surface(SCRIM), header], [header]);

    start();

    expect(root.getAttribute("style")).toBeNull();
  });

  it("follows a change of screen", async () => {
    const header = surface(HEADER_LIGHT);
    paint([header], [header]);
    const { setBackground } = start();

    paint([header], [surface(CONTENT_LIGHT)]);
    await settle();

    expect(setBackground).toHaveBeenLastCalledWith({
      top: "#f6f9f8",
      topDepth: 0,
      rest: "#ffffff",
    });
  });

  it("follows a resize that moves another surface to an edge", () => {
    const header = surface(HEADER_LIGHT);
    paint([header], [header]);
    const { setBackground } = start();

    paint([header], [surface(CONTENT_LIGHT)]);
    window.dispatchEvent(new Event("resize"));
    flushFrames();

    expect(setBackground).toHaveBeenLastCalledWith({
      top: "#f6f9f8",
      topDepth: 0,
      rest: "#ffffff",
    });
  });

  it("reads the bottom's middle under a drawer that covers it", () => {
    const page = surface(CONTENT_LIGHT);
    const drawer = surface(HEADER_DARK);
    drawer.setAttribute("role", "dialog");
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: (): HTMLElement => drawer,
    });
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: (x: number, y: number): HTMLElement[] => {
        if (y === 0) return [page];
        return x === window.innerWidth / 2 ? [drawer] : [page];
      },
    });

    const { setBackground } = start();

    expect(setBackground).toHaveBeenCalledExactlyOnceWith({
      top: "#ffffff",
      topDepth: 0,
      rest: "#121715",
    });
  });

  it("dims both bands under the first-run tip until it starts leaving", async () => {
    const header = surface(HEADER_LIGHT);
    paint([header], [header]);
    const { setBackground } = start();

    const dim = document.createElement("div");
    dim.className = "first-task-coachmark-dim";
    const fill = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    fill.setAttribute("class", "first-task-coachmark-dim-fill");
    fill.style.setProperty("fill", SCRIM);
    dim.append(fill);
    document.body.append(dim);
    await settle();
    expect(setBackground).toHaveBeenLastCalledWith({
      top: "#313232",
      topDepth: 0,
      rest: "#313232",
    });

    dim.setAttribute("data-state", "exiting");
    dim.dispatchEvent(new Event("transitionend", { bubbles: true }));
    flushFrames();
    expect(setBackground).toHaveBeenLastCalledWith({
      top: "#f6f9f8",
      topDepth: 0,
      rest: "#f6f9f8",
    });
  });

  it("follows the menu drawer settling, which mounts and removes nothing", async () => {
    const header = surface(HEADER_LIGHT);
    paint([header], [header]);
    const { setBackground } = start();

    paint([surface(SCRIM), header], [header]);
    document.documentElement.setAttribute("data-mobile-menu-open", "");
    await settle();
    expect(setBackground).toHaveBeenLastCalledWith({
      top: "#313232",
      topDepth: 0,
      rest: "#f6f9f8",
    });

    paint([header], [header]);
    document.documentElement.removeAttribute("data-mobile-menu-open");
    await settle();
    expect(setBackground).toHaveBeenLastCalledWith({
      top: "#f6f9f8",
      topDepth: 0,
      rest: "#f6f9f8",
    });
  });

  it("follows a dim that finishes fading in after its surface mounted", () => {
    const header = surface(HEADER_LIGHT);
    paint([header], [header]);
    const { setBackground } = start();

    paint([surface(SCRIM), header], [header]);
    header.dispatchEvent(new Event("transitionend", { bubbles: true }));
    flushFrames();

    expect(setBackground).toHaveBeenLastCalledWith({
      top: "#313232",
      topDepth: 0,
      rest: "#f6f9f8",
    });
  });

  it("follows a theme change on <html>", async () => {
    const header = surface(HEADER_LIGHT);
    paint([header], [header]);
    const { setBackground, setBarStyle } = start();
    expect(setBarStyle).toHaveBeenLastCalledWith("LIGHT");

    header.style.backgroundColor = HEADER_DARK;
    document.documentElement.setAttribute("data-theme", "dark");
    await settle();

    expect(setBackground).toHaveBeenLastCalledWith({
      top: "#121715",
      topDepth: 0,
      rest: "#121715",
    });
    expect(setBarStyle).toHaveBeenLastCalledWith("DARK");
    document.documentElement.removeAttribute("data-theme");
  });

  it("switches to the dark ground while a full-bleed surface is mounted and back after", async () => {
    const header = surface(HEADER_LIGHT);
    paint([header], [header]);
    const { setBackground, setBarStyle } = start();

    const fullBleed = document.createElement("div");
    fullBleed.setAttribute("data-full-bleed-surface", "");
    document.body.append(fullBleed);
    await settle();

    expect(setBackground).toHaveBeenLastCalledWith({
      top: "#09090b",
      topDepth: 0,
      rest: "#09090b",
    });
    expect(setBarStyle).toHaveBeenLastCalledWith("DARK");

    fullBleed.remove();
    await settle();

    expect(setBackground).toHaveBeenLastCalledWith({
      top: "#f6f9f8",
      topDepth: 0,
      rest: "#f6f9f8",
    });
    expect(setBarStyle).toHaveBeenLastCalledWith("LIGHT");
  });

  it("resolves no colour and calls no native method when neither read changed", async () => {
    const header = surface(HEADER_LIGHT);
    paint([header], [header]);
    const { setBackground, setBarStyle, toHex } = start();
    const resolvedAtStart = toHex.mock.calls.length;

    document.body.append(document.createElement("div"));
    await settle();

    expect(toHex).toHaveBeenCalledTimes(resolvedAtStart);
    expect(setBackground).toHaveBeenCalledTimes(1);
    expect(setBarStyle).toHaveBeenCalledTimes(1);
  });
});
