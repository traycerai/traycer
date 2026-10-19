import { JSDOM, VirtualConsole, type DOMWindow } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { parseCanvasBox, parseCanvasElement } from "../../canvas-bridge";
import type { SandboxTheme } from "../../theme-map";
import {
  buildArtifactDocument,
  type ArtifactDocumentOptions,
} from "../artifact-document";

const NONCE = "canvas-doc-nonce";
const STAMP = "data-traycer-pos";
const STAMP_PATTERN = new RegExp(` ${STAMP}="\\d+"`, "g");

const THEME: SandboxTheme = {
  appliesToRoot: true,
  colorScheme: "light",
  background: null,
  variables: {},
};

function optionsFor(canvas: boolean | undefined): ArtifactDocumentOptions {
  return {
    policySource: "traycer-sandbox:",
    csp: null,
    theme: THEME,
    nonce: NONCE,
    shortcuts: [],
    ...(canvas === undefined ? {} : { canvas }),
  };
}

/** Every inline `<script>` a composed document carries, in document order. */
function scriptsOf(composed: string): string[] {
  return [...composed.matchAll(/<script>[\s\S]*?<\/script>/g)].map(
    (match) => match[0],
  );
}

describe("canvas documents stamp source positions", () => {
  it("stamps every element with its original start-tag offset", () => {
    const html = "<div><p>a</p><p>b</p></div>";
    const composed = buildArtifactDocument(html, optionsFor(true));
    expect(composed).toContain(
      `<div ${STAMP}="0"><p ${STAMP}="5">a</p><p ${STAMP}="13">b</p></div>`,
    );
  });

  it("counts offsets in the page as authored, doctype included", () => {
    const html = "<!doctype html><section><p>x</p></section>";
    const composed = buildArtifactDocument(html, optionsFor(true));
    // The builder lifts the doctype out, but a marker still names the
    // authored offset or the editor would edit the wrong element.
    expect(composed).toContain(`<section ${STAMP}="15"><p ${STAMP}="24">x</p>`);
    expect(html.slice(15, 23)).toBe("<section");
    expect(html.slice(24, 26)).toBe("<p");
  });

  it("points every marker at the start tag it stamps", () => {
    const html =
      "<main>\n  <h1 class='t'>Title</h1>\n  <ul><li>one</li><li>two</li></ul>\n</main>";
    const composed = buildArtifactDocument(html, optionsFor(true));
    const markers = [
      ...composed.matchAll(new RegExp(`<(\\w+)[^>]*${STAMP}="(\\d+)"`, "g")),
    ];
    expect(markers.map((match) => match[1])).toEqual([
      "main",
      "h1",
      "ul",
      "li",
      "li",
    ]);
    for (const [, tag, offset] of markers) {
      expect(html.slice(Number(offset), Number(offset) + tag.length + 1)).toBe(
        `<${tag}`,
      );
    }
  });

  it("replaces a marker the author already wrote instead of trusting it", () => {
    const html = `<p ${STAMP}="999">x</p>`;
    const composed = buildArtifactDocument(html, optionsFor(true));
    expect(composed).toContain(`<p ${STAMP}="0">x</p>`);
    expect(composed).not.toContain(`${STAMP}="999"`);
  });

  it("stamps elements only, never text or comments that look like tags", () => {
    const html = "<!-- <b>no</b> --><p>&lt;i&gt;</p>";
    const composed = buildArtifactDocument(html, optionsFor(true));
    expect([...composed.matchAll(STAMP_PATTERN)]).toHaveLength(1);
    expect(composed).toContain(`<p ${STAMP}="18">`);
  });
});

describe("the canvas bootstrap is a separate script", () => {
  const html = "<p>hi</p>";

  it("follows the ordinary bootstrap and precedes the page", () => {
    const composed = buildArtifactDocument(html, optionsFor(true));
    const scripts = scriptsOf(composed);
    expect(scripts).toHaveLength(2);
    expect(scripts[1]).toContain("traycer/canvas/hit-test");
    expect(scripts[1]).toContain(JSON.stringify(NONCE));
    expect(scripts[0]).not.toContain("traycer/canvas/");
    expect(composed.indexOf(scripts[0])).toBeLessThan(
      composed.indexOf(scripts[1]),
    );
    expect(composed.indexOf(scripts[1])).toBeLessThan(
      composed.indexOf(`<p ${STAMP}`),
    );
  });

  it("hands the bootstrap the curated style list", () => {
    const [, canvasScript] = scriptsOf(
      buildArtifactDocument(html, optionsFor(true)),
    );
    expect(canvasScript).toContain('"styleProperties":["display"');
  });

  it("is the only difference from the ordinary document, apart from the stamps", () => {
    const ordinary = buildArtifactDocument(html, optionsFor(false));
    const canvas = buildArtifactDocument(html, optionsFor(true));
    const [, canvasScript] = scriptsOf(canvas);
    expect(canvas.replace(canvasScript, "").replace(STAMP_PATTERN, "")).toBe(
      ordinary,
    );
  });
});

describe("an ordinary document is untouched by the canvas option", () => {
  const pages = [
    "<p>hi</p>",
    "<!doctype html><title>t</title><div class='a'>b</div>",
    "<main>\n<a href='x.html'>x</a></main>",
  ];

  it.each(pages)(
    "builds the same bytes whether canvas is omitted or false: %s",
    (html) => {
      expect(buildArtifactDocument(html, optionsFor(false))).toBe(
        buildArtifactDocument(html, optionsFor(undefined)),
      );
    },
  );

  it.each(pages)(
    "carries one script, no stamps and no canvas channel: %s",
    (html) => {
      const composed = buildArtifactDocument(html, optionsFor(undefined));
      expect(scriptsOf(composed)).toHaveLength(1);
      expect(composed).not.toContain(STAMP);
      expect(composed).not.toContain("traycer/canvas/");
      expect(composed).not.toContain("canvasBootstrap");
    },
  );

  it("keeps the page's own bytes after the bootstrap, unstamped", () => {
    const html = "<p   class=x >spaced</p>";
    const composed = buildArtifactDocument(html, optionsFor(false));
    expect(composed.endsWith(`</script>${html}`)).toBe(true);
  });
});

interface Posted {
  readonly jsonrpc?: string;
  readonly id?: unknown;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
}

const windows: DOMWindow[] = [];

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

interface Page {
  readonly window: DOMWindow;
  readonly posted: Posted[];
  /** Deliver a message as if the app had posted it to the page. */
  readonly deliver: (data: unknown) => void;
  /** Deliver a message whose `event.source` is something else. */
  readonly deliverFrom: (data: unknown, source: unknown) => void;
  readonly canvasPosts: () => Posted[];
  /** Every ResizeObserver the page's scripts built, in construction order. */
  readonly observers: ObserverRecord[];
  /** Runs the animation frames the page asked for, once each. */
  readonly flushFrames: () => void;
}

interface ObserverRecord {
  readonly callback: () => void;
  readonly observed: Set<Element>;
}

