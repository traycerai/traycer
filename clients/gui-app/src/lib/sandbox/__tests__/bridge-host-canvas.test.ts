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
  LOAD_TIMEOUT_MS,
  PING_TIMEOUT_MS,
  SandboxBridgeHost,
  type SandboxHostContext,
  type SandboxShortcutPress,
} from "../bridge-host";
import type {
  CanvasElement,
  CanvasPageError,
  CanvasTextSelection,
} from "../canvas-bridge";

const NONCE = "canvas-nonce";

const HOST_CONTEXT: SandboxHostContext = {
  theme: "light",
  styles: { variables: {} },
  displayMode: "inline",
  availableDisplayModes: ["inline"],
  platform: "desktop",
};

type Sent = Readonly<Record<string, unknown>>;

function isSent(value: unknown): value is Sent {
  return typeof value === "object" && value !== null;
}

const BOX = { x: 4, y: 5, width: 60, height: 20 };

function element(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    marker: 7,
    tid: null,
    tagName: "p",
    selector: "p",
    elementId: null,
    classNames: [],
    textPreview: "hi",
    inlineStyle: "",
    ariaRole: null,
    accessibleName: null,
    box: BOX,
    computedStyles: [],
    generated: false,
    ...overrides,
  };
}

interface Harness {
  readonly host: SandboxBridgeHost;
  readonly sent: Sent[];
  readonly onTextSelection: Mock<
    (selection: CanvasTextSelection | null) => void
  >;
  readonly onPageError: Mock<(error: CanvasPageError) => void>;
  readonly onRelativeLink: Mock<(href: string) => void>;
  readonly onDoubleClick: Mock<(element: CanvasElement) => void>;
  readonly onShortcut: Mock<(press: SandboxShortcutPress) => void>;
  /** The newest request posted with this method. */
  readonly requestOf: (method: string) => Sent;
}

const hosts: SandboxBridgeHost[] = [];

function createHarness(options: {
  readonly canvas: boolean;
  readonly ready: boolean;
}): Harness {
  const sent: Sent[] = [];
  const onTextSelection =
    vi.fn<(selection: CanvasTextSelection | null) => void>();
  const onPageError = vi.fn<(error: CanvasPageError) => void>();
  const onRelativeLink = vi.fn<(href: string) => void>();
  const onDoubleClick = vi.fn<(element: CanvasElement) => void>();
  const onShortcut = vi.fn<(press: SandboxShortcutPress) => void>();
  const host = new SandboxBridgeHost({
    document: {
      kind: "served",
      canvas: options.canvas,
      nonce: NONCE,
      forwardedShortcuts: [],
      pages: null,
    },
    hostContext: HOST_CONTEXT,
    hostVersion: "9.9.9",
    post: (message) => {
      if (isSent(message)) sent.push(message);
    },
    events: {
      onStatus: () => undefined,
      onSize: () => undefined,
      onOpenLink: () => Promise.resolve(true),
      onShortcut,
      onRequestTeardown: () => undefined,
      onScrollGesture: () => undefined,
      onWheel: () => undefined,
      onTextSelection,
      onPageError,
      onRelativeLink,
      onDoubleClick,
    },
    appRequests: null,
  });
  hosts.push(host);
  if (options.ready) {
    host.receive({
      jsonrpc: "2.0",
      method: "traycer/notifications/document-ready",
      params: { nonce: NONCE, height: 120 },
    });
  }
  return {
    host,
    sent,
    onTextSelection,
    onPageError,
    onRelativeLink,
    onDoubleClick,
    onShortcut,
    requestOf: (method) => {
      const found = sent.filter((message) => message.method === method).at(-1);
      if (found === undefined)
        throw new Error(`no ${method} request was posted`);
      return found;
    },
  };
}

function notification(method: string, params: unknown): Sent {
  return { jsonrpc: "2.0", method, params };
}

function respond(request: Sent, result: unknown): Sent {
  return { jsonrpc: "2.0", id: request.id, result };
}

function canvasRequests(harness: Harness): Sent[] {
  return harness.sent.filter(
    (message) =>
      typeof message.method === "string" &&
      message.method.startsWith("traycer/canvas/"),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
  vi.useRealTimers();
});

