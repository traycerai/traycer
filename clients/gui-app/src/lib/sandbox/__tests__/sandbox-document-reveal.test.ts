import { JSDOM, VirtualConsole, type DOMWindow } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { buildDocument } from "../sandbox-document";

// A page in a sandbox frame reveals elements inside the frame only: the
// bootstrap replaces `scrollIntoView`, `scrollIntoViewIfNeeded` and `focus`
// with a walk over the frame document's own scrollers. jsdom lays nothing out,
// so each element's geometry and computed style is declared here, and the
// walk's only output - `Element.prototype.scrollTo` - is recorded. The
// bootstrap takes `scrollTo` once, at startup, so the recorder is installed
// before the document runs.

interface Layout {
  /** Viewport coordinates, before any scroll the walk performs. */
  readonly rect?: {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
  };
  readonly client?: { readonly height: number; readonly width: number };
  readonly scroll?: {
    readonly height: number;
    readonly width: number;
    readonly top: number;
    readonly left: number;
  };
  readonly style?: Readonly<Record<string, string>>;
  /** What `checkVisibility()` answers for it; absent means visible. */
  readonly visible?: boolean;
  /**
   * Inside a `content-visibility: auto` ancestor that is off screen, so
   * only `checkVisibility({ contentVisibilityAuto: true })` answers false.
   */
  readonly autoSkipped?: boolean;
  /**
   * Under a `visibility: hidden` or `opacity: 0` ancestor, so only the
   * options that ask about CSS visibility or opacity answer false.
   */
  readonly cssHidden?: boolean;
}

interface ScrollCall {
  readonly scroller: Element;
  readonly top: number;
  readonly left: number;
  readonly behavior: string;
}

interface Frame {
  readonly window: DOMWindow;
  readonly layouts: WeakMap<Element, Layout>;
  readonly scrolls: ScrollCall[];
  readonly nativeFocusArgs: unknown[][];
  readonly native: {
    readonly scrollIntoView: unknown;
    readonly scrollIntoViewIfNeeded: unknown;
    readonly htmlFocus: unknown;
    readonly svgFocus: unknown;
  };
  place: (element: Element, layout: Layout) => void;
}

const windows: DOMWindow[] = [];

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function between(text: string, open: string, close: string): string {
  const start = text.indexOf(open);
  const end = text.indexOf(close, start + open.length);
  if (start === -1 || end === -1) throw new Error(`no ${open} in the document`);
  return text.slice(start + open.length, end);
}

function invoke(fn: unknown, self: object, args: readonly unknown[]): void {
  if (typeof fn !== "function") throw new Error("not a function");
  Reflect.apply(fn, self, args);
}

function valueOf(owner: object, name: string): unknown {
  return Object.getOwnPropertyDescriptor(owner, name)?.value;
}

function record(call: unknown): ScrollCall["behavior"] {
  return typeof call === "string" ? call : "";
}

