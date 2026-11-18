import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PING_TIMEOUT_MS,
  SandboxBridgeHost,
  type SandboxHostContext,
} from "../bridge-host";
import { parseCanvasSiblingLayout } from "../canvas-layout-bridge";

const NONCE = "layout-nonce";
const BOX = { x: 4, y: 5, width: 60, height: 20 };

function node(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    marker: 12,
    tid: null,
    tagName: "div",
    box: BOX,
    position: "absolute",
    left: 4,
    top: 5,
    cssWidth: 60,
    cssHeight: 20,
    transformed: false,
    order: 0,
    gridPlacement: false,
    ...overrides,
  };
}

/** A well-formed layout answer; each case below breaks exactly one field. */
function layout(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    parent: node({ marker: 1, tagName: "section" }),
    siblings: [node({ marker: 12 }), node({ marker: 40, tagName: "p" })],
    axis: "x",
    reverse: false,
    truncated: false,
    ...overrides,
  };
}

describe("parseCanvasSiblingLayout", () => {
  it("round-trips a well-formed layout", () => {
    expect(parseCanvasSiblingLayout(layout({}))).toEqual(layout({}));
  });

  it("accepts the null fields of a static, auto-sized element", () => {
    const parsed = parseCanvasSiblingLayout(
      layout({
        siblings: [
          node({
            position: "static",
            left: null,
            top: null,
            cssWidth: null,
            cssHeight: null,
          }),
        ],
      }),
    );
    expect(parsed?.siblings[0]).toMatchObject({
      position: "static",
      left: null,
      top: null,
      cssWidth: null,
      cssHeight: null,
    });
  });

  it("accepts an element with a tid and no marker", () => {
    expect(
      parseCanvasSiblingLayout(
        layout({ siblings: [node({ marker: null, tid: "hero" })] }),
      ),
    ).not.toBeNull();
  });

  it("carries layout facts only, never markup or text", () => {
    const parsed = parseCanvasSiblingLayout(
      layout({
        html: "<script>x</script>",
        parent: node({
          marker: 1,
          innerHTML: "<b>x</b>",
          textContent: "hello",
        }),
        siblings: [
          node({ outerHTML: "<p>hi</p>", text: "hi", style: "color:red" }),
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("html");
    for (const item of [parsed?.parent, ...(parsed?.siblings ?? [])]) {
      expect(Object.keys(item ?? {}).sort()).toEqual(
        [
          "box",
          "cssHeight",
          "cssWidth",
          "gridPlacement",
          "left",
          "marker",
          "order",
          "position",
          "tagName",
          "tid",
          "top",
          "transformed",
        ].sort(),
      );
    }
  });

  it("carries the CSS order and explicit grid placement the page reports", () => {
    const parsed = parseCanvasSiblingLayout(
      layout({
        siblings: [
          node({ order: 3, gridPlacement: true }),
          node({ marker: 40, order: -2, gridPlacement: false }),
        ],
      }),
    );
    expect(parsed?.siblings).toMatchObject([
      { order: 3, gridPlacement: true },
      { order: -2, gridPlacement: false },
    ]);
  });

  it("accepts both axes and reverse and truncated flags", () => {
    for (const axis of ["x", "y"] as const)
      for (const flag of [true, false])
        expect(
          parseCanvasSiblingLayout(
            layout({ axis, reverse: flag, truncated: flag }),
          ),
        ).toMatchObject({ axis, reverse: flag, truncated: flag });
  });

  describe("bounds", () => {
    const sibling = node({});

    it("takes 256 siblings and refuses 257", () => {
      expect(
        parseCanvasSiblingLayout(
          layout({ siblings: Array.from({ length: 256 }, () => sibling) }),
        )?.siblings,
      ).toHaveLength(256);
      expect(
        parseCanvasSiblingLayout(
          layout({ siblings: Array.from({ length: 257 }, () => sibling) }),
        ),
      ).toBeNull();
    });

    it("takes an empty sibling list", () => {
      expect(
        parseCanvasSiblingLayout(layout({ siblings: [] }))?.siblings,
      ).toEqual([]);
    });

    it("takes text at its limits and refuses one past", () => {
      expect(
        parseCanvasSiblingLayout(
          layout({
            siblings: [
              node({
                tid: "t".repeat(300),
                tagName: "x".repeat(40),
                position: "p".repeat(40),
              }),
            ],
          }),
        ),
      ).not.toBeNull();
      for (const overrides of [
        { tid: "t".repeat(301) },
        { tagName: "x".repeat(41) },
        { position: "p".repeat(41) },
      ])
        expect(
          parseCanvasSiblingLayout(layout({ siblings: [node(overrides)] })),
        ).toBeNull();
    });

    it("takes coordinates at 10 million and refuses past it", () => {
      expect(
        parseCanvasSiblingLayout(
          layout({
            siblings: [
              node({
                left: 10_000_000,
                top: -10_000_000,
                cssWidth: 10_000_000,
                cssHeight: 0,
              }),
            ],
          }),
        ),
      ).not.toBeNull();
      for (const field of ["left", "top", "cssWidth", "cssHeight"])
        expect(
          parseCanvasSiblingLayout(
            layout({ siblings: [node({ [field]: 10_000_001 })] }),
          ),
        ).toBeNull();
    });
  });

  describe("refuses the whole layout when anything in it is wrong", () => {
    it.each([
      ["null", null],
      ["an array", [layout({})]],
      ["a string", "layout"],
      ["siblings that are not an array", layout({ siblings: {} })],
      ["a missing parent", layout({ parent: undefined })],
      [
        "a malformed parent",
        layout({ parent: node({ box: { ...BOX, width: -1 } }) }),
      ],
      ["an unknown axis", layout({ axis: "z" })],
      ["a missing axis", layout({ axis: undefined })],
      ["a non-boolean reverse", layout({ reverse: "yes" })],
      ["a non-boolean truncated", layout({ truncated: 0 })],
    ])("%s", (_label, value) => {
      expect(parseCanvasSiblingLayout(value)).toBeNull();
    });

    it.each([
      ["a negative marker", { marker: -1 }],
      ["a fractional marker", { marker: 1.5 }],
      ["a string marker", { marker: "12" }],
      ["a missing marker", { marker: undefined }],
      ["a non-string tid", { tid: 7 }],
      ["a missing tid", { tid: undefined }],
      ["a non-string tag name", { tagName: 7 }],
      ["a non-string position", { position: null }],
      ["a non-boolean transformed", { transformed: "no" }],
      ["a missing transformed", { transformed: undefined }],
      ["a missing box", { box: undefined }],
      ["a negative box height", { box: { ...BOX, height: -1 } }],
      ["a NaN box coordinate", { box: { ...BOX, x: Number.NaN } }],
      ["a NaN left", { left: Number.NaN }],
      ["an infinite top", { top: Number.POSITIVE_INFINITY }],
      ["a string cssWidth", { cssWidth: "60px" }],
      ["a missing cssHeight", { cssHeight: undefined }],
      ["a negative cssWidth", { cssWidth: -1 }],
      ["a missing order", { order: undefined }],
      ["a string order", { order: "1" }],
      ["a fractional order", { order: 1.5 }],
      ["an order past the safe integers", { order: 2 ** 53 }],
      ["a NaN order", { order: Number.NaN }],
      ["a missing gridPlacement", { gridPlacement: undefined }],
      ["a string gridPlacement", { gridPlacement: "true" }],
      ["a numeric gridPlacement", { gridPlacement: 1 }],
    ])("a sibling with %s", (_label, overrides) => {
      expect(
        parseCanvasSiblingLayout(
          layout({ siblings: [node({}), node(overrides)] }),
        ),
      ).toBeNull();
      expect(
        parseCanvasSiblingLayout(layout({ parent: node(overrides) })),
      ).toBeNull();
    });
  });
});

describe("SandboxBridgeHost.siblingLayout", () => {
  const HOST_CONTEXT: SandboxHostContext = {
    theme: "light",
    styles: { variables: {} },
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    platform: "desktop",
  };
  type Sent = Readonly<Record<string, unknown>>;
  const hosts: SandboxBridgeHost[] = [];

  function isSent(value: unknown): value is Sent {
    return typeof value === "object" && value !== null;
  }
  function createHost(options: {
    readonly canvas: boolean;
    readonly ready: boolean;
  }) {
    const sent: Sent[] = [];
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
        onShortcut: () => undefined,
        onRequestTeardown: () => undefined,
        onScrollGesture: () => undefined,
        onWheel: () => undefined,
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
    const requests = (): Sent[] =>
      sent.filter(
        (message) => message.method === "traycer/canvas/sibling-layout",
      );
    const lastRequest = (): Sent => {
      const found = requests().at(-1);
      if (found === undefined)
        throw new Error("no sibling-layout request was posted");
      return found;
    };
    return { host, requests, lastRequest };
  }
  function answer(request: Sent, result: unknown): Sent {
    return { jsonrpc: "2.0", id: request.id, result };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose();
    vi.useRealTimers();
  });

  it("asks by marker or tid with the nonce and resolves the parsed layout", async () => {
    const { host, lastRequest } = createHost({ canvas: true, ready: true });

    const byMarker = host.siblingLayout({ marker: 12 });
    expect(lastRequest()).toMatchObject({
      jsonrpc: "2.0",
      method: "traycer/canvas/sibling-layout",
      params: { marker: 12, nonce: NONCE },
    });
    host.receive(answer(lastRequest(), { layout: layout({}), nonce: NONCE }));
    await expect(byMarker).resolves.toMatchObject({
      axis: "x",
      reverse: false,
      truncated: false,
      parent: { marker: 1, tagName: "section" },
      siblings: [{ marker: 12 }, { marker: 40, tagName: "p" }],
    });

    const byTid = host.siblingLayout({ tid: "hero" });
    expect(lastRequest().params).toEqual({ tid: "hero", nonce: NONCE });
    host.receive(
      answer(lastRequest(), { layout: layout({ axis: "y" }), nonce: NONCE }),
    );
    await expect(byTid).resolves.toMatchObject({ axis: "y" });
  });

  it("resolves null when the page found no layout", async () => {
    const { host, lastRequest } = createHost({ canvas: true, ready: true });
    const pending = host.siblingLayout({ marker: 12 });
    host.receive(answer(lastRequest(), { layout: null, nonce: NONCE }));
    await expect(pending).resolves.toBeNull();
  });

  it.each([
    [
      "too many siblings",
      layout({ siblings: Array.from({ length: 257 }, () => node({})) }),
    ],
    ["an unknown axis", layout({ axis: "z" })],
    [
      "a sibling with a bad box",
      layout({ siblings: [node({ box: { ...BOX, width: -1 } })] }),
    ],
    ["a bare string", "layout"],
  ])("resolves null for %s", async (_label, malformed) => {
    const { host, lastRequest } = createHost({ canvas: true, ready: true });
    const pending = host.siblingLayout({ marker: 12 });
    host.receive(answer(lastRequest(), { layout: malformed, nonce: NONCE }));
    await expect(pending).resolves.toBeNull();
  });

  it("ignores an answer that does not carry the nonce, then times out null", async () => {
    const { host, lastRequest } = createHost({ canvas: true, ready: true });
    const pending = host.siblingLayout({ marker: 12 });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    host.receive(answer(lastRequest(), { layout: layout({}), nonce: "other" }));
    host.receive(answer(lastRequest(), { layout: layout({}) }));
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
  });

  it("settles null when the host is disposed with the request in flight", async () => {
    const { host } = createHost({ canvas: true, ready: true });
    const pending = host.siblingLayout({ marker: 12 });
    host.dispose();
    await expect(pending).resolves.toBeNull();
  });

  it("sends nothing before the page proves itself, or from a page that is not a canvas", async () => {
    const early = createHost({ canvas: true, ready: false });
    await expect(early.host.siblingLayout({ marker: 12 })).resolves.toBeNull();
    expect(early.requests()).toEqual([]);

    const plain = createHost({ canvas: false, ready: true });
    await expect(plain.host.siblingLayout({ marker: 12 })).resolves.toBeNull();
    expect(plain.requests()).toEqual([]);
  });

  it("sends nothing once the page is marked crashed", async () => {
    const { host, requests } = createHost({ canvas: true, ready: true });
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    expect(host.status).toBe("crashed");
    await expect(host.siblingLayout({ marker: 12 })).resolves.toBeNull();
    expect(requests()).toEqual([]);
  });
});