describe("canvas requests", () => {
  it("posts a hit-test carrying the nonce and resolves the parsed element", async () => {
    const harness = createHarness({ canvas: true, ready: true });
    const answer = harness.host.hitTest({ x: 10, y: 20 });

    const request = harness.requestOf("traycer/canvas/hit-test");
    expect(request).toMatchObject({
      jsonrpc: "2.0",
      method: "traycer/canvas/hit-test",
      params: { x: 10, y: 20, nonce: NONCE },
    });
    harness.host.receive(
      respond(request, { element: element({}), nonce: NONCE }),
    );

    const resolved: CanvasElement | null = await answer;
    expect(resolved).toMatchObject({ marker: 7, tagName: "p", box: BOX });
  });

  it("resolves null for a hit-test that landed on nothing", async () => {
    const harness = createHarness({ canvas: true, ready: true });
    const answer = harness.host.hitTest({ x: 1, y: 1 });
    harness.host.receive(
      respond(harness.requestOf("traycer/canvas/hit-test"), {
        element: null,
        nonce: NONCE,
      }),
    );
    await expect(answer).resolves.toBeNull();
  });

  it("resolves null for an element that breaks the parser's limits", async () => {
    const harness = createHarness({ canvas: true, ready: true });
    const answer = harness.host.hitTest({ x: 1, y: 1 });
    harness.host.receive(
      respond(harness.requestOf("traycer/canvas/hit-test"), {
        element: element({ selector: "s".repeat(1001) }),
        nonce: NONCE,
      }),
    );
    await expect(answer).resolves.toBeNull();
  });

  it.each([
    ["NaN x", { x: Number.NaN, y: 0 }],
    ["Infinity y", { x: 0, y: Number.POSITIVE_INFINITY }],
  ])(
    "refuses a hit-test with %s without posting anything",
    async (_label, point) => {
      const harness = createHarness({ canvas: true, ready: true });
      await expect(harness.host.hitTest(point)).resolves.toBeNull();
      expect(canvasRequests(harness)).toEqual([]);
    },
  );

  it("asks for an element box by marker and by tid", async () => {
    const harness = createHarness({ canvas: true, ready: true });

    const byMarker = harness.host.elementBox({ marker: 42 });
    const markerRequest = harness.requestOf("traycer/canvas/element-box");
    expect(markerRequest.params).toEqual({ marker: 42, nonce: NONCE });
    harness.host.receive(respond(markerRequest, { box: BOX, nonce: NONCE }));
    await expect(byMarker).resolves.toEqual(BOX);

    const byTid = harness.host.elementBox({ tid: "hero" });
    const tidRequest = harness.requestOf("traycer/canvas/element-box");
    expect(tidRequest.params).toEqual({ tid: "hero", nonce: NONCE });
    harness.host.receive(respond(tidRequest, { box: null, nonce: NONCE }));
    await expect(byTid).resolves.toBeNull();
  });

  it("asks the page to reveal an element and resolves with whether it found one", async () => {
    const harness = createHarness({ canvas: true, ready: true });

    const found = harness.host.revealElement({ tid: "hero" });
    const foundRequest = harness.requestOf("traycer/canvas/reveal-element");
    expect(foundRequest.params).toEqual({ tid: "hero", nonce: NONCE });
    harness.host.receive(
      respond(foundRequest, { revealed: true, nonce: NONCE }),
    );
    await expect(found).resolves.toBe(true);

    const missing = harness.host.revealElement({ tid: "gone" });
    harness.host.receive(
      respond(harness.requestOf("traycer/canvas/reveal-element"), {
        revealed: false,
        nonce: NONCE,
      }),
    );
    await expect(missing).resolves.toBe(false);
  });

  it("resolves null for a malformed box", async () => {
    const harness = createHarness({ canvas: true, ready: true });
    const answer = harness.host.elementBox({ marker: 1 });
    harness.host.receive(
      respond(harness.requestOf("traycer/canvas/element-box"), {
        box: { ...BOX, width: -4 },
        nonce: NONCE,
      }),
    );
    await expect(answer).resolves.toBeNull();
  });

  it("sets and clears the text selection target, resolving true on the page's answer", async () => {
    const harness = createHarness({ canvas: true, ready: true });

    const set = harness.host.setTextSelectionTarget({ tid: "para" });
    const setRequest = harness.requestOf(
      "traycer/canvas/set-text-selection-target",
    );
    expect(setRequest.params).toEqual({
      target: { tid: "para" },
      nonce: NONCE,
    });
    harness.host.receive(respond(setRequest, { nonce: NONCE }));
    await expect(set).resolves.toBe(true);

    const clear = harness.host.setTextSelectionTarget(null);
    const clearRequest = harness.requestOf(
      "traycer/canvas/set-text-selection-target",
    );
    expect(clearRequest.params).toEqual({ target: null, nonce: NONCE });
    harness.host.receive(respond(clearRequest, { nonce: NONCE }));
    await expect(clear).resolves.toBe(true);
  });

  it("resolves false for a target request that is never answered or answered with the wrong nonce", async () => {
    const harness = createHarness({ canvas: true, ready: true });
    const answer = harness.host.setTextSelectionTarget({ marker: 3 });
    harness.host.receive(
      respond(harness.requestOf("traycer/canvas/set-text-selection-target"), {
        nonce: "other",
      }),
    );
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    await expect(answer).resolves.toBe(false);
  });

  it("asks to describe an element by tid or marker and resolves the parsed element", async () => {
    const harness = createHarness({ canvas: true, ready: true });

    const byTid = harness.host.describeElement({ tid: "hero" });
    const tidRequest = harness.requestOf("traycer/canvas/describe-element");
    expect(tidRequest.params).toEqual({ tid: "hero", nonce: NONCE });
    harness.host.receive(
      respond(tidRequest, {
        element: element({ inlineStyle: "display: none" }),
        nonce: NONCE,
      }),
    );
    await expect(byTid).resolves.toMatchObject({
      marker: 7,
      inlineStyle: "display: none",
    });

    const byMarker = harness.host.describeElement({ marker: 7 });
    const markerRequest = harness.requestOf("traycer/canvas/describe-element");
    expect(markerRequest.params).toEqual({ marker: 7, nonce: NONCE });
    harness.host.receive(
      respond(markerRequest, { element: null, nonce: NONCE }),
    );
    await expect(byMarker).resolves.toBeNull();
  });

  it("resolves null for a described element that breaks the parser's limits, or never answers", async () => {
    const harness = createHarness({ canvas: true, ready: true });
    const malformed = harness.host.describeElement({ tid: "hero" });
    harness.host.receive(
      respond(harness.requestOf("traycer/canvas/describe-element"), {
        element: element({ inlineStyle: "s".repeat(16_001) }),
        nonce: NONCE,
      }),
    );
    await expect(malformed).resolves.toBeNull();

    const silent = harness.host.describeElement({ tid: "hero" });
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    await expect(silent).resolves.toBeNull();
  });

  it("resolves the complete markup a described element carries", async () => {
    const harness = createHarness({ canvas: true, ready: true });
    const markup = '<p class="lead">\n  Hello <em>there</em>\n</p>';
    const answer = harness.host.describeElement({ tid: "hero" });
    harness.host.receive(
      respond(harness.requestOf("traycer/canvas/describe-element"), {
        element: element({ outerHtml: markup }),
        nonce: NONCE,
      }),
    );
    await expect(answer).resolves.toMatchObject({ outerHtml: markup });
  });

  it("still describes an element whose markup was too large to send", async () => {
    const harness = createHarness({ canvas: true, ready: true });
    const answer = harness.host.describeElement({ marker: 7 });
    harness.host.receive(
      respond(harness.requestOf("traycer/canvas/describe-element"), {
        element: element({ outerHtml: null }),
        nonce: NONCE,
      }),
    );
    const described = await answer;
    expect(described).toMatchObject({ marker: 7 });
    expect(described?.outerHtml ?? null).toBeNull();
  });

  it("resolves null for a described element whose markup exceeds 65536 bytes", async () => {
    const harness = createHarness({ canvas: true, ready: true });
    const answer = harness.host.describeElement({ tid: "hero" });
    harness.host.receive(
      respond(harness.requestOf("traycer/canvas/describe-element"), {
        element: element({ outerHtml: "a".repeat(65_537) }),
        nonce: NONCE,
      }),
    );
    await expect(answer).resolves.toBeNull();
  });

  it("resolves null for a described element whose markup is not a string", async () => {
    const harness = createHarness({ canvas: true, ready: true });
    const answer = harness.host.describeElement({ tid: "hero" });
    harness.host.receive(
      respond(harness.requestOf("traycer/canvas/describe-element"), {
        element: element({ outerHtml: 7 }),
        nonce: NONCE,
      }),
    );
    await expect(answer).resolves.toBeNull();
  });

  it("resolves the text snapshot a described element carries", async () => {
    const harness = createHarness({ canvas: true, ready: true });
    const snapshot = { content: "ac", nodes: ["a", "c"], textOnly: false };
    const answer = harness.host.describeElement({ tid: "hero" });
    harness.host.receive(
      respond(harness.requestOf("traycer/canvas/describe-element"), {
        element: element({ textSnapshot: snapshot }),
        nonce: NONCE,
      }),
    );
    await expect(answer).resolves.toMatchObject({ textSnapshot: snapshot });
  });

  it("still describes an element whose text was too big to snapshot", async () => {
    const harness = createHarness({ canvas: true, ready: true });
    const answer = harness.host.describeElement({ tid: "hero" });
    harness.host.receive(
      respond(harness.requestOf("traycer/canvas/describe-element"), {
        element: element({ textSnapshot: null }),
        nonce: NONCE,
      }),
    );
    const described = await answer;
    expect(described).toMatchObject({ marker: 7 });
    expect(described?.textSnapshot ?? null).toBeNull();
  });

  it("resolves null for a described element with an over-budget snapshot", async () => {
    const harness = createHarness({ canvas: true, ready: true });
    const answer = harness.host.describeElement({ tid: "hero" });
    harness.host.receive(
      respond(harness.requestOf("traycer/canvas/describe-element"), {
        element: element({
          textSnapshot: {
            content: "a".repeat(65_537),
            nodes: [],
            textOnly: true,
          },
        }),
        nonce: NONCE,
      }),
    );
    await expect(answer).resolves.toBeNull();
  });

  it("does not ask for markup on a hit-test and accepts an answer without it", async () => {
    const harness = createHarness({ canvas: true, ready: true });
    const answer = harness.host.hitTest({ x: 3, y: 4 });
    const request = harness.requestOf("traycer/canvas/hit-test");
    expect(request.params).toEqual({ x: 3, y: 4, nonce: NONCE });
    harness.host.receive(
      respond(request, { element: element({}), nonce: NONCE }),
    );
    await expect(answer).resolves.toMatchObject({ marker: 7 });
  });

  it.each(["edit", "play"] as const)(
    "switches to %s and resolves true on the page's answer",
    async (mode) => {
      const harness = createHarness({ canvas: true, ready: true });
      const answer = harness.host.setMode(mode);
      const request = harness.requestOf("traycer/canvas/set-mode");
      expect(request.params).toEqual({ mode, nonce: NONCE });
      harness.host.receive(respond(request, { nonce: NONCE }));
      await expect(answer).resolves.toBe(true);
    },
  );

  it("ignores an answer with the wrong or missing nonce, then times out", async () => {
    const harness = createHarness({ canvas: true, ready: true });
    const answer = harness.host.hitTest({ x: 1, y: 1 });
    const request = harness.requestOf("traycer/canvas/hit-test");
    let settled = false;
    void answer.then(() => {
      settled = true;
    });

    harness.host.receive(
      respond(request, { element: element({}), nonce: "other" }),
    );
    harness.host.receive(respond(request, { element: element({}) }));
    harness.host.receive({
      jsonrpc: "2.0",
      id: request.id,
      result: "nonsense",
    });
    harness.host.receive({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -1, message: "x" },
    });
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toBeNull();
  });

  it("times out a set-mode that is never answered as false", async () => {
    const harness = createHarness({ canvas: true, ready: true });
    const answer = harness.host.setMode("play");
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    await expect(answer).resolves.toBe(false);
  });

  it("answers only the matching request and consumes an answer once", async () => {
    const harness = createHarness({ canvas: true, ready: true });
    const first = harness.host.elementBox({ marker: 1 });
    const firstRequest = harness.requestOf("traycer/canvas/element-box");
    const second = harness.host.elementBox({ marker: 2 });
    const secondRequest = harness.requestOf("traycer/canvas/element-box");
    expect(secondRequest.id).not.toBe(firstRequest.id);

    harness.host.receive(respond(secondRequest, { box: BOX, nonce: NONCE }));
    await expect(second).resolves.toEqual(BOX);
    // A replay of the same id must not reach the first request.
    harness.host.receive(respond(secondRequest, { box: BOX, nonce: NONCE }));
    harness.host.receive(
      respond(firstRequest, { box: { ...BOX, x: 99 }, nonce: NONCE }),
    );
    await expect(first).resolves.toMatchObject({ x: 99 });
  });

  it("caps the requests in flight, answering the overflow null at once", async () => {
    const harness = createHarness({ canvas: true, ready: true });
    for (let index = 0; index < 32; index += 1) {
      void harness.host.elementBox({ marker: index });
    }
    expect(canvasRequests(harness)).toHaveLength(32);
    await expect(harness.host.elementBox({ marker: 99 })).resolves.toBeNull();
    expect(canvasRequests(harness)).toHaveLength(32);
  });

  it("settles every request in flight when the host is disposed", async () => {
    const harness = createHarness({ canvas: true, ready: true });
    const box = harness.host.elementBox({ marker: 1 });
    const mode = harness.host.setMode("play");
    harness.host.dispose();
    await expect(box).resolves.toBeNull();
    await expect(mode).resolves.toBe(false);
  });

  it("sends nothing before the page proves its nonce", async () => {
    const harness = createHarness({ canvas: true, ready: false });
    await expect(harness.host.hitTest({ x: 1, y: 1 })).resolves.toBeNull();
    await expect(harness.host.elementBox({ marker: 1 })).resolves.toBeNull();
    await expect(
      harness.host.describeElement({ tid: "t" }),
    ).resolves.toBeNull();
    await expect(
      harness.host.setTextSelectionTarget({ tid: "t" }),
    ).resolves.toBe(false);
    await expect(harness.host.setMode("edit")).resolves.toBe(false);
    expect(canvasRequests(harness)).toEqual([]);
  });

  it("sends nothing from a served page that is not a canvas", async () => {
    const harness = createHarness({ canvas: false, ready: true });
    await expect(harness.host.hitTest({ x: 1, y: 1 })).resolves.toBeNull();
    await expect(harness.host.elementBox({ marker: 1 })).resolves.toBeNull();
    await expect(
      harness.host.describeElement({ tid: "t" }),
    ).resolves.toBeNull();
    await expect(harness.host.setTextSelectionTarget(null)).resolves.toBe(
      false,
    );
    await expect(harness.host.setMode("play")).resolves.toBe(false);
    expect(canvasRequests(harness)).toEqual([]);
  });
});