function startFrame(canvas: boolean): Frame {
  const composed = buildDocument({
    html: "",
    csp: null,
    nonce: "n-1",
    theme: {
      appliesToRoot: true,
      colorScheme: "dark",
      background: null,
      variables: [],
    },
    shortcuts: [],
    artifactPage: null,
    canvas,
  });
  const { window } = new JSDOM("<!doctype html><html><body></body></html>", {
    runScripts: "dangerously",
    url: "traycer-artifact://artifact-a1--m1/site/index.html",
    virtualConsole: new VirtualConsole(),
  });
  windows.push(window);
  window.postMessage = () => undefined;

  const layouts = new WeakMap<Element, Layout>();
  const scrolls: ScrollCall[] = [];
  const nativeFocusArgs: unknown[][] = [];
  const proto = window.Element.prototype;
  const define = (owner: object, name: string, value: unknown): void => {
    Object.defineProperty(owner, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  };
  const getter = (name: string, read: (layout: Layout) => number): void => {
    Object.defineProperty(proto, name, {
      configurable: true,
      get(this: Element): number {
        return read(layouts.get(this) ?? {});
      },
    });
  };
  getter("clientHeight", (l) => l.client?.height ?? 0);
  getter("clientWidth", (l) => l.client?.width ?? 0);
  getter("scrollHeight", (l) => l.scroll?.height ?? 0);
  getter("scrollWidth", (l) => l.scroll?.width ?? 0);
  getter("scrollTop", (l) => l.scroll?.top ?? 0);
  getter("scrollLeft", (l) => l.scroll?.left ?? 0);
  define(proto, "getBoundingClientRect", function (this: Element) {
    const rect = layouts.get(this)?.rect ?? {
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
    };
    return { ...rect, x: rect.left, y: rect.top };
  });
  define(proto, "getClientRects", () => [{}]);
  // jsdom has no `checkVisibility`, so each element declares what the engine
  // would answer. Default options, which is what the bootstrap asks: false
  // for a box that is not generated and for contents an ancestor skips.
  // `browser-tests/sandbox-frame-scroll.spec.ts` is where that answer is
  // held to a real engine; here it is the input.
  define(proto, "checkVisibility", function (this: Element, options: unknown) {
    const layout = layouts.get(this) ?? {};
    const asked = (name: string): boolean =>
      typeof options === "object" &&
      options !== null &&
      name in options &&
      Reflect.get(options, name) === true;
    // Only the default answer is the engine's reveal decision. Every other
    // option asks a different question, and these are the pages that tell
    // them apart: each answers false where the engine reveals.
    if (layout.autoSkipped === true && asked("contentVisibilityAuto")) {
      return false;
    }
    if (
      layout.cssHidden === true &&
      (asked("checkVisibilityCSS") ||
        asked("visibilityProperty") ||
        asked("checkOpacity") ||
        asked("opacityProperty"))
    ) {
      return false;
    }
    return layout.visible ?? true;
  });
  define(proto, "scrollTo", function (this: Element, options: unknown) {
    const given = options as {
      top: number;
      left: number;
      behavior: unknown;
    };
    scrolls.push({
      scroller: this,
      top: given.top,
      left: given.left,
      behavior: record(given.behavior),
    });
  });
  // Stand-ins for the natives jsdom lacks. `scrollIntoView` takes a
  // parameter, so a replacement that fails to copy `length` shows.
  define(proto, "scrollIntoView", function scrollIntoView(_arg: unknown) {
    return undefined;
  });
  define(proto, "scrollIntoViewIfNeeded", function scrollIntoViewIfNeeded() {
    return undefined;
  });
  for (const focusable of [window.HTMLElement, window.SVGElement]) {
    const jsdomFocus: unknown = Reflect.get(focusable.prototype, "focus");
    define(
      focusable.prototype,
      "focus",
      function focus(this: HTMLElement | SVGElement, ...args: unknown[]) {
        nativeFocusArgs.push(args);
        invoke(jsdomFocus, this, []);
      },
    );
  }

  window.getComputedStyle = ((element: Element) => {
    const style = layouts.get(element)?.style ?? {};
    return new Proxy(
      {},
      {
        get: (_target, key) =>
          typeof key === "string" ? (style[key] ?? "") : "",
      },
    );
  }) as typeof window.getComputedStyle;

  const native = {
    scrollIntoView: valueOf(proto, "scrollIntoView"),
    scrollIntoViewIfNeeded: valueOf(proto, "scrollIntoViewIfNeeded"),
    htmlFocus: valueOf(window.HTMLElement.prototype, "focus"),
    svgFocus: valueOf(window.SVGElement.prototype, "focus"),
  };
  Object.defineProperty(window.document, "scrollingElement", {
    configurable: true,
    get: () => window.document.documentElement,
  });
  window.eval(between(composed, "<script>", "</script>"));
  return {
    window,
    layouts,
    scrolls,
    nativeFocusArgs,
    native,
    place: (element, layout) => layouts.set(element, layout),
  };
}

const SCROLLER_STYLE = { overflowY: "auto", overflowX: "visible" } as const;

/**
 * One scroller, 100x100 on screen at the origin and 1000x1000 inside, holding
 * a 40x40 target at the given viewport position.
 */
function singleScroller(
  frame: Frame,
  target: { top: number; left: number },
): { scroller: HTMLElement; target: HTMLElement } {
  return configuredScroller(frame, target, {});
}

function configuredScroller(
  frame: Frame,
  target: { top: number; left: number },
  options: {
    readonly scrollTop?: number;
    readonly scrollLeft?: number;
    readonly targetStyle?: Record<string, string>;
    readonly scrollerStyle?: Record<string, string>;
  },
): { scroller: HTMLElement; target: HTMLElement } {
  const doc = frame.window.document;
  const scroller = doc.createElement("div");
  const element = doc.createElement("button");
  scroller.append(element);
  doc.body.append(scroller);
  frame.place(scroller, {
    rect: { top: 0, bottom: 100, left: 0, right: 100 },
    client: { height: 100, width: 100 },
    scroll: {
      height: 1000,
      width: 1000,
      top: options.scrollTop ?? 0,
      left: options.scrollLeft ?? 0,
    },
    style: { ...SCROLLER_STYLE, ...options.scrollerStyle },
  });
  frame.place(element, {
    rect: {
      top: target.top,
      bottom: target.top + 40,
      left: target.left,
      right: target.left + 40,
    },
    style: options.targetStyle ?? {},
  });
  return { scroller, target: element };
}

function only(frame: Frame): ScrollCall {
  expect(frame.scrolls).toHaveLength(1);
  return frame.scrolls[0];
}

function scrollIntoView(element: Element, ...args: unknown[]): void {
  invoke(Reflect.get(element, "scrollIntoView"), element, args);
}

function scrollIntoViewIfNeeded(element: Element, ...args: unknown[]): void {
  invoke(Reflect.get(element, "scrollIntoViewIfNeeded"), element, args);
}

describe("scrollIntoView inside a frame", () => {
  it.each([
    ["start", 300],
    ["center", 270],
    ["end", 240],
    ["nearest", 240],
  ])("block %s scrolls the frame's scroller to %i", (block, top) => {
    const frame = startFrame(false);
    const { scroller, target } = singleScroller(frame, { top: 300, left: 20 });

    scrollIntoView(target, { block });

    expect(only(frame)).toEqual({
      scroller,
      top,
      left: 0,
      behavior: "auto",
    });
  });

  it.each([
    ["start", 300],
    ["center", 270],
    ["end", 240],
    ["nearest", 240],
  ])("inline %s scrolls the frame's scroller to %i", (inline, left) => {
    const frame = startFrame(false);
    const { scroller, target } = singleScroller(frame, { top: 10, left: 300 });

    scrollIntoView(target, { block: "nearest", inline });

    expect(only(frame)).toEqual({
      scroller,
      top: 0,
      left,
      behavior: "auto",
    });
  });

  it("aligns to the top with no argument or true, and to the bottom with false", () => {
    const aligned: number[] = [];
    for (const args of [[], [true], [false]]) {
      const frame = startFrame(false);
      const { target } = singleScroller(frame, { top: 300, left: 20 });
      scrollIntoView(target, ...args);
      aligned.push(only(frame).top);
    }

    expect(aligned).toEqual([300, 300, 240]);
  });

  it("passes the behavior through and falls back to auto for anything else", () => {
    const behaviors: string[] = [];
    for (const behavior of ["smooth", "instant", "auto", "bogus"]) {
      const frame = startFrame(false);
      const { target } = singleScroller(frame, { top: 300, left: 20 });
      scrollIntoView(target, { behavior });
      behaviors.push(only(frame).behavior);
    }

    expect(behaviors).toEqual(["smooth", "instant", "auto", "auto"]);
  });

  it("reveals the target's scroll-margin, not just its edge", () => {
    const start = startFrame(false);
    scrollIntoView(
      configuredScroller(
        start,
        { top: 300, left: 20 },
        {
          targetStyle: { scrollMarginTop: "30px" },
        },
      ).target,
      { block: "start" },
    );
    const end = startFrame(false);
    scrollIntoView(
      configuredScroller(
        end,
        { top: 300, left: 20 },
        {
          targetStyle: { scrollMarginBottom: "25px" },
        },
      ).target,
      { block: "end" },
    );
    const inline = startFrame(false);
    scrollIntoView(
      configuredScroller(
        inline,
        { top: 10, left: 300 },
        {
          targetStyle: { scrollMarginLeft: "5px" },
        },
      ).target,
      { block: "nearest", inline: "start" },
    );

    expect([only(start).top, only(end).top, only(inline).left]).toEqual([
      270, 265, 295,
    ]);
  });

  it("insets the scroller's port by its scroll-padding", () => {
    const start = startFrame(false);
    scrollIntoView(
      configuredScroller(
        start,
        { top: 300, left: 20 },
        {
          scrollerStyle: { scrollPaddingTop: "20px" },
        },
      ).target,
      { block: "start" },
    );
    const end = startFrame(false);
    scrollIntoView(
      configuredScroller(
        end,
        { top: 300, left: 20 },
        {
          scrollerStyle: { scrollPaddingBottom: "10px" },
        },
      ).target,
      { block: "end" },
    );
    const inline = startFrame(false);
    scrollIntoView(
      configuredScroller(
        inline,
        { top: 10, left: 300 },
        {
          scrollerStyle: { scrollPaddingRight: "15px" },
        },
      ).target,
      { block: "nearest", inline: "end" },
    );

    expect([only(start).top, only(end).top, only(inline).left]).toEqual([
      280, 250, 255,
    ]);
  });

  it("clamps the destination to the scroller's range", () => {
    const far = startFrame(false);
    scrollIntoView(singleScroller(far, { top: 2000, left: 20 }).target, {
      block: "start",
    });
    const back = startFrame(false);
    scrollIntoView(
      configuredScroller(back, { top: -500, left: 20 }, { scrollTop: 50 })
        .target,
      { block: "start" },
    );

    expect([only(far).top, only(back).top]).toEqual([900, 0]);
  });

  it("does not scroll a scroller that is already where the reveal puts it", () => {
    const frame = startFrame(false);
    const { target } = singleScroller(frame, { top: 0, left: 0 });

    scrollIntoView(target, { block: "start" });

    expect(frame.scrolls).toEqual([]);
  });

  it("shows an outer scroller the target already shifted by the inner move", () => {
    const frame = startFrame(false);
    const doc = frame.window.document;
    const outer = doc.createElement("div");
    const inner = doc.createElement("div");
    const target = doc.createElement("button");
    inner.append(target);
    outer.append(inner);
    doc.body.append(outer);
    frame.place(outer, {
      rect: { top: 0, bottom: 200, left: 0, right: 100 },
      client: { height: 200, width: 100 },
      scroll: { height: 2000, width: 100, top: 0, left: 0 },
      style: SCROLLER_STYLE,
    });
    frame.place(inner, {
      rect: { top: 100, bottom: 200, left: 0, right: 100 },
      client: { height: 100, width: 100 },
      scroll: { height: 1000, width: 100, top: 0, left: 0 },
      style: SCROLLER_STYLE,
    });
    frame.place(target, {
      rect: { top: 400, bottom: 440, left: 0, right: 40 },
    });

    scrollIntoView(target, { block: "start" });

    expect(frame.scrolls).toEqual([
      { scroller: inner, top: 300, left: 0, behavior: "auto" },
      { scroller: outer, top: 100, left: 0, behavior: "auto" },
    ]);
  });
});

describe("nearest on a target that covers the port", () => {
  // The target starts before the port and ends after it: no edge is nearer.
  // The scroller sits mid-range so a stray move in either direction would
  // show, not clamp away at the start.
  function scrolledScroller(frame: Frame) {
    return configuredScroller(
      frame,
      { top: 0, left: 0 },
      { scrollTop: 100, scrollLeft: 100 },
    );
  }

  it("does not scroll the block axis", () => {
    const frame = startFrame(false);
    const { target } = scrolledScroller(frame);
    frame.place(target, {
      rect: { top: -50, bottom: 150, left: 20, right: 60 },
    });

    scrollIntoView(target, { block: "nearest" });

    expect(frame.scrolls).toEqual([]);
  });

  it("does not scroll the inline axis", () => {
    const frame = startFrame(false);
    const { target } = scrolledScroller(frame);
    frame.place(target, {
      rect: { top: 10, bottom: 50, left: -50, right: 150 },
    });

    scrollIntoView(target, { block: "nearest", inline: "nearest" });

    expect(frame.scrolls).toEqual([]);
  });

  it("does not scroll for scrollIntoViewIfNeeded, which falls back to nearest", () => {
    const frame = startFrame(false);
    const { target } = scrolledScroller(frame);
    frame.place(target, {
      rect: { top: -50, bottom: 150, left: -50, right: 150 },
    });

    scrollIntoViewIfNeeded(target);

    expect(frame.scrolls).toEqual([]);
  });
});

describe("body overflow inside a frame", () => {
  const VISIBLE = { overflowX: "visible", overflowY: "visible" };

  function pageWithBody(
    frame: Frame,
    htmlStyle: Record<string, string>,
    bodyStyle: Record<string, string>,
  ): { html: HTMLElement; body: HTMLElement; target: HTMLElement } {
    const doc = frame.window.document;
    const target = doc.createElement("button");
    doc.body.append(target);
    const page = {
      client: { height: 100, width: 100 },
      scroll: { height: 1000, width: 1000, top: 0, left: 0 },
    };
    frame.place(doc.documentElement, { ...page, style: htmlStyle });
    frame.place(doc.body, {
      ...page,
      style: { overflowX: "hidden", overflowY: "visible", ...bodyStyle },
    });
    frame.place(target, {
      rect: { top: 300, bottom: 340, left: 20, right: 60 },
    });
    return { html: doc.documentElement, body: doc.body, target };
  }

  // The walk reads an element as contained by one of these, and by none of
  // the next ones. `contain` names the containment; `container-type` and
  // `content-visibility` apply it with `contain` itself left `none`.
  // `content-visibility: hidden` is in neither list: it contains, and the
  // walk never asks, because a reveal inside skipped contents is over
  // before it starts. The "skipped" tests below cover that.
  const CONTAINS: Record<string, string>[] = [
    { contain: "paint" },
    { contain: "layout" },
    { contain: "style" },
    { contain: "size" },
    { contain: "inline-size" },
    { contain: "content" },
    { contain: "strict" },
    { contentVisibility: "auto" },
    { containerType: "inline-size" },
    { containerType: "size" },
    // `container-type` keeps growing, and every value it grows contains
    // unless it is one of the two below. These are the serialisations the
    // engine answers with, not the order a page writes: one per containing
    // keyword, and each paired with a keyword that contains nothing, so no
    // combination can be mistaken for one of the two.
    { containerType: "anchored" },
    { containerType: "inline-size scroll-state" },
    { containerType: "scroll-state anchored" },
    { containerType: "size scroll-state" },
    { containerType: "inline-size anchored" },
  ];
  const CONTAINS_NOT: Record<string, string>[] = [
    { contain: "none" },
    { contentVisibility: "visible" },
    { containerType: "normal" },
    { containerType: "scroll-state" },
  ];

  // The page an engine that knows none of these properties describes: every
  // one of them reads back empty, and the body's overflow is the viewport's.
  it("moves the viewport, not body, when html's overflow is visible", () => {
    const frame = startFrame(false);
    const { html, target } = pageWithBody(frame, VISIBLE, {});

    scrollIntoView(target, { block: "start" });

    expect(frame.scrolls).toEqual([
      { scroller: html, top: 300, left: 0, behavior: "auto" },
    ]);
  });

  it("treats body as a scroller when html's overflow is not visible", () => {
    const frame = startFrame(false);
    const { body, target } = pageWithBody(
      frame,
      { overflowX: "visible", overflowY: "auto" },
      {},
    );

    scrollIntoView(target, { block: "start" });

    expect(frame.scrolls).toEqual([
      { scroller: body, top: 300, left: 0, behavior: "auto" },
    ]);
  });

  // Containment on either element keeps the body's overflow its own, whatever
  // the root's overflow says.
  it.each(CONTAINS)("keeps body a scroller when html has %o", (style) => {
    const frame = startFrame(false);
    const { body, target } = pageWithBody(frame, { ...VISIBLE, ...style }, {});

    scrollIntoView(target, { block: "start" });

    expect(frame.scrolls).toEqual([
      { scroller: body, top: 300, left: 0, behavior: "auto" },
    ]);
  });

  it.each(CONTAINS)("keeps body a scroller when body has %o", (style) => {
    const frame = startFrame(false);
    const { body, target } = pageWithBody(frame, VISIBLE, style);

    scrollIntoView(target, { block: "start" });

    expect(frame.scrolls).toEqual([
      { scroller: body, top: 300, left: 0, behavior: "auto" },
    ]);
  });

  // None of these contains anything, so the body's overflow stays the
  // viewport's and the viewport is what moves.
  it.each(CONTAINS_NOT)("moves the viewport when html has %o", (style) => {
    const frame = startFrame(false);
    const { html, target } = pageWithBody(frame, { ...VISIBLE, ...style }, {});

    scrollIntoView(target, { block: "start" });

    expect(frame.scrolls).toEqual([
      { scroller: html, top: 300, left: 0, behavior: "auto" },
    ]);
  });

  it.each(CONTAINS_NOT)("moves the viewport when body has %o", (style) => {
    const frame = startFrame(false);
    const { html, target } = pageWithBody(frame, VISIBLE, style);

    scrollIntoView(target, { block: "start" });

    expect(frame.scrolls).toEqual([
      { scroller: html, top: 300, left: 0, behavior: "auto" },
    ]);
  });

  // A page with room to scroll in every scroller, so what the walk does is
  // decided by the answer declared for the target and nothing else. A page
  // that happened to leave no room would behave the same either way.
  function pageDeclaring(
    frame: Frame,
    answers: { visible: boolean; autoSkipped: boolean; cssHidden: boolean },
  ): { html: HTMLElement; target: HTMLElement } {
    const doc = frame.window.document;
    const target = doc.createElement("button");
    doc.body.append(target);
    const roomy = {
      client: { height: 100, width: 100 },
      scroll: { height: 1000, width: 1000, top: 0, left: 0 },
    };
    frame.place(doc.documentElement, { ...roomy, style: VISIBLE });
    frame.place(doc.body, { ...roomy, style: VISIBLE });
    frame.place(target, {
      rect: { top: 300, bottom: 340, left: 20, right: 60 },
      ...answers,
    });
    return { html: doc.documentElement, target };
  }

  const REVEALS = { visible: true, autoSkipped: false, cssHidden: false };
  const REVEALED = [
    { scroller: null, top: 300, left: 0, behavior: "auto" },
  ] as const;
  const revealedBy = (html: HTMLElement): unknown[] =>
    REVEALED.map((call) => ({ ...call, scroller: html }));

  // Wherever `checkVisibility()` is false the engine reveals nothing, which
  // is the one direction the rule relies on. Which pages those are is held
  // to a real engine in `browser-tests/sandbox-frame-scroll.spec.ts`.
  it("scrolls nothing into view when the engine would reveal nothing", () => {
    const frame = startFrame(false);
    const { target } = pageDeclaring(frame, { ...REVEALS, visible: false });

    scrollIntoView(target, { block: "start" });

    expect(frame.scrolls).toEqual([]);
  });

  it("reveals a target the engine would reveal", () => {
    const frame = startFrame(false);
    const { html, target } = pageDeclaring(frame, REVEALS);

    scrollIntoView(target, { block: "start" });

    expect(frame.scrolls).toEqual(revealedBy(html));
  });

  // `focus` reveals through the same walk, so the rule holds for it too.
  it("skips the reveal of an unrevealable target through focus", () => {
    const frame = startFrame(false);
    const { target } = pageDeclaring(frame, { ...REVEALS, visible: false });

    target.focus();

    expect(frame.nativeFocusArgs).toEqual([[{ preventScroll: true }]]);
    expect(frame.scrolls).toEqual([]);
  });

  // The default answer is the question. Each of these pages is one the
  // engine reveals into while some other option set calls it invisible: an
  // off-screen `content-visibility: auto` ancestor, and a `visibility:
  // hidden` or `opacity: 0` one. Asking with those options would swallow
  // the reveal.
  it.each([
    { ...REVEALS, autoSkipped: true },
    { ...REVEALS, cssHidden: true },
  ])("reveals a target only another option set hides: %o", (answers) => {
    const frame = startFrame(false);
    const { html, target } = pageDeclaring(frame, answers);

    scrollIntoView(target, { block: "start" });

    expect(frame.scrolls).toEqual(revealedBy(html));
  });

  // An engine with no `checkVisibility` is left alone: the reveal behaves as
  // it did before the rule rather than skipping every page.
  it("reveals as before on an engine without checkVisibility", () => {
    const frame = startFrame(false);
    const { html, target } = pageDeclaring(frame, {
      ...REVEALS,
      visible: false,
    });
    Reflect.deleteProperty(frame.window.Element.prototype, "checkVisibility");

    scrollIntoView(target, { block: "start" });

    expect(frame.scrolls).toEqual(revealedBy(html));
  });
});

describe("scrollIntoViewIfNeeded inside a frame", () => {
  it("leaves a fully visible target alone", () => {
    const frame = startFrame(false);
    const { target } = singleScroller(frame, { top: 10, left: 10 });

    scrollIntoViewIfNeeded(target);

    expect(frame.scrolls).toEqual([]);
  });

  it("centres a target that is wholly out of view", () => {
    const frame = startFrame(false);
    const { scroller, target } = singleScroller(frame, { top: 300, left: 20 });

    scrollIntoViewIfNeeded(target);

    expect(only(frame)).toEqual({
      scroller,
      top: 270,
      left: 0,
      behavior: "auto",
    });
  });

  it("brings a partly visible target in at the nearer edge", () => {
    const below = startFrame(false);
    scrollIntoViewIfNeeded(singleScroller(below, { top: 80, left: 10 }).target);
    const above = startFrame(false);
    scrollIntoViewIfNeeded(
      configuredScroller(above, { top: -20, left: 10 }, { scrollTop: 200 })
        .target,
    );

    expect([only(below).top, only(above).top]).toEqual([20, 180]);
  });

  it("takes the nearest edge, not the centre, when passed false", () => {
    const frame = startFrame(false);
    const { target } = singleScroller(frame, { top: 300, left: 20 });

    scrollIntoViewIfNeeded(target, false);

    expect(only(frame).top).toBe(240);
  });
});

describe("focus inside a frame", () => {
  it("focuses without letting the browser scroll, keeps the caller's options, then reveals in the frame", () => {
    const frame = startFrame(false);
    const { scroller, target } = singleScroller(frame, { top: 300, left: 20 });

    target.focus({ focusVisible: true });

    expect(frame.nativeFocusArgs).toEqual([
      [{ focusVisible: true, preventScroll: true }],
    ]);
    expect(only(frame)).toEqual({
      scroller,
      top: 270,
      left: 0,
      behavior: "auto",
    });
  });

  it("adds preventScroll when focus is called with no options", () => {
    const frame = startFrame(false);
    const { target } = singleScroller(frame, { top: 300, left: 20 });

    target.focus();

    expect(frame.nativeFocusArgs).toEqual([[{ preventScroll: true }]]);
  });

  it("does not reveal when the caller passes preventScroll", () => {
    const frame = startFrame(false);
    const { target } = singleScroller(frame, { top: 300, left: 20 });

    target.focus({ preventScroll: true });

    expect(frame.nativeFocusArgs).toEqual([[{ preventScroll: true }]]);
    expect(frame.scrolls).toEqual([]);
  });

  it("does not reveal an element that was already focused", () => {
    const frame = startFrame(false);
    const { target } = singleScroller(frame, { top: 300, left: 20 });
    target.focus();
    frame.scrolls.length = 0;

    target.focus();

    expect(frame.scrolls).toEqual([]);
  });

  it("reveals an element focused inside a closed shadow root", () => {
    const frame = startFrame(false);
    const { scroller } = singleScroller(frame, { top: 300, left: 20 });
    const host = frame.window.document.createElement("div");
    const input = frame.window.document.createElement("input");
    scroller.append(host);
    host.attachShadow({ mode: "closed" }).append(input);
    frame.place(host, { rect: { top: 300, bottom: 340, left: 20, right: 60 } });
    frame.place(input, {
      rect: { top: 300, bottom: 340, left: 20, right: 60 },
    });

    input.focus();

    expect(frame.nativeFocusArgs).toEqual([[{ preventScroll: true }]]);
    expect(only(frame)).toEqual({
      scroller,
      top: 270,
      left: 0,
      behavior: "auto",
    });
  });

  it("covers SVG elements too", () => {
    const frame = startFrame(false);
    const { scroller } = singleScroller(frame, { top: 300, left: 20 });
    const svg = frame.window.document.createElementNS(
      "http://www.w3.org/2000/svg",
      "g",
    );
    svg.setAttribute("tabindex", "0");
    scroller.append(svg);
    frame.place(svg, { rect: { top: 300, bottom: 340, left: 20, right: 60 } });

    svg.focus();

    expect(frame.nativeFocusArgs).toEqual([[{ preventScroll: true }]]);
    expect(only(frame).top).toBe(270);
  });
});

describe("the replaced functions", () => {
  it("look native: same name and length, non-enumerable", () => {
    const frame = startFrame(false);
    const proto = frame.window.Element.prototype;
    const htmlProto = frame.window.HTMLElement.prototype;

    const replaced: [object, string, unknown][] = [
      [proto, "scrollIntoView", frame.native.scrollIntoView],
      [proto, "scrollIntoViewIfNeeded", frame.native.scrollIntoViewIfNeeded],
      [htmlProto, "focus", frame.native.htmlFocus],
    ];
    for (const [owner, name, native] of replaced) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      expect(descriptor?.value).not.toBe(native);
      const identity = (fn: unknown): unknown[] => [
        Reflect.get(Object(fn), "name"),
        Reflect.get(Object(fn), "length"),
      ];
      expect(identity(descriptor?.value)).toEqual(identity(native));
      expect(descriptor?.enumerable).toBe(false);
      expect(Object.keys(owner)).not.toContain(name);
    }
  });

  it("stay native in a canvas document, whose stage scrolls outside the frame", () => {
    const frame = startFrame(true);
    const proto = frame.window.Element.prototype;

    expect(valueOf(proto, "scrollIntoView")).toBe(frame.native.scrollIntoView);
    expect(valueOf(proto, "scrollIntoViewIfNeeded")).toBe(
      frame.native.scrollIntoViewIfNeeded,
    );
    expect(valueOf(frame.window.HTMLElement.prototype, "focus")).toBe(
      frame.native.htmlFocus,
    );
    expect(valueOf(frame.window.SVGElement.prototype, "focus")).toBe(
      frame.native.svgFocus,
    );
  });
});