/**
 * Runs a composed canvas document's real scripts in an isolated jsdom window.
 * The window is its own parent, so what it posts to its parent lands here.
 */
function runCanvasPage(markup: string): Page {
  const composed = buildArtifactDocument(markup, optionsFor(true));
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    runScripts: "dangerously",
    url: "https://sandbox.test/page.html",
  });
  const { window } = dom;
  windows.push(window);
  const observers: ObserverRecord[] = [];
  window.ResizeObserver = class {
    private readonly record: ObserverRecord;
    constructor(callback: () => void) {
      this.record = { callback, observed: new Set() };
      observers.push(this.record);
    }
    observe(target: Element): void {
      this.record.observed.add(target);
    }
    unobserve(target: Element): void {
      this.record.observed.delete(target);
    }
  };
  // The page's frames are driven by the test, not a clock.
  const frames: FrameRequestCallback[] = [];
  window.requestAnimationFrame = (callback) => frames.push(callback);
  // jsdom has no layout, so a range has no rectangles.
  Object.defineProperty(window.Range.prototype, "getClientRects", {
    value: () => [],
  });
  // jsdom has neither; the page's own bootstrap relies on both.
  Object.defineProperty(window, "CSS", {
    value: { escape: (value: string) => value },
  });
  const posted: Posted[] = [];
  window.postMessage = (message: Posted) => {
    posted.push(message);
  };
  // The stamped markup is what a real canvas page would parse.
  const stamped = composed.slice(
    composed.lastIndexOf("</script>") + "</script>".length,
  );
  window.document.body.innerHTML = stamped;
  for (const script of scriptsOf(composed)) {
    window.eval(script.slice("<script>".length, -"</script>".length));
  }
  const dispatchFrom = (data: unknown, source: unknown): void => {
    const event = new window.MessageEvent("message", { data });
    Object.defineProperty(event, "source", { value: source });
    window.dispatchEvent(event);
  };
  return {
    window,
    posted,
    deliver: (data) => {
      dispatchFrom(data, window);
    },
    deliverFrom: dispatchFrom,
    observers,
    flushFrames: () => {
      for (const frame of frames.splice(0)) frame(0);
    },
    canvasPosts: () =>
      posted.filter(
        (message) =>
          message.method?.startsWith("traycer/canvas/") === true ||
          (message.result !== undefined && "nonce" in message.result),
      ),
  };
}

function request(id: number, method: string, params: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    method: `traycer/canvas/${method}`,
    params: { ...params, nonce: NONCE },
  };
}

function loaded(page: Page): void {
  page.window.dispatchEvent(new page.window.Event("load"));
}