describe("canvas text gestures", () => {
  const START = { x: 10, y: 12 };
  const END = { x: 80, y: 14 };

  it("posts a text-range drag between two points and resolves true on the page's answer", async () => {
    const harness = createHarness({ canvas: true, ready: true });

    const selected = harness.host.selectTextRange({ start: START, end: END });
    const request = harness.requestOf("traycer/canvas/select-text-range");
    expect(request.params).toEqual({ start: START, end: END, nonce: NONCE });
    harness.host.receive(respond(request, { nonce: NONCE }));

    await expect(selected).resolves.toBe(true);
  });

  it("posts a retype at a point and resolves true on the page's answer", async () => {
    const harness = createHarness({ canvas: true, ready: true });

    const retyped = harness.host.retypeAt(START);
    const request = harness.requestOf("traycer/canvas/retype-at");
    expect(request.params).toEqual({ ...START, nonce: NONCE });
    harness.host.receive(respond(request, { nonce: NONCE }));

    await expect(retyped).resolves.toBe(true);
  });

  it("resolves false when the page never answers or answers with the wrong nonce", async () => {
    const harness = createHarness({ canvas: true, ready: true });
    const selected = harness.host.selectTextRange({ start: START, end: END });
    const retyped = harness.host.retypeAt(START);
    harness.host.receive(
      respond(harness.requestOf("traycer/canvas/select-text-range"), {
        nonce: "other",
      }),
    );
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);

    await expect(selected).resolves.toBe(false);
    await expect(retyped).resolves.toBe(false);
  });

  it.each([
    ["before the page proves its nonce", { canvas: true, ready: false }],
    ["from a served page that is not a canvas", { canvas: false, ready: true }],
  ])("sends nothing %s", async (_label, options) => {
    const harness = createHarness(options);

    await expect(
      harness.host.selectTextRange({ start: START, end: END }),
    ).resolves.toBe(false);
    await expect(harness.host.retypeAt(START)).resolves.toBe(false);
    expect(canvasRequests(harness)).toEqual([]);
  });
});