describe("the canvas bootstrap in a running page", () => {
  const MARKUP = `<p style="color: red">hello</p><button>go</button>`;

  it("stays silent until the page has loaded", () => {
    const page = runCanvasPage(MARKUP);
    page.deliver(request(1, "set-mode", { mode: "play" }));
    page.window.dispatchEvent(
      new page.window.ErrorEvent("error", { message: "early" }),
    );
    expect(page.canvasPosts()).toEqual([]);
  });

  it("answers set-mode with the nonce once loaded", () => {
    const page = runCanvasPage(MARKUP);
    loaded(page);
    page.deliver(request(1, "set-mode", { mode: "play" }));
    expect(page.canvasPosts()).toEqual([
      { jsonrpc: "2.0", id: 1, result: { nonce: NONCE } },
    ]);
  });

  it.each([
    [
      "a wrong nonce",
      {
        ...request(1, "set-mode", { mode: "play" }),
        params: { mode: "play", nonce: "other" },
      },
    ],
    [
      "no nonce",
      { ...request(1, "set-mode", { mode: "play" }), params: { mode: "play" } },
    ],
    ["no id", { ...request(1, "set-mode", { mode: "play" }), id: undefined }],
    ["an unknown mode", request(1, "set-mode", { mode: "draw" })],
    ["an unknown method", request(1, "delete-everything", {})],
    ["a non-numeric point", request(1, "hit-test", { x: "1", y: 2 })],
  ])("ignores %s", (_label, message) => {
    const page = runCanvasPage(MARKUP);
    loaded(page);
    page.deliver(message);
    expect(page.canvasPosts()).toEqual([]);
  });

  it("answers a box request that names nothing with no box", () => {
    const page = runCanvasPage(MARKUP);
    loaded(page);
    page.deliver(request(1, "element-box", {}));
    expect(page.canvasPosts()).toEqual([
      { jsonrpc: "2.0", id: 1, result: { box: null, nonce: NONCE } },
    ]);
  });

  it("ignores a message that did not come from the parent", () => {
    const page = runCanvasPage(MARKUP);
    loaded(page);
    page.deliverFrom(request(1, "set-mode", { mode: "play" }), null);
    expect(page.canvasPosts()).toEqual([]);
  });

  it("answers a hit-test with an element the host's parser accepts", () => {
    const page = runCanvasPage(MARKUP);
    loaded(page);
    const paragraph = page.window.document.querySelector("p");
    page.window.document.elementFromPoint = () => paragraph;
    page.deliver(request(2, "hit-test", { x: 3, y: 4 }));

    const [answer] = page.canvasPosts();
    expect(answer.id).toBe(2);
    expect(answer.result?.nonce).toBe(NONCE);
    const element = parseCanvasElement(answer.result?.element);
    expect(element).toMatchObject({
      marker: 0,
      tagName: "p",
      textPreview: "hello",
      inlineStyle: "color: red",
      generated: false,
    });
  });

  it("marks an element with no stamp as generated", () => {
    const page = runCanvasPage(MARKUP);
    loaded(page);
    const injected = page.window.document.createElement("span");
    page.window.document.body.append(injected);
    page.window.document.elementFromPoint = () => injected;
    page.deliver(request(3, "hit-test", { x: 0, y: 0 }));

    const element = parseCanvasElement(page.canvasPosts()[0].result?.element);
    expect(element).toMatchObject({ marker: null, generated: true });
  });

  it("answers null for a hit-test that lands on nothing", () => {
    const page = runCanvasPage(MARKUP);
    loaded(page);
    page.window.document.elementFromPoint = () => null;
    page.deliver(request(4, "hit-test", { x: 0, y: 0 }));
    expect(page.canvasPosts()[0].result).toEqual({
      element: null,
      nonce: NONCE,
    });
  });

  it("answers an element-box for a unique marker, and null for a missing or ambiguous one", () => {
    const page = runCanvasPage(MARKUP);
    loaded(page);
    page.deliver(request(5, "element-box", { marker: 0 }));
    expect(parseCanvasBox(page.canvasPosts()[0].result?.box)).not.toBeNull();

    page.deliver(request(6, "element-box", { marker: 12345 }));
    expect(page.canvasPosts()[1].result).toEqual({ box: null, nonce: NONCE });

    // Two elements claiming one marker cannot be told apart, so neither is.
    const twin = page.window.document.createElement("i");
    twin.setAttribute(STAMP, "0");
    page.window.document.body.append(twin);
    page.deliver(request(7, "element-box", { marker: 0 }));
    expect(page.canvasPosts()[2].result).toEqual({ box: null, nonce: NONCE });
  });

  it("scrolls the located element to the centre and answers whether it found one", () => {
    const page = runCanvasPage(`<p data-tid="hero">hello</p><p>other</p>`);
    loaded(page);
    // jsdom has no scrollIntoView; record which element the page asked to scroll.
    const scrolled: Array<{ element: Element; options: unknown }> = [];
    page.window.Element.prototype.scrollIntoView = function (
      this: Element,
      options: boolean | ScrollIntoViewOptions | undefined,
    ) {
      scrolled.push({ element: this, options });
    };

    page.deliver(request(8, "reveal-element", { tid: "hero" }));
    expect(page.canvasPosts().at(-1)?.result).toEqual({
      revealed: true,
      nonce: NONCE,
    });
    expect(scrolled).toEqual([
      {
        element: page.window.document.querySelector('[data-tid="hero"]'),
        options: { block: "center", inline: "nearest" },
      },
    ]);

    page.deliver(request(9, "reveal-element", { tid: "gone" }));
    expect(page.canvasPosts().at(-1)?.result).toEqual({
      revealed: false,
      nonce: NONCE,
    });
    expect(scrolled).toHaveLength(1);
  });

  describe("describing an element by locator", () => {
    const TAGGED = `<p data-tid="hero" style="color: red">hello</p><p>other</p>`;
    const describeElement = (
      page: Page,
      id: number,
      locator: Record<string, unknown>,
    ) => {
      page.deliver(request(id, "describe-element", locator));
      return page.canvasPosts().at(-1);
    };

    it("answers with the element as it is now, after the page hid it", () => {
      const page = runCanvasPage(TAGGED);
      loaded(page);
      const before = parseCanvasElement(
        describeElement(page, 1, { tid: "hero" })?.result?.element,
      );
      expect(before).toMatchObject({ inlineStyle: "color: red", tid: "hero" });
      expect(before?.computedStyles).not.toContainEqual({
        property: "display",
        value: "none",
      });

      // A hidden element has no point to hit-test, so a refresh by locator
      // is the only way to see what an edit just did to it.
      page.window.document
        .querySelector("[data-tid=hero]")
        ?.setAttribute("style", "display: none");
      const after = parseCanvasElement(
        describeElement(page, 2, { tid: "hero" })?.result?.element,
      );
      expect(after).toMatchObject({
        inlineStyle: "display: none",
        tid: "hero",
        tagName: "p",
      });
      expect(after?.computedStyles).toContainEqual({
        property: "display",
        value: "none",
      });
    });

    it("finds the same element by its stamped marker", () => {
      const page = runCanvasPage(TAGGED);
      loaded(page);
      const element = parseCanvasElement(
        describeElement(page, 1, { marker: 0 })?.result?.element,
      );
      expect(element).toMatchObject({
        marker: 0,
        tid: "hero",
        generated: false,
      });
    });

    it.each([
      ["an unknown tid", { tid: "missing" }],
      ["an unknown marker", { marker: 12345 }],
      ["a locator naming nothing", {}],
    ])("answers no element for %s", (_label, locator) => {
      const page = runCanvasPage(TAGGED);
      loaded(page);
      expect(describeElement(page, 1, locator)?.result).toEqual({
        element: null,
        nonce: NONCE,
      });
    });

    it("answers no element when two share the tid", () => {
      const page = runCanvasPage(TAGGED);
      loaded(page);
      const twin = page.window.document.createElement("span");
      twin.setAttribute("data-tid", "hero");
      page.window.document.body.append(twin);
      expect(describeElement(page, 1, { tid: "hero" })?.result).toEqual({
        element: null,
        nonce: NONCE,
      });
    });

    it("answers nothing for a wrong nonce", () => {
      const page = runCanvasPage(TAGGED);
      loaded(page);
      page.deliver({
        ...request(1, "describe-element", { tid: "hero" }),
        params: { tid: "hero", nonce: "other" },
      });
      expect(page.canvasPosts()).toEqual([]);
    });
  });

  it("reports a page error with the nonce after load", () => {
    const page = runCanvasPage(MARKUP);
    loaded(page);
    // Built inside the page's realm, as the bootstrap's `instanceof` needs.
    const thrown: unknown = page.window.eval("new Error('boom')");
    page.window.dispatchEvent(
      new page.window.ErrorEvent("error", { message: "boom", error: thrown }),
    );
    const [error] = page.canvasPosts();
    expect(error.method).toBe("traycer/canvas/page-error");
    expect(error.params).toMatchObject({ message: "boom", nonce: NONCE });
    expect(typeof error.params?.stack).toBe("string");
  });

  it("keeps clicks from the page's own handlers while editing, and lets them through in play", () => {
    const page = runCanvasPage(MARKUP);
    loaded(page);
    let clicks = 0;
    const button = page.window.document.querySelector("button");
    button?.addEventListener("click", () => {
      clicks += 1;
    });
    const click = () =>
      button?.dispatchEvent(
        new page.window.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );

    click();
    expect(clicks).toBe(0);

    page.deliver(request(8, "set-mode", { mode: "play" }));
    click();
    expect(clicks).toBe(1);

    page.deliver(request(9, "set-mode", { mode: "edit" }));
    click();
    expect(clicks).toBe(1);
  });

  describe("Escape", () => {
    const shortcutPosts = (page: Page) =>
      page.posted.filter(
        (message) => message.method === "traycer/notifications/shortcut",
      );
    function pressEscape(page: Page, init: KeyboardEventInit): boolean {
      return page.window.document.body.dispatchEvent(
        new page.window.KeyboardEvent("keydown", {
          code: "Escape",
          key: "Escape",
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      );
    }

    it("tells the app about a bare Escape while editing, and keeps it from the page", () => {
      const page = runCanvasPage(MARKUP);
      loaded(page);
      let pageSaw = 0;
      page.window.document.body.addEventListener("keydown", () => {
        pageSaw += 1;
      });
      expect(pressEscape(page, {})).toBe(false);
      expect(pageSaw).toBe(0);
      expect(shortcutPosts(page)).toEqual([
        {
          jsonrpc: "2.0",
          method: "traycer/notifications/shortcut",
          params: {
            key: "Escape",
            code: "Escape",
            ctrl: false,
            meta: false,
            alt: false,
            shift: false,
            nonce: NONCE,
          },
        },
      ]);
    });

    it.each([
      ["Shift", { shiftKey: true }],
      ["Ctrl", { ctrlKey: true }],
      ["Meta", { metaKey: true }],
      ["Alt", { altKey: true }],
    ])("leaves Escape with %s to the page", (_label, init) => {
      const page = runCanvasPage(MARKUP);
      loaded(page);
      expect(pressEscape(page, init)).toBe(true);
      expect(shortcutPosts(page)).toEqual([]);
    });

    it("leaves other keys to the page", () => {
      const page = runCanvasPage(MARKUP);
      loaded(page);
      expect(pressEscape(page, { code: "KeyA", key: "a" })).toBe(true);
      expect(shortcutPosts(page)).toEqual([]);
    });

    it("leaves Escape to the page in play mode", () => {
      const page = runCanvasPage(MARKUP);
      loaded(page);
      page.deliver(request(1, "set-mode", { mode: "play" }));
      expect(pressEscape(page, {})).toBe(true);
      expect(shortcutPosts(page)).toEqual([]);
    });

    it("says nothing before the page has loaded", () => {
      const page = runCanvasPage(MARKUP);
      pressEscape(page, {});
      expect(shortcutPosts(page)).toEqual([]);
    });
  });

  describe("text selection refresh", () => {
    const selectionPosts = (page: Page) =>
      page.posted.filter(
        (message) => message.method === "traycer/canvas/text-selection",
      );
    /** The bootstrap builds its selection observer after the ordinary one. */
    const selectionObserver = (page: Page): ObserverRecord => {
      const record = page.observers.at(-1);
      if (record === undefined) throw new Error("no selection observer");
      return record;
    };
    function elementOf(page: Page, selector: string): Element {
      const target = page.window.document.querySelector(selector);
      if (target === null) throw new Error(`no ${selector}`);
      return target;
    }
    function select(page: Page, selector: string): void {
      const target = elementOf(page, selector);
      const range = page.window.document.createRange();
      range.selectNodeContents(target);
      const selection = page.window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    const changeSelection = (page: Page): void => {
      page.window.document.dispatchEvent(
        new page.window.Event("selectionchange"),
      );
    };

    it("reports a selection once per frame however many things asked", () => {
      const page = runCanvasPage(MARKUP);
      loaded(page);
      select(page, "p");
      changeSelection(page);
      page.window.dispatchEvent(new page.window.Event("resize"));
      page.window.document.body.dispatchEvent(new page.window.Event("scroll"));
      selectionObserver(page).callback();
      expect(selectionPosts(page)).toEqual([]);

      page.flushFrames();
      expect(selectionPosts(page)).toHaveLength(1);
      expect(selectionPosts(page)[0].params).toMatchObject({
        quote: "hello",
        start: 0,
        end: 5,
        nonce: NONCE,
      });
    });

    it("refreshes the same selection when the page scrolls, resizes or changes size", () => {
      const page = runCanvasPage(MARKUP);
      loaded(page);
      select(page, "p");
      changeSelection(page);
      page.flushFrames();

      page.window.document.body.dispatchEvent(new page.window.Event("scroll"));
      page.flushFrames();
      page.window.dispatchEvent(new page.window.Event("resize"));
      page.flushFrames();
      selectionObserver(page).callback();
      page.flushFrames();
      expect(selectionPosts(page)).toHaveLength(4);
    });

    it("watches the page root, and only the element that holds the selection", () => {
      const page = runCanvasPage(MARKUP);
      loaded(page);
      expect([...selectionObserver(page).observed]).toEqual([
        page.window.document.documentElement,
      ]);

      select(page, "p");
      changeSelection(page);
      page.flushFrames();
      const paragraph = elementOf(page, "p");
      const button = elementOf(page, "button");
      expect(selectionObserver(page).observed.has(paragraph)).toBe(true);

      select(page, "button");
      changeSelection(page);
      page.flushFrames();
      expect(selectionObserver(page).observed.has(button)).toBe(true);
      expect(selectionObserver(page).observed.has(paragraph)).toBe(false);
      expect(
        selectionObserver(page).observed.has(
          page.window.document.documentElement,
        ),
      ).toBe(true);
    });

    it("says nothing for a collapsed selection or one that spans the whole body", () => {
      const page = runCanvasPage(MARKUP);
      loaded(page);
      page.window.getSelection()?.removeAllRanges();
      page.window.dispatchEvent(new page.window.Event("resize"));
      page.flushFrames();
      expect(selectionPosts(page)).toEqual([]);

      const range = page.window.document.createRange();
      range.selectNodeContents(page.window.document.body);
      page.window.getSelection()?.addRange(range);
      page.window.dispatchEvent(new page.window.Event("resize"));
      page.flushFrames();
      expect(selectionPosts(page)).toEqual([]);
    });

    it("says nothing before the page has loaded", () => {
      const page = runCanvasPage(MARKUP);
      select(page, "p");
      changeSelection(page);
      page.flushFrames();
      expect(selectionPosts(page)).toEqual([]);
    });

    describe("with an explicit text target", () => {
      const NESTED = `<p data-tid="para">one <span>two</span> three</p><p>other</p>`;

      function targeted(target: Record<string, unknown> | null) {
        const page = runCanvasPage(NESTED);
        loaded(page);
        page.deliver(request(1, "set-text-selection-target", { target }));
        page.flushFrames();
        return page;
      }
      const lastSelection = (page: Page) => selectionPosts(page).at(-1)?.params;
      function selectText(
        page: Page,
        selector: string,
        from: number,
        to: number,
      ): void {
        const node = elementOf(page, selector).firstChild;
        if (node === null) throw new Error(`no text in ${selector}`);
        const range = page.window.document.createRange();
        range.setStart(node, from);
        range.setEnd(node, to);
        const selection = page.window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        changeSelection(page);
        page.flushFrames();
      }

      it("answers the request with the nonce", () => {
        const page = runCanvasPage(NESTED);
        loaded(page);
        page.deliver(
          request(7, "set-text-selection-target", { target: { tid: "para" } }),
        );
        expect(page.posted.find((message) => message.id === 7)?.result).toEqual(
          { nonce: NONCE },
        );
      });

      it("ignores a request with the wrong nonce or a malformed target", () => {
        const page = runCanvasPage(NESTED);
        loaded(page);
        page.deliver({
          ...request(1, "set-text-selection-target", {
            target: { tid: "para" },
          }),
          params: { target: { tid: "para" }, nonce: "other" },
        });
        page.deliver(
          request(2, "set-text-selection-target", { target: "para" }),
        );
        expect(
          page.posted.filter((message) => message.id === 1 || message.id === 2),
        ).toEqual([]);
      });

      it("measures offsets from the whole target even when the selection sits inside a nested span", () => {
        const page = targeted({ tid: "para" });
        selectText(page, "span", 0, 3);
        const params = lastSelection(page);
        expect(params).toMatchObject({
          quote: "two",
          start: 4,
          end: 7,
          nonce: NONCE,
        });
        expect(parseCanvasElement(params?.element)).toMatchObject({
          tid: "para",
          tagName: "p",
        });
        expect(
          page.window.document
            .querySelector("[data-tid=para]")
            ?.textContent.slice(4, 7),
        ).toBe("two");

        selectText(page, "span", 1, 3);
        expect(lastSelection(page)).toMatchObject({
          quote: "wo",
          start: 5,
          end: 7,
        });
      });

      it("reports a selection that spans the target's own text and its nested span", () => {
        const page = targeted({ tid: "para" });
        const paragraph = elementOf(page, "p");
        const span = elementOf(page, "span");
        const range = page.window.document.createRange();
        range.setStart(paragraph.firstChild ?? paragraph, 2);
        range.setEnd(span.firstChild ?? span, 2);
        page.window.getSelection()?.removeAllRanges();
        page.window.getSelection()?.addRange(range);
        changeSelection(page);
        page.flushFrames();
        expect(lastSelection(page)).toMatchObject({
          quote: "e tw",
          start: 2,
          end: 6,
        });
      });

      it("clears when the selection crosses out of the target", () => {
        const page = targeted({ tid: "para" });
        const paragraph = elementOf(page, "p");
        const other = page.window.document.querySelectorAll("p").item(1);
        const range = page.window.document.createRange();
        range.setStart(paragraph.firstChild ?? paragraph, 1);
        range.setEnd(other.firstChild ?? other, 2);
        page.window.getSelection()?.removeAllRanges();
        page.window.getSelection()?.addRange(range);
        changeSelection(page);
        page.flushFrames();
        expect(lastSelection(page)).toEqual({ selection: null, nonce: NONCE });
      });

      it("clears for a selection wholly outside the target, and when it collapses", () => {
        const page = targeted({ tid: "para" });
        selectText(page, "p:nth-of-type(2)", 0, 3);
        expect(lastSelection(page)).toEqual({ selection: null, nonce: NONCE });

        selectText(page, "span", 0, 3);
        expect(lastSelection(page)).toMatchObject({ quote: "two" });
        page.window.getSelection()?.removeAllRanges();
        changeSelection(page);
        page.flushFrames();
        expect(lastSelection(page)).toEqual({ selection: null, nonce: NONCE });
      });

      it("clears every selection for a target that matches nothing", () => {
        const page = targeted({ tid: "missing" });
        selectText(page, "span", 0, 3);
        expect(lastSelection(page)).toEqual({ selection: null, nonce: NONCE });
      });

      it("falls back to the common ancestor once the target is cleared", () => {
        const page = targeted({ tid: "para" });
        selectText(page, "span", 0, 3);
        expect(lastSelection(page)).toMatchObject({ start: 4 });

        page.deliver(request(2, "set-text-selection-target", { target: null }));
        page.flushFrames();
        const before = selectionPosts(page).length;
        selectText(page, "span", 0, 3);
        const params = lastSelection(page);
        expect(selectionPosts(page).length).toBeGreaterThan(before);
        expect(params).toMatchObject({ quote: "two", start: 0, end: 3 });
        expect(parseCanvasElement(params?.element)).toMatchObject({
          tagName: "span",
        });

        // No target again means a collapsed selection is silence, not a clear.
        const count = selectionPosts(page).length;
        page.window.getSelection()?.removeAllRanges();
        changeSelection(page);
        page.flushFrames();
        expect(selectionPosts(page)).toHaveLength(count);
      });
    });
  });

  describe("describing an element's markup", () => {
    const HERO = `<p data-tid="hero"></p>`;
    const byteLength = (value: string): number =>
      new TextEncoder().encode(value).length;
    function heroOf(page: Page): Element {
      const hero = page.window.document.querySelector("[data-tid=hero]");
      if (hero === null) throw new Error("no hero");
      return hero;
    }
    function describeHero(page: Page) {
      page.deliver(request(1, "describe-element", { tid: "hero" }));
      return parseCanvasElement(page.canvasPosts().at(-1)?.result?.element);
    }

    it("carries the element's complete outer HTML", () => {
      const page = runCanvasPage(
        `<p data-tid="hero" class="lead">Hello <em>there</em></p>`,
      );
      loaded(page);
      const described = describeHero(page);
      expect(described?.outerHtml).toBe(heroOf(page).outerHTML);
      // The stamp sits inside the tag, so match the element, not its exact tag.
      expect(described?.outerHtml).toMatch(/<em [^>]*>there<\/em>/);
    });

    it("sends markup of exactly 65536 UTF-8 bytes in full", () => {
      const page = runCanvasPage(HERO);
      loaded(page);
      const hero = heroOf(page);
      // Pad the text until the live element, stamp included, lands on the cap.
      hero.textContent = "a".repeat(65_536 - byteLength(hero.outerHTML));
      expect(byteLength(hero.outerHTML)).toBe(65_536);

      expect(describeHero(page)?.outerHtml).toBe(hero.outerHTML);
    });

    it("sends null, not a truncation, one byte over the cap", () => {
      const page = runCanvasPage(HERO);
      loaded(page);
      const hero = heroOf(page);
      hero.textContent = "a".repeat(65_537 - byteLength(hero.outerHTML));
      expect(byteLength(hero.outerHTML)).toBe(65_537);

      const described = describeHero(page);
      expect(described).toMatchObject({ tid: "hero", tagName: "p" });
      expect(described?.outerHtml).toBeNull();
    });

    it("counts bytes, not characters, when deciding what is too large", () => {
      const page = runCanvasPage(HERO);
      loaded(page);
      // 30000 three-byte characters: well under 65536 characters, 90000 bytes.
      heroOf(page).textContent = "€".repeat(30_000);
      expect(describeHero(page)?.outerHtml).toBeNull();
    });

    it("leaves markup off a hit-test", () => {
      const page = runCanvasPage(`<p data-tid="hero">hi</p>`);
      loaded(page);
      page.window.document.elementFromPoint = () =>
        page.window.document.querySelector("[data-tid=hero]");
      page.deliver(request(1, "hit-test", { x: 1, y: 1 }));
      const element = page.canvasPosts().at(-1)?.result?.element;
      expect(parseCanvasElement(element)?.outerHtml ?? null).toBeNull();
      expect(element).not.toHaveProperty("outerHtml");
    });
  });

  describe("the live text snapshot", () => {
    const HERO = `<p data-tid="hero"></p>`;
    const BUDGET = 65_536;
    const byteLength = (value: string): number =>
      new TextEncoder().encode(value).length;
    function heroOf(page: Page): Element {
      const hero = page.window.document.querySelector("[data-tid=hero]");
      if (hero === null) throw new Error("no hero");
      return hero;
    }
    function describeHero(page: Page) {
      page.deliver(request(1, "describe-element", { tid: "hero" }));
      return parseCanvasElement(page.canvasPosts().at(-1)?.result?.element);
    }
    function loadedPage(markup: string): Page {
      const page = runCanvasPage(markup);
      loaded(page);
      return page;
    }

    it("reports the text of an element that holds only text", () => {
      const page = loadedPage(`<p data-tid="hero">Hello world</p>`);
      expect(describeHero(page)?.textSnapshot).toEqual({
        content: "Hello world",
        nodes: ["Hello world"],
        textOnly: true,
      });
    });

    it("reports an empty element as text-only with nothing in it", () => {
      expect(describeHero(loadedPage(HERO))?.textSnapshot).toEqual({
        content: "",
        nodes: [],
        textOnly: true,
      });
    });

    it("reports mixed content as not text-only, with the text beside the elements", () => {
      const page = loadedPage(`<p data-tid="hero">Hello <b>big</b> world</p>`);
      expect(describeHero(page)?.textSnapshot).toEqual({
        content: "Hello big world",
        nodes: ["Hello ", " world"],
        textOnly: false,
      });
    });

    it("reports a lone text node beside an element as a node, not text-only", () => {
      const page = loadedPage(`<h1 data-tid="hero">Title <i>x</i></h1>`);
      expect(describeHero(page)?.textSnapshot).toEqual({
        content: "Title x",
        nodes: ["Title "],
        textOnly: false,
      });
    });

    it("reports the text as it is now, after the page changed it", () => {
      const page = loadedPage(`<p data-tid="hero">Before</p>`);
      heroOf(page).textContent = "After a script ran";
      expect(describeHero(page)?.textSnapshot?.content).toBe(
        "After a script ran",
      );
    });

    it("reports entities decoded, as the page reads them", () => {
      const page = loadedPage(`<p data-tid="hero">a &amp; b</p>`);
      expect(describeHero(page)?.textSnapshot?.content).toBe("a & b");
    });

    it("sends it with a double-click too", () => {
      const page = loadedPage(`<p data-tid="hero">Hello</p>`);
      page.deliver(
        request(7, "set-text-selection-target", { target: { tid: "hero" } }),
      );
      heroOf(page).dispatchEvent(
        new page.window.MouseEvent("dblclick", {
          bubbles: true,
          cancelable: true,
        }),
      );
      const posted = page.posted.find(
        (message) => message.method === "traycer/canvas/double-click",
      );
      expect(parseCanvasElement(posted?.params?.element)?.textSnapshot).toEqual(
        {
          content: "Hello",
          nodes: ["Hello"],
          textOnly: true,
        },
      );
    });

    it("leaves it off a hit-test", () => {
      const page = loadedPage(`<p data-tid="hero">hi</p>`);
      page.window.document.elementFromPoint = () => heroOf(page);
      page.deliver(request(1, "hit-test", { x: 1, y: 1 }));
      const element = page.canvasPosts().at(-1)?.result?.element;
      expect(element).not.toHaveProperty("textSnapshot");
    });

    it("sends content and nodes of exactly 65536 bytes together in full", () => {
      const page = loadedPage(HERO);
      // One text node counts twice: once as the content, once as the node.
      heroOf(page).textContent = "a".repeat(BUDGET / 2);
      const snapshot = describeHero(page)?.textSnapshot;
      expect(snapshot).not.toBeNull();
      expect(
        byteLength(snapshot?.content ?? "") +
          (snapshot?.nodes ?? []).reduce(
            (sum, node) => sum + byteLength(node),
            0,
          ),
      ).toBe(BUDGET);
    });

    it("sends null, not a truncation, one byte over the budget", () => {
      const page = loadedPage(HERO);
      heroOf(page).textContent = "a".repeat(BUDGET / 2 + 1);
      const described = describeHero(page);
      expect(described).toMatchObject({ tid: "hero", tagName: "p" });
      expect(described?.textSnapshot).toBeNull();
    });

    it("counts bytes, not characters, against the budget", () => {
      const page = loadedPage(HERO);
      heroOf(page).textContent = "€".repeat(11_000);
      expect(describeHero(page)?.textSnapshot).toBeNull();
    });

    it("sends null when an element has more than 1024 direct text nodes", () => {
      const page = loadedPage(HERO);
      const hero = heroOf(page);
      const nodes = (count: number): Text[] =>
        Array.from({ length: count }, () =>
          page.window.document.createTextNode("x"),
        );
      hero.append(...nodes(1024));
      expect(describeHero(page)?.textSnapshot?.nodes).toHaveLength(1024);

      hero.append(...nodes(1));
      expect(describeHero(page)?.textSnapshot).toBeNull();
    });
  });

  describe("double-click to retype", () => {
    const TEXT = `<p data-tid="para">one <span>two</span> three</p><p data-tid="other">other</p>`;
    const doubleClickPosts = (page: Page) =>
      page.posted.filter(
        (message) => message.method === "traycer/canvas/double-click",
      );

    function target(page: Page, locator: Record<string, unknown> | null): void {
      page.deliver(
        request(100, "set-text-selection-target", { target: locator }),
      );
    }
    function doubleClick(page: Page, selector: string): boolean {
      const element = page.window.document.querySelector(selector);
      if (element === null) throw new Error(`no ${selector}`);
      return element.dispatchEvent(
        new page.window.MouseEvent("dblclick", {
          bubbles: true,
          cancelable: true,
        }),
      );
    }

    it("reports the text target when it is double-clicked in Edit", () => {
      const page = runCanvasPage(TEXT);
      loaded(page);
      target(page, { tid: "para" });
      doubleClick(page, "[data-tid=para]");

      expect(doubleClickPosts(page)).toHaveLength(1);
      const params = doubleClickPosts(page)[0].params;
      expect(params?.nonce).toBe(NONCE);
      expect(parseCanvasElement(params?.element)).toMatchObject({
        tid: "para",
        tagName: "p",
      });
    });

    it("reports the target, not the nested element that was hit", () => {
      const page = runCanvasPage(TEXT);
      loaded(page);
      target(page, { tid: "para" });
      doubleClick(page, "span");

      expect(
        parseCanvasElement(doubleClickPosts(page)[0].params?.element),
      ).toMatchObject({ tid: "para", tagName: "p" });
    });

    it("keeps the double-click from the authored page and from the browser", () => {
      const page = runCanvasPage(TEXT);
      loaded(page);
      target(page, { tid: "para" });
      let pageSaw = 0;
      page.window.document
        .querySelector("[data-tid=para]")
        ?.addEventListener("dblclick", () => {
          pageSaw += 1;
        });

      // false means preventDefault ran, which also stops the word selection.
      expect(doubleClick(page, "span")).toBe(false);
      expect(pageSaw).toBe(0);
    });

    it("says nothing for a double-click outside the text target", () => {
      const page = runCanvasPage(TEXT);
      loaded(page);
      target(page, { tid: "para" });
      let pageSaw = 0;
      page.window.document
        .querySelector("[data-tid=other]")
        ?.addEventListener("dblclick", () => {
          pageSaw += 1;
        });

      expect(doubleClick(page, "[data-tid=other]")).toBe(true);
      expect(doubleClickPosts(page)).toEqual([]);
      expect(pageSaw).toBe(1);
    });

    it("says nothing when no text target was set", () => {
      const page = runCanvasPage(TEXT);
      loaded(page);
      expect(doubleClick(page, "[data-tid=para]")).toBe(true);
      expect(doubleClickPosts(page)).toEqual([]);
    });

    it("stops reporting once the text target is cleared", () => {
      const page = runCanvasPage(TEXT);
      loaded(page);
      target(page, { tid: "para" });
      target(page, null);
      expect(doubleClick(page, "[data-tid=para]")).toBe(true);
      expect(doubleClickPosts(page)).toEqual([]);
    });

    it("says nothing for a target that no longer resolves to one element", () => {
      const page = runCanvasPage(TEXT);
      loaded(page);
      target(page, { tid: "missing" });
      expect(doubleClick(page, "[data-tid=para]")).toBe(true);
      expect(doubleClickPosts(page)).toEqual([]);
    });

    it("does nothing in play mode, so the page's own handler runs", () => {
      const page = runCanvasPage(TEXT);
      loaded(page);
      target(page, { tid: "para" });
      page.deliver(request(101, "set-mode", { mode: "play" }));
      let pageSaw = 0;
      page.window.document
        .querySelector("[data-tid=para]")
        ?.addEventListener("dblclick", () => {
          pageSaw += 1;
        });

      expect(doubleClick(page, "[data-tid=para]")).toBe(true);
      expect(pageSaw).toBe(1);
      expect(doubleClickPosts(page)).toEqual([]);
    });

    it("reports again when Edit mode returns", () => {
      const page = runCanvasPage(TEXT);
      loaded(page);
      target(page, { tid: "para" });
      page.deliver(request(101, "set-mode", { mode: "play" }));
      page.deliver(request(102, "set-mode", { mode: "edit" }));
      doubleClick(page, "[data-tid=para]");
      expect(doubleClickPosts(page)).toHaveLength(1);
    });

    it("says nothing before the page has loaded", () => {
      const page = runCanvasPage(TEXT);
      doubleClick(page, "[data-tid=para]");
      expect(doubleClickPosts(page)).toEqual([]);
    });

    it("sends one report per double-click", () => {
      const page = runCanvasPage(TEXT);
      loaded(page);
      target(page, { tid: "para" });
      doubleClick(page, "[data-tid=para]");
      doubleClick(page, "span");
      expect(doubleClickPosts(page)).toHaveLength(2);
    });
  });

  describe("retype and text-range requests from the editing overlay", () => {
    const TEXT = `<p data-tid="para">one <span>two</span> three</p><p data-tid="other">other</p>`;
    const doubleClickPosts = (page: Page) =>
      page.posted.filter(
        (message) => message.method === "traycer/canvas/double-click",
      );
    const selectionPosts = (page: Page) =>
      page.posted.filter(
        (message) => message.method === "traycer/canvas/text-selection",
      );
    function elementOf(page: Page, selector: string): Element {
      const found = page.window.document.querySelector(selector);
      if (found === null) throw new Error(`no ${selector}`);
      return found;
    }
    /** jsdom has no layout, so the test says what is under the point. */
    function stubElementFromPoint(page: Page, under: Element | null): void {
      Object.defineProperty(page.window.document, "elementFromPoint", {
        configurable: true,
        value: () => under,
      });
    }

    describe("retype-at", () => {
      it("reports the nearest literal block with its full text when the point is over a nested inline", () => {
        const page = runCanvasPage(TEXT);
        loaded(page);
        stubElementFromPoint(page, elementOf(page, "span"));
        page.deliver(request(1, "retype-at", { x: 5, y: 5 }));

        expect(page.posted.find((message) => message.id === 1)?.result).toEqual(
          { nonce: NONCE },
        );
        expect(doubleClickPosts(page)).toHaveLength(1);
        expect(
          parseCanvasElement(doubleClickPosts(page)[0].params?.element),
        ).toMatchObject({
          tid: "para",
          tagName: "p",
          textSnapshot: {
            content: "one two three",
            nodes: ["one ", " three"],
            textOnly: false,
          },
        });
      });

      it("says nothing in play mode", () => {
        const page = runCanvasPage(TEXT);
        loaded(page);
        page.deliver(request(1, "set-mode", { mode: "play" }));
        stubElementFromPoint(page, elementOf(page, "span"));
        page.deliver(request(2, "retype-at", { x: 5, y: 5 }));

        expect(page.posted.find((message) => message.id === 2)?.result).toEqual(
          { nonce: NONCE },
        );
        expect(doubleClickPosts(page)).toEqual([]);
      });

      it("says nothing for a point over the page background or nothing at all", () => {
        const page = runCanvasPage(TEXT);
        loaded(page);
        stubElementFromPoint(page, page.window.document.body);
        page.deliver(request(1, "retype-at", { x: 5, y: 5 }));
        stubElementFromPoint(page, null);
        page.deliver(request(2, "retype-at", { x: 5, y: 5 }));

        expect(doubleClickPosts(page)).toEqual([]);
      });
    });

    describe("select-text-range", () => {
      /** Maps a point's x to the text node and offset the caret would land on. */
      function stubCaret(
        page: Page,
        carets: Record<number, { selector: string; offset: number }>,
      ): void {
        Object.defineProperty(page.window.document, "caretPositionFromPoint", {
          configurable: true,
          value: (x: number) => {
            const caret = carets[x];
            return {
              offsetNode: elementOf(page, caret.selector).firstChild,
              offset: caret.offset,
            };
          },
        });
      }
      function targeted() {
        const page = runCanvasPage(TEXT);
        loaded(page);
        page.deliver(
          request(1, "set-text-selection-target", { target: { tid: "para" } }),
        );
        page.flushFrames();
        return page;
      }
      const range = {
        start: { x: 1, y: 0 },
        end: { x: 2, y: 0 },
      };

      it("selects the real text between two points inside the target and reports its quote", () => {
        const page = targeted();
        stubCaret(page, {
          1: { selector: "[data-tid=para]", offset: 1 },
          2: { selector: "span", offset: 2 },
        });
        page.deliver(request(2, "select-text-range", range));
        page.flushFrames();

        expect(page.posted.find((message) => message.id === 2)?.result).toEqual(
          { nonce: NONCE },
        );
        const selection = page.window.getSelection();
        expect(selection?.rangeCount).toBe(1);
        expect(selection?.getRangeAt(0).toString()).toBe("ne tw");
        expect(selectionPosts(page).at(-1)?.params).toMatchObject({
          quote: "ne tw",
          start: 1,
          end: 6,
          nonce: NONCE,
        });
      });

      it("selects nothing when either end lands outside the target", () => {
        const page = targeted();
        const before = selectionPosts(page).length;
        stubCaret(page, {
          1: { selector: "[data-tid=para]", offset: 1 },
          2: { selector: "[data-tid=other]", offset: 3 },
        });
        page.deliver(request(2, "select-text-range", range));
        page.flushFrames();

        expect(page.window.getSelection()?.rangeCount).toBe(0);
        expect(selectionPosts(page)).toHaveLength(before);
      });

      it("selects nothing in play mode", () => {
        const page = targeted();
        page.deliver(request(3, "set-mode", { mode: "play" }));
        stubCaret(page, {
          1: { selector: "[data-tid=para]", offset: 1 },
          2: { selector: "span", offset: 2 },
        });
        page.deliver(request(4, "select-text-range", range));

        expect(page.window.getSelection()?.rangeCount).toBe(0);
      });
    });
  });

  describe("relative links", () => {
    function clickAnchor(page: Page, href: string): boolean {
      const anchor = page.window.document.createElement("a");
      anchor.setAttribute("href", href);
      page.window.document.body.append(anchor);
      return anchor.dispatchEvent(
        new page.window.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    }
    const linkPosts = (page: Page) =>
      page.posted.filter(
        (message) => message.method === "traycer/canvas/relative-link",
      );

    it("forwards a same-origin link in play and stops the navigation", () => {
      const page = runCanvasPage(MARKUP);
      loaded(page);
      page.deliver(request(1, "set-mode", { mode: "play" }));
      expect(clickAnchor(page, "other.html#part")).toBe(false);
      expect(linkPosts(page)).toEqual([
        {
          jsonrpc: "2.0",
          method: "traycer/canvas/relative-link",
          params: { href: "other.html#part", nonce: NONCE },
        },
      ]);
    });

    it("forwards nothing while editing", () => {
      const page = runCanvasPage(MARKUP);
      loaded(page);
      clickAnchor(page, "other.html");
      expect(linkPosts(page)).toEqual([]);
    });

    it.each([
      ["a hash within this page", "#section"],
      ["an external page", "https://example.com/x.html"],
    ])("forwards nothing for %s in play", (_label, href) => {
      const page = runCanvasPage(MARKUP);
      loaded(page);
      page.deliver(request(1, "set-mode", { mode: "play" }));
      clickAnchor(page, href);
      expect(linkPosts(page)).toEqual([]);
    });
  });
});

/**
 * The tests above run the scripts by hand, after the page exists. A startup
 * failure is different: the page's own inline script throws while the
 * document is still being parsed, before `load`. Only a real parse of the
 * composed document, with jsdom executing its inline scripts in order,
 * shows what the prelude catches.
 */
describe("startup errors in a real composed document", () => {
  const PAGE_ERROR = "traycer/canvas/page-error";
  const READY = "traycer/notifications/document-ready";

  async function loadComposed(markup: string, canvas: boolean) {
    const composed = buildArtifactDocument(markup, optionsFor(canvas));
    const posted: Posted[] = [];
    const dom = new JSDOM(composed, {
      runScripts: "dangerously",
      url: "https://sandbox.test/page.html",
      // A script that throws is the point; keep jsdom from printing it.
      virtualConsole: new VirtualConsole(),
      beforeParse(window) {
        window.postMessage = (message: Posted) => {
          posted.push(message);
        };
        window.ResizeObserver = class {
          observe(): void {
            return;
          }
          unobserve(): void {
            return;
          }
        };
        window.requestAnimationFrame = () => 0;
      },
    });
    const { window } = dom;
    windows.push(window);
    await new Promise<void>((resolve) => {
      window.addEventListener("load", () => resolve(), { once: true });
    });
    return { window, posted };
  }

  const pageErrors = (posted: readonly Posted[]) =>
    posted.filter((message) => message.method === PAGE_ERROR);
  const readyIndex = (posted: readonly Posted[]) =>
    posted.findIndex((message) => message.method === READY);
  const messages = (posted: readonly Posted[]) =>
    pageErrors(posted).map((message) => String(message.params?.message));

  it("reports a script that throws while the page loads, after document-ready", async () => {
    const { posted } = await loadComposed(
      `<p>hi</p><script>throw new Error("first-err")</script>`,
      true,
    );
    const ready = readyIndex(posted);
    const first = posted.findIndex((message) => message.method === PAGE_ERROR);
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(first).toBeGreaterThan(ready);
    // Nothing reached the host before the document proved its nonce.
    expect(
      posted.slice(0, ready).filter((message) => message.method === PAGE_ERROR),
    ).toEqual([]);

    const [error] = pageErrors(posted);
    expect(error.params).toMatchObject({ nonce: NONCE });
    expect(error.params?.message).toContain("first-err");
    expect(error.params?.stack).toEqual(expect.stringContaining("first-err"));
  });

  it("reports a startup rejection the same way, with its stack", async () => {
    const { posted } = await loadComposed(
      `<p>hi</p><script>
        var rejection = new Event("unhandledrejection");
        rejection.reason = new Error("rejected-x");
        window.dispatchEvent(rejection);
      </script>`,
      true,
    );
    const [error] = pageErrors(posted);
    expect(posted.indexOf(error)).toBeGreaterThan(readyIndex(posted));
    expect(error.params).toMatchObject({ message: "rejected-x", nonce: NONCE });
    expect(error.params?.stack).toEqual(expect.stringContaining("rejected-x"));
  });

  it("keeps startup errors in the order they happened", async () => {
    const { posted } = await loadComposed(
      `<script>throw new Error("first-err")</script>
       <script>
         var rejection = new Event("unhandledrejection");
         rejection.reason = new Error("second-rej");
         window.dispatchEvent(rejection);
       </script>
       <script>throw new Error("third-err")</script>`,
      true,
    );
    const found = messages(posted);
    expect(found).toHaveLength(3);
    expect(found[0]).toContain("first-err");
    expect(found[1]).toContain("second-rej");
    expect(found[2]).toContain("third-err");
  });

  it("keeps only the first eight startup errors", async () => {
    const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
    const scripts = names
      .map((name) => `<script>throw new Error("err-${name}")</script>`)
      .join("");
    const { posted } = await loadComposed(`<p>hi</p>${scripts}`, true);
    const found = messages(posted);
    expect(found).toHaveLength(8);
    found.forEach((message, index) => {
      expect(message).toContain(`err-${names[index]}`);
    });
    expect(found.join(" ")).not.toContain("err-i");
  });

  it("sends errors that happen after load immediately, past the startup bound", async () => {
    const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const scripts = names
      .map((name) => `<script>throw new Error("err-${name}")</script>`)
      .join("");
    const { window, posted } = await loadComposed(scripts, true);
    expect(pageErrors(posted)).toHaveLength(8);

    const live: unknown = window.eval("new Error('live-now')");
    window.dispatchEvent(
      new window.ErrorEvent("error", { message: "live-now", error: live }),
    );
    expect(pageErrors(posted)).toHaveLength(9);
    expect(pageErrors(posted).at(-1)?.params).toMatchObject({
      message: "live-now",
      nonce: NONCE,
    });
  });

  it("posts nothing for a page that starts cleanly", async () => {
    const { posted } = await loadComposed(`<p>fine</p>`, true);
    expect(readyIndex(posted)).toBeGreaterThanOrEqual(0);
    expect(pageErrors(posted)).toEqual([]);
  });

  it("is not a canvas channel on an ordinary document", async () => {
    const { posted } = await loadComposed(
      `<p>hi</p><script>throw new Error("first-err")</script>`,
      false,
    );
    expect(pageErrors(posted)).toEqual([]);
    // The ordinary bootstrap still tells the app about the early error.
    expect(
      posted.some(
        (message) => message.method === "traycer/notifications/early-error",
      ),
    ).toBe(true);
  });
});