describe("canvas notifications", () => {
  const selectionParams = (overrides: Record<string, unknown>) => ({
    element: element({}),
    start: 1,
    end: 4,
    quote: "abc",
    rects: [BOX],
    nonce: NONCE,
    ...overrides,
  });

  it("delivers a text selection", () => {
    const harness = createHarness({ canvas: true, ready: true });
    harness.host.receive(
      notification("traycer/canvas/text-selection", selectionParams({})),
    );
    expect(harness.onTextSelection).toHaveBeenCalledOnce();
    expect(harness.onTextSelection.mock.calls[0][0]).toMatchObject({
      start: 1,
      end: 4,
      quote: "abc",
      rects: [BOX],
      element: { marker: 7 },
    });
  });

  it("delivers a cleared selection as null", () => {
    const harness = createHarness({ canvas: true, ready: true });
    harness.host.receive(
      notification("traycer/canvas/text-selection", {
        selection: null,
        nonce: NONCE,
      }),
    );
    expect(harness.onTextSelection).toHaveBeenCalledOnce();
    expect(harness.onTextSelection).toHaveBeenCalledWith(null);
  });

  it.each([
    ["a wrong nonce", { selection: null, nonce: "other" }],
    ["no nonce", { selection: null }],
  ])("drops a cleared selection with %s", (_label, params) => {
    const harness = createHarness({ canvas: true, ready: true });
    harness.host.receive(notification("traycer/canvas/text-selection", params));
    expect(harness.onTextSelection).not.toHaveBeenCalled();
  });

  it("drops a cleared selection from a page that is not a canvas or not ready", () => {
    for (const options of [
      { canvas: false, ready: true },
      { canvas: true, ready: false },
    ]) {
      const harness = createHarness(options);
      harness.host.receive(
        notification("traycer/canvas/text-selection", {
          selection: null,
          nonce: NONCE,
        }),
      );
      expect(harness.onTextSelection).not.toHaveBeenCalled();
    }
  });

  it("delivers a page error", () => {
    const harness = createHarness({ canvas: true, ready: true });
    harness.host.receive(
      notification("traycer/canvas/page-error", {
        message: "boom",
        stack: null,
        nonce: NONCE,
      }),
    );
    expect(harness.onPageError).toHaveBeenCalledWith({
      message: "boom",
      stack: null,
    });
  });

  it("delivers a relative link", () => {
    const harness = createHarness({ canvas: true, ready: true });
    harness.host.receive(
      notification("traycer/canvas/relative-link", {
        href: "next.html#part",
        nonce: NONCE,
      }),
    );
    expect(harness.onRelativeLink).toHaveBeenCalledWith("next.html#part");
  });

  const WRONG_NONCE = { nonce: "other" };
  const NO_NONCE = { nonce: undefined };
  it.each([
    ["a wrong nonce", WRONG_NONCE],
    ["no nonce", NO_NONCE],
  ])("drops every canvas notification with %s", (_label, nonce) => {
    const harness = createHarness({ canvas: true, ready: true });
    harness.host.receive(
      notification("traycer/canvas/text-selection", selectionParams(nonce)),
    );
    harness.host.receive(
      notification("traycer/canvas/page-error", {
        message: "m",
        stack: null,
        ...nonce,
      }),
    );
    harness.host.receive(
      notification("traycer/canvas/relative-link", {
        href: "a.html",
        ...nonce,
      }),
    );
    expect(harness.onTextSelection).not.toHaveBeenCalled();
    expect(harness.onPageError).not.toHaveBeenCalled();
    expect(harness.onRelativeLink).not.toHaveBeenCalled();
  });

  it("drops malformed payloads even with the right nonce", () => {
    const harness = createHarness({ canvas: true, ready: true });
    harness.host.receive(
      notification(
        "traycer/canvas/text-selection",
        selectionParams({ end: 0 }),
      ),
    );
    harness.host.receive(
      notification("traycer/canvas/page-error", {
        message: "m".repeat(2001),
        stack: null,
        nonce: NONCE,
      }),
    );
    harness.host.receive(
      notification("traycer/canvas/relative-link", {
        href: "a".repeat(8193),
        nonce: NONCE,
      }),
    );
    harness.host.receive(notification("traycer/canvas/relative-link", [NONCE]));
    harness.host.receive(notification("traycer/canvas/relative-link", NONCE));
    expect(harness.onTextSelection).not.toHaveBeenCalled();
    expect(harness.onPageError).not.toHaveBeenCalled();
    expect(harness.onRelativeLink).not.toHaveBeenCalled();
  });

  it("drops an unknown canvas method", () => {
    const harness = createHarness({ canvas: true, ready: true });
    harness.host.receive(
      notification("traycer/canvas/anything-else", {
        href: "a.html",
        nonce: NONCE,
      }),
    );
    expect(harness.onRelativeLink).not.toHaveBeenCalled();
    expect(harness.host.status).toBe("ready");
  });

  it("drops canvas notifications from a page that is not a canvas", () => {
    const harness = createHarness({ canvas: false, ready: true });
    harness.host.receive(
      notification("traycer/canvas/text-selection", selectionParams({})),
    );
    harness.host.receive(
      notification("traycer/canvas/page-error", {
        message: "m",
        stack: null,
        nonce: NONCE,
      }),
    );
    harness.host.receive(
      notification("traycer/canvas/relative-link", {
        href: "a.html",
        nonce: NONCE,
      }),
    );
    expect(harness.onTextSelection).not.toHaveBeenCalled();
    expect(harness.onPageError).not.toHaveBeenCalled();
    expect(harness.onRelativeLink).not.toHaveBeenCalled();
  });

  it("drops canvas notifications before the page is ready", () => {
    const harness = createHarness({ canvas: true, ready: false });
    harness.host.receive(
      notification("traycer/canvas/text-selection", selectionParams({})),
    );
    harness.host.receive(
      notification("traycer/canvas/page-error", {
        message: "m",
        stack: null,
        nonce: NONCE,
      }),
    );
    harness.host.receive(
      notification("traycer/canvas/relative-link", {
        href: "a.html",
        nonce: NONCE,
      }),
    );
    expect(harness.onTextSelection).not.toHaveBeenCalled();
    expect(harness.onPageError).not.toHaveBeenCalled();
    expect(harness.onRelativeLink).not.toHaveBeenCalled();
  });

  it("does not require the optional listeners", () => {
    const host = new SandboxBridgeHost({
      document: {
        kind: "served",
        canvas: true,
        nonce: NONCE,
        forwardedShortcuts: [],
        pages: null,
      },
      hostContext: HOST_CONTEXT,
      hostVersion: "9.9.9",
      post: () => undefined,
      events: {
        onStatus: () => undefined,
        onSize: () => undefined,
        onOpenLink: () => Promise.resolve(true),
        onShortcut: () => undefined,
        onRequestTeardown: () => undefined,
        onScrollGesture: () => undefined,
        onWheel: () => undefined,
      },
      appRequests: null,
    });
    hosts.push(host);
    host.receive({
      jsonrpc: "2.0",
      method: "traycer/notifications/document-ready",
      params: { nonce: NONCE, height: 120 },
    });
    host.receive(
      notification("traycer/canvas/relative-link", {
        href: "a.html",
        nonce: NONCE,
      }),
    );
    expect(host.status).toBe("ready");
  });
});

describe("canvas Escape", () => {
  const press = (overrides: Record<string, unknown>) =>
    notification("traycer/notifications/shortcut", {
      key: "Escape",
      code: "Escape",
      ctrl: false,
      meta: false,
      alt: false,
      shift: false,
      nonce: NONCE,
      ...overrides,
    });

  it("forwards a bare Escape from the proven canvas page", () => {
    const harness = createHarness({ canvas: true, ready: true });
    harness.host.receive(press({}));
    expect(harness.onShortcut).toHaveBeenCalledWith({
      key: "Escape",
      code: "Escape",
      ctrl: false,
      meta: false,
      alt: false,
      shift: false,
    });
  });

  it.each([
    ["a wrong nonce", { nonce: "other" }],
    ["no nonce", { nonce: undefined }],
    ["Shift held", { shift: true }],
    ["Ctrl held", { ctrl: true }],
    ["Meta held", { meta: true }],
    ["Alt held", { alt: true }],
    ["another key", { key: "a", code: "KeyA" }],
  ])("drops an Escape press with %s", (_label, overrides) => {
    const harness = createHarness({ canvas: true, ready: true });
    harness.host.receive(press(overrides));
    expect(harness.onShortcut).not.toHaveBeenCalled();
  });

  it("drops Escape from a served page that is not a canvas", () => {
    const harness = createHarness({ canvas: false, ready: true });
    harness.host.receive(press({}));
    expect(harness.onShortcut).not.toHaveBeenCalled();
  });

  it("drops Escape before the page proved its nonce", () => {
    const harness = createHarness({ canvas: true, ready: false });
    harness.host.receive(press({}));
    expect(harness.onShortcut).not.toHaveBeenCalled();
  });
});

describe("canvas page errors outside a healthy ready page", () => {
  const EARLY_ERROR = "traycer/notifications/early-error";
  const DOCUMENT_READY = "traycer/notifications/document-ready";
  const pageError = (overrides: Record<string, unknown>) =>
    notification("traycer/canvas/page-error", {
      message: "boom",
      stack: "at x",
      nonce: NONCE,
      ...overrides,
    });
  const documentReady = (nonce: string, height: number) =>
    notification(DOCUMENT_READY, { nonce, height });

  /** Every other canvas channel stays shut on a crashed page. */
  async function expectOtherChannelsShut(harness: Harness): Promise<void> {
    harness.host.receive(
      notification("traycer/canvas/relative-link", {
        href: "a.html",
        nonce: NONCE,
      }),
    );
    harness.host.receive(
      notification("traycer/canvas/text-selection", {
        selection: null,
        nonce: NONCE,
      }),
    );
    harness.host.receive(
      notification("traycer/notifications/shortcut", {
        key: "Escape",
        code: "Escape",
        ctrl: false,
        meta: false,
        alt: false,
        shift: false,
        nonce: NONCE,
      }),
    );
    expect(harness.onRelativeLink).not.toHaveBeenCalled();
    expect(harness.onTextSelection).not.toHaveBeenCalled();
    expect(harness.onShortcut).not.toHaveBeenCalled();
    await expect(harness.host.hitTest({ x: 1, y: 1 })).resolves.toBeNull();
    await expect(harness.host.setMode("play")).resolves.toBe(false);
  }

  it("delivers a page error after an early error left a tiny page marked crashed", async () => {
    const harness = createHarness({ canvas: true, ready: false });
    harness.host.receive(notification(EARLY_ERROR, { message: "early" }));
    harness.host.receive(documentReady(NONCE, 10));
    expect(harness.host.status).toBe("crashed");

    harness.host.receive(pageError({}));
    expect(harness.onPageError).toHaveBeenCalledWith({
      message: "boom",
      stack: "at x",
    });
    await expectOtherChannelsShut(harness);
  });

  it("delivers a page error after the liveness ping went unanswered", async () => {
    const harness = createHarness({ canvas: true, ready: true });
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    expect(harness.host.status).toBe("crashed");

    harness.host.receive(pageError({}));
    expect(harness.onPageError).toHaveBeenCalledOnce();
    await expectOtherChannelsShut(harness);
  });

  it("delivers a page error once a late valid proof follows the load watchdog", async () => {
    const harness = createHarness({ canvas: true, ready: false });
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    expect(harness.host.status).toBe("crashed");

    // Not yet proven: the page has shown nothing that earns a pill.
    harness.host.receive(pageError({}));
    expect(harness.onPageError).not.toHaveBeenCalled();

    harness.host.receive(documentReady(NONCE, 120));
    harness.host.receive(pageError({ message: "late" }));
    expect(harness.onPageError).toHaveBeenCalledOnce();
    expect(harness.onPageError).toHaveBeenCalledWith({
      message: "late",
      stack: "at x",
    });
    await expectOtherChannelsShut(harness);
  });

  it("drops a page error from a document that never proved itself", async () => {
    const harness = createHarness({ canvas: true, ready: false });
    harness.host.receive(pageError({}));
    expect(harness.onPageError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    expect(harness.host.status).toBe("crashed");
    harness.host.receive(pageError({}));
    expect(harness.onPageError).not.toHaveBeenCalled();
  });

  it("drops a page error after a proof with the wrong nonce was rejected", () => {
    const harness = createHarness({ canvas: true, ready: false });
    harness.host.receive(documentReady("other", 120));
    expect(harness.host.status).toBe("disposed");

    harness.host.receive(pageError({}));
    expect(harness.onPageError).not.toHaveBeenCalled();
  });

  it("drops a page error after a repeated proof was rejected", () => {
    const harness = createHarness({ canvas: true, ready: true });
    harness.host.receive(documentReady(NONCE, 120));
    expect(harness.host.status).toBe("disposed");

    harness.host.receive(pageError({}));
    expect(harness.onPageError).not.toHaveBeenCalled();
  });

  it.each([
    ["a wrong nonce", { nonce: "other" }],
    ["no nonce", { nonce: undefined }],
  ])(
    "drops a page error with %s even on a crashed proven page",
    (_label, overrides) => {
      const harness = createHarness({ canvas: true, ready: false });
      harness.host.receive(notification(EARLY_ERROR, { message: "early" }));
      harness.host.receive(documentReady(NONCE, 10));
      expect(harness.host.status).toBe("crashed");

      harness.host.receive(pageError(overrides));
      expect(harness.onPageError).not.toHaveBeenCalled();
    },
  );

  it("drops a page error from a crashed page that is not a canvas", () => {
    const harness = createHarness({ canvas: false, ready: false });
    harness.host.receive(notification(EARLY_ERROR, { message: "early" }));
    harness.host.receive(documentReady(NONCE, 10));
    harness.host.receive(pageError({}));
    expect(harness.onPageError).not.toHaveBeenCalled();
  });

  it("drops a page error once the host is disposed", () => {
    const harness = createHarness({ canvas: true, ready: true });
    harness.host.dispose();
    harness.host.receive(pageError({}));
    expect(harness.onPageError).not.toHaveBeenCalled();
  });
});

describe("canvas double-click", () => {
  const DOUBLE_CLICK = "traycer/canvas/double-click";
  const doubleClick = (overrides: Record<string, unknown>): Sent =>
    notification(DOUBLE_CLICK, {
      element: element({}),
      nonce: NONCE,
      ...overrides,
    });

  it("delivers the element the page reported", () => {
    const harness = createHarness({ canvas: true, ready: true });
    harness.host.receive(
      doubleClick({ element: element({ marker: 9, textPreview: "title" }) }),
    );
    expect(harness.onDoubleClick).toHaveBeenCalledOnce();
    expect(harness.onDoubleClick.mock.calls[0][0]).toMatchObject({
      marker: 9,
      textPreview: "title",
      box: BOX,
    });
  });

  it("delivers the text snapshot a double-click carries", () => {
    const harness = createHarness({ canvas: true, ready: true });
    const snapshot = { content: "Welcome", nodes: ["Welcome"], textOnly: true };
    harness.host.receive(
      doubleClick({ element: element({ textSnapshot: snapshot }) }),
    );
    expect(harness.onDoubleClick.mock.calls[0][0]).toMatchObject({
      textSnapshot: snapshot,
    });
  });

  it("drops a double-click whose snapshot breaks the budget", () => {
    const harness = createHarness({ canvas: true, ready: true });
    harness.host.receive(
      doubleClick({
        element: element({
          textSnapshot: {
            content: "a".repeat(65_537),
            nodes: [],
            textOnly: true,
          },
        }),
      }),
    );
    expect(harness.onDoubleClick).not.toHaveBeenCalled();
  });

  it("delivers each double-click separately", () => {
    const harness = createHarness({ canvas: true, ready: true });
    harness.host.receive(doubleClick({ element: element({ marker: 1 }) }));
    harness.host.receive(doubleClick({ element: element({ marker: 2 }) }));
    expect(
      harness.onDoubleClick.mock.calls.map(([found]) => found.marker),
    ).toEqual([1, 2]);
  });

  it.each([
    ["a wrong nonce", { nonce: "other" }],
    ["no nonce", { nonce: undefined }],
  ])("drops a double-click with %s", (_label, nonce) => {
    const harness = createHarness({ canvas: true, ready: true });
    harness.host.receive(doubleClick(nonce));
    expect(harness.onDoubleClick).not.toHaveBeenCalled();
  });

  it.each([
    ["a page that is not a canvas", { canvas: false, ready: true }],
    ["a page that has not proved its nonce", { canvas: true, ready: false }],
  ])("drops a double-click from %s", (_label, options) => {
    const harness = createHarness(options);
    harness.host.receive(doubleClick({}));
    expect(harness.onDoubleClick).not.toHaveBeenCalled();
  });

  it("drops a double-click once the host is disposed", () => {
    const harness = createHarness({ canvas: true, ready: true });
    harness.host.dispose();
    harness.host.receive(doubleClick({}));
    expect(harness.onDoubleClick).not.toHaveBeenCalled();
  });

  it.each([
    ["no element", { element: undefined }],
    ["a null element", { element: null }],
    [
      "an element over a parser limit",
      { element: element({ selector: "s".repeat(1001) }) },
    ],
    [
      "an element claiming to be generated",
      { element: element({ generated: true }) },
    ],
    ["a string element", { element: "p" }],
    [
      "markup over 65536 bytes",
      { element: element({ outerHtml: "a".repeat(65_537) }) },
    ],
  ])("drops a double-click carrying %s", (_label, overrides) => {
    const harness = createHarness({ canvas: true, ready: true });
    harness.host.receive(doubleClick(overrides));
    expect(harness.onDoubleClick).not.toHaveBeenCalled();
    expect(harness.host.status).toBe("ready");
  });

  it("drops params that are not a record", () => {
    const harness = createHarness({ canvas: true, ready: true });
    harness.host.receive(notification(DOUBLE_CLICK, [NONCE]));
    harness.host.receive(notification(DOUBLE_CLICK, NONCE));
    harness.host.receive(notification(DOUBLE_CLICK, null));
    expect(harness.onDoubleClick).not.toHaveBeenCalled();
  });

  it("does not turn a double-click into a selection, error or link", () => {
    const harness = createHarness({ canvas: true, ready: true });
    harness.host.receive(doubleClick({}));
    expect(harness.onTextSelection).not.toHaveBeenCalled();
    expect(harness.onPageError).not.toHaveBeenCalled();
    expect(harness.onRelativeLink).not.toHaveBeenCalled();
  });

  it("keeps delivering the other notifications after a double-click", () => {
    const harness = createHarness({ canvas: true, ready: true });
    harness.host.receive(doubleClick({}));
    harness.host.receive(
      notification("traycer/canvas/relative-link", {
        href: "a.html",
        nonce: NONCE,
      }),
    );
    expect(harness.onRelativeLink).toHaveBeenCalledWith("a.html");
  });
});
