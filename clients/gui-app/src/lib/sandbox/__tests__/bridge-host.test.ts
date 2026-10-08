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
  DECLINED_LINK_QUIET_MS,
  LOAD_TIMEOUT_MS,
  MAX_IN_FLIGHT_APP_REQUESTS,
  MAX_LINK_URL_CHARS,
  MAX_INBOUND_MESSAGE_BYTES,
  PING_TIMEOUT_MS,
  SandboxBridgeHost,
  TEARDOWN_GRACE_MS,
  type SandboxAppRequestHandler,
  type SandboxHostContext,
  type SandboxShortcutPress,
  type SandboxSize,
  type SandboxStatus,
} from "../bridge-host";

const NONCE = "nonce-1";

const HOST_CONTEXT: SandboxHostContext = {
  theme: "light",
  styles: { variables: { "--font-sans": "Figtree" } },
  displayMode: "inline",
  availableDisplayModes: ["inline"],
  platform: "desktop",
};

type Sent = Readonly<Record<string, unknown>>;

function isSent(value: unknown): value is Sent {
  return typeof value === "object" && value !== null;
}

interface Harness {
  readonly host: SandboxBridgeHost;
  readonly sent: Sent[];
  readonly statuses: SandboxStatus[];
  /** Run on every status, after it is recorded. */
  readonly statusHooks: ((status: SandboxStatus) => void)[];
  readonly onSize: Mock<(size: SandboxSize) => void>;
  readonly onOpenLink: Mock<OpenLink>;
  readonly onRequestTeardown: Mock<() => void>;
  readonly onShortcut: Mock<(press: SandboxShortcutPress) => void>;
  /** Everything posted with this method. */
  readonly all: (method: string) => Sent[];
  /** The response posted for a request id. */
  readonly responseTo: (id: string | number) => Sent | undefined;
}

type OpenLink = (url: string) => Promise<boolean>;

/** Every host a test made; the link limiter is app-wide, so all are disposed. */
const hosts: SandboxBridgeHost[] = [];

/** The reader confirms every link. */
const OPENS: OpenLink = () => Promise.resolve(true);

function createHarness(options: {
  readonly appRequests: SandboxAppRequestHandler | null;
  readonly openLink: OpenLink;
}): Harness {
  const sent: Sent[] = [];
  const statuses: SandboxStatus[] = [];
  const statusHooks: ((status: SandboxStatus) => void)[] = [];
  const onSize = vi.fn<(size: SandboxSize) => void>();
  const onOpenLink = vi.fn<OpenLink>(options.openLink);
  const onRequestTeardown = vi.fn<() => void>();
  const onShortcut = vi.fn<(press: SandboxShortcutPress) => void>();
  const host = new SandboxBridgeHost({
    resource: {
      html: "<p>hi</p>",
      kind: options.appRequests === null ? "page" : "app",
      networkPolicy: "https-only",
      csp: null,
      permissions: [],
      theme: { colorScheme: "light", background: null, variables: {} },
      forwardedShortcuts: [
        { code: "KeyK", ctrl: false, meta: true, alt: false, shift: false },
      ],
    },
    nonce: NONCE,
    hostContext: HOST_CONTEXT,
    hostVersion: "9.9.9",
    post: (message) => {
      if (isSent(message)) sent.push(message);
    },
    events: {
      onStatus: (status) => {
        statuses.push(status);
        for (const hook of statusHooks) hook(status);
      },
      onSize,
      onOpenLink,
      onShortcut,
      onRequestTeardown,
    },
    appRequests: options.appRequests,
  });
  hosts.push(host);
  return {
    host,
    sent,
    statuses,
    statusHooks,
    onSize,
    onOpenLink,
    onRequestTeardown,
    onShortcut,
    all: (method) => sent.filter((message) => message.method === method),
    responseTo: (id) => sent.find((message) => message.id === id),
  };
}

function proxyReady(): Sent {
  return {
    jsonrpc: "2.0",
    method: "ui/notifications/sandbox-proxy-ready",
    params: {},
  };
}

function documentReady(nonce: string, height: number): Sent {
  return {
    jsonrpc: "2.0",
    method: "traycer/notifications/document-ready",
    params: { nonce, height },
  };
}

function request(id: number | string, method: string, params: unknown): Sent {
  return { jsonrpc: "2.0", id, method, params };
}

function notification(method: string, params: unknown): Sent {
  return { jsonrpc: "2.0", method, params };
}

/** A harness whose frame has delivered the resource and proved the nonce. */
function ready(
  appRequests: SandboxAppRequestHandler | null,
  openLink: OpenLink,
): Harness {
  const harness = createHarness({ appRequests, openLink });
  harness.host.receive(proxyReady());
  harness.host.receive(documentReady(NONCE, 120));
  return harness;
}

function errorCode(response: Sent | undefined): unknown {
  const error = response?.error;
  return isSent(error) ? error.code : undefined;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
  vi.useRealTimers();
});

describe("loading handshake", () => {
  it("answers the loader's proxy-ready with the resource and the nonce", () => {
    const harness = createHarness({ appRequests: null, openLink: OPENS });
    harness.host.receive(proxyReady());
    const message = harness
      .all("ui/notifications/sandbox-resource-ready")
      .at(0);
    expect(message?.params).toMatchObject({
      html: "<p>hi</p>",
      kind: "page",
      networkPolicy: "https-only",
      csp: null,
      nonce: NONCE,
      bootstrap: {
        theme: { colorScheme: "light" },
        forwardedShortcuts: [{ code: "KeyK", meta: true }],
      },
    });
    expect(harness.host.status).toBe("loading");
  });

  it("sends nothing and goes ready only after the right nonce", () => {
    const harness = createHarness({ appRequests: null, openLink: OPENS });
    harness.host.receive(request(1, "ping", {}));
    expect(harness.sent).toEqual([]);
    harness.host.receive(proxyReady());
    harness.host.receive(documentReady(NONCE, 120));
    expect(harness.host.status).toBe("ready");
    expect(harness.statuses).toEqual(["ready"]);
  });

  it.each([
    ["a wrong nonce", () => documentReady("other", 120)],
    [
      "a document-ready without a nonce",
      () => notification("traycer/notifications/document-ready", {}),
    ],
  ])("disposes on %s", (_label, message) => {
    const harness = createHarness({ appRequests: null, openLink: OPENS });
    harness.host.receive(proxyReady());
    harness.host.receive(message());
    expect(harness.host.status).toBe("disposed");
    expect(harness.statuses).toEqual(["disposed"]);
  });

  it("ignores a document-ready that arrives before the resource was delivered", () => {
    const harness = createHarness({ appRequests: null, openLink: OPENS });
    harness.host.receive(documentReady(NONCE, 120));
    expect(harness.host.status).toBe("loading");
    harness.host.receive(proxyReady());
    harness.host.receive(documentReady(NONCE, 120));
    expect(harness.host.status).toBe("ready");
  });

  it("disposes on a repeated nonce", () => {
    const harness = ready(null, OPENS);
    harness.host.receive(documentReady(NONCE, 120));
    expect(harness.host.status).toBe("disposed");
  });

  it("allows two frame loads and disposes on the third", () => {
    const harness = ready(null, OPENS);
    harness.host.frameLoaded();
    harness.host.frameLoaded();
    expect(harness.host.status).toBe("ready");
    harness.host.frameLoaded();
    expect(harness.host.status).toBe("disposed");
  });

  it("disposes when the loader comes back with a second proxy-ready", () => {
    const harness = ready(null, OPENS);
    harness.host.receive(proxyReady());
    expect(harness.host.status).toBe("disposed");
    expect(harness.all("ui/notifications/sandbox-resource-ready")).toHaveLength(
      1,
    );
  });

  it("answers nothing once disposed", () => {
    const harness = ready(null, OPENS);
    harness.host.dispose();
    const before = harness.sent.length;
    harness.host.receive(request(1, "ping", {}));
    harness.host.notify("ui/notifications/tool-result", {});
    expect(harness.sent).toHaveLength(before);
  });
});

describe("page requests", () => {
  it("answers ping", () => {
    const harness = ready(null, OPENS);
    harness.host.receive(request(7, "ping", {}));
    expect(harness.responseTo(7)?.result).toEqual({});
  });

  it("answers ui/initialize with the protocol version, host info and context", () => {
    const harness = ready(null, OPENS);
    harness.host.receive(request(1, "ui/initialize", {}));
    expect(harness.responseTo(1)?.result).toMatchObject({
      protocolVersion: "2026-01-26",
      hostInfo: { name: "Traycer", version: "9.9.9" },
      hostCapabilities: { openLinks: {} },
      hostContext: HOST_CONTEXT,
    });
  });

  it("advertises app capabilities only to an app", () => {
    const page = ready(null, OPENS);
    page.host.receive(request(1, "ui/initialize", {}));
    expect(page.responseTo(1)?.result).toMatchObject({
      hostCapabilities: { openLinks: {} },
    });
    const pageCaps = isSent(page.responseTo(1)?.result)
      ? page.responseTo(1)?.result
      : undefined;
    expect(JSON.stringify(pageCaps)).not.toContain("serverTools");

    const app = ready(() => Promise.resolve({}), OPENS);
    app.host.receive(request(1, "ui/initialize", {}));
    expect(app.responseTo(1)?.result).toMatchObject({
      hostCapabilities: { serverTools: {}, serverResources: {}, message: {} },
    });
  });

  it("opens an http(s) link once the reader confirms, and answers success", async () => {
    const harness = ready(null, OPENS);
    harness.host.receive(
      request(1, "ui/open-link", { url: "https://example.com/a" }),
    );
    expect(harness.onOpenLink).toHaveBeenCalledWith("https://example.com/a");
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.responseTo(1)?.result).toEqual({});
  });

  it("answers an error when the reader cancels", async () => {
    const harness = ready(null, () => Promise.resolve(false));
    harness.host.receive(
      request(1, "ui/open-link", { url: "https://example.com/a" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.responseTo(1)?.result).toBeUndefined();
    expect(errorCode(harness.responseTo(1))).toBe(-32000);
  });

  it("refuses a second link while the reader is deciding on the first", async () => {
    let decide: (opened: boolean) => void = () => undefined;
    const harness = ready(
      null,
      () =>
        new Promise<boolean>((resolve) => {
          decide = resolve;
        }),
    );
    harness.host.receive(
      request(1, "ui/open-link", { url: "https://example.com/a" }),
    );
    harness.host.receive(
      request(2, "ui/open-link", { url: "https://example.com/b" }),
    );
    expect(harness.onOpenLink).toHaveBeenCalledTimes(1);
    expect(errorCode(harness.responseTo(2))).toBe(-32000);
    expect(harness.responseTo(1)).toBeUndefined();

    decide(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.responseTo(1)?.result).toEqual({});
    harness.host.receive(
      request(3, "ui/open-link", { url: "https://example.com/b" }),
    );
    expect(harness.onOpenLink).toHaveBeenCalledTimes(2);
  });

  it("asks about no link at all for 2 s after the reader declines one", async () => {
    const harness = ready(null, () => Promise.resolve(false));
    const ask = (id: number, url: string): void => {
      harness.host.receive(request(id, "ui/open-link", { url }));
    };
    ask(1, "https://example.com/a");
    await vi.advanceTimersByTimeAsync(0);
    ask(2, "https://example.com/a");
    ask(3, "https://example.com/a?n=2");
    expect(harness.onOpenLink).toHaveBeenCalledTimes(1);
    expect(errorCode(harness.responseTo(2))).toBe(-32000);
    expect(errorCode(harness.responseTo(3))).toBe(-32000);

    await vi.advanceTimersByTimeAsync(DECLINED_LINK_QUIET_MS);
    ask(4, "https://example.com/a?n=3");
    expect(harness.onOpenLink).toHaveBeenCalledTimes(2);
  });

  it("shows one confirm app-wide: another frame's link is refused meanwhile", async () => {
    let decide: (opened: boolean) => void = () => undefined;
    const first = ready(
      null,
      () =>
        new Promise<boolean>((resolve) => {
          decide = resolve;
        }),
    );
    const second = ready(null, OPENS);
    first.host.receive(
      request(1, "ui/open-link", { url: "https://example.com/a" }),
    );
    second.host.receive(
      request(1, "ui/open-link", { url: "https://example.com/b" }),
    );
    expect(second.onOpenLink).not.toHaveBeenCalled();
    expect(errorCode(second.responseTo(1))).toBe(-32000);

    decide(true);
    await vi.advanceTimersByTimeAsync(0);
    second.host.receive(
      request(2, "ui/open-link", { url: "https://example.com/b" }),
    );
    expect(second.onOpenLink).toHaveBeenCalledTimes(1);
  });

  it("frees the app-wide confirm when its frame is disposed", () => {
    const stuck = ready(null, () => new Promise<boolean>(() => undefined));
    const other = ready(null, OPENS);
    stuck.host.receive(
      request(1, "ui/open-link", { url: "https://example.com/a" }),
    );
    stuck.host.dispose();
    other.host.receive(
      request(1, "ui/open-link", { url: "https://example.com/b" }),
    );
    expect(other.onOpenLink).toHaveBeenCalledTimes(1);
  });

  it("reports disposed while it still holds the app-wide confirm slot", () => {
    const stuck = ready(null, () => new Promise<boolean>(() => undefined));
    const other = ready(null, OPENS);
    stuck.host.receive(
      request(1, "ui/open-link", { url: "https://example.com/a" }),
    );
    // The frame tears its confirm down on "disposed"; no other confirm may
    // open before it has.
    stuck.statusHooks.push((status) => {
      if (status !== "disposed") return;
      other.host.receive(
        request(1, "ui/open-link", { url: "https://example.com/b" }),
      );
    });
    stuck.host.receive(proxyReady());
    expect(stuck.host.status).toBe("disposed");
    expect(other.onOpenLink).not.toHaveBeenCalled();
    expect(errorCode(other.responseTo(1))).toBe(-32000);
    other.host.receive(
      request(2, "ui/open-link", { url: "https://example.com/b" }),
    );
    expect(other.onOpenLink).toHaveBeenCalledTimes(1);
  });

  it("refuses a link longer than 8 KiB without asking", () => {
    const harness = ready(null, OPENS);
    const base = "https://example.com/";
    const at = (length: number): string =>
      base + "a".repeat(length - base.length);
    harness.host.receive(
      request(1, "ui/open-link", { url: at(MAX_LINK_URL_CHARS + 1) }),
    );
    expect(harness.onOpenLink).not.toHaveBeenCalled();
    expect(errorCode(harness.responseTo(1))).toBe(-32602);
    harness.host.receive(
      request(2, "ui/open-link", { url: at(MAX_LINK_URL_CHARS) }),
    );
    expect(harness.onOpenLink).toHaveBeenCalledTimes(1);
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "not a url", 5])(
    "never forwards %s to the host",
    (url) => {
      const harness = ready(null, OPENS);
      harness.host.receive(request(1, "ui/open-link", { url }));
      expect(harness.onOpenLink).not.toHaveBeenCalled();
      expect(errorCode(harness.responseTo(1))).toBe(-32602);
    },
  );

  it("reports a finite size and null for anything else", () => {
    const harness = ready(null, OPENS);
    harness.host.receive(
      notification("ui/notifications/size-changed", {
        width: 300,
        height: 480,
      }),
    );
    harness.host.receive(
      notification("ui/notifications/size-changed", {
        width: -1,
        height: "tall",
      }),
    );
    expect(harness.onSize.mock.calls).toEqual([
      [{ width: 300, height: 480 }],
      [{ width: null, height: null }],
    ]);
  });

  it("surfaces a page's request-teardown", () => {
    const harness = ready(null, OPENS);
    harness.host.receive(notification("ui/notifications/request-teardown", {}));
    expect(harness.onRequestTeardown).toHaveBeenCalledTimes(1);
  });

  it("reports a shortcut press only when it matches a forwarded chord", () => {
    const harness = ready(null, OPENS);
    const press = (code: string, meta: boolean): Sent =>
      notification("traycer/notifications/shortcut", {
        key: "k",
        code,
        ctrl: false,
        meta,
        alt: false,
        shift: false,
      });
    harness.host.receive(press("KeyK", true));
    harness.host.receive(press("KeyK", false));
    harness.host.receive(press("KeyJ", true));
    expect(harness.onShortcut).toHaveBeenCalledTimes(1);
  });
});

describe("app-to-page notifications", () => {
  it("holds them until the page says initialized, then sends in order", () => {
    const harness = ready(null, OPENS);
    harness.host.notify("ui/notifications/tool-input", { n: 1 });
    harness.host.notify("ui/notifications/tool-result", { n: 2 });
    expect(harness.all("ui/notifications/tool-input")).toEqual([]);
    harness.host.receive(notification("ui/notifications/initialized", {}));
    const methods = harness.sent.map((message) => message.method);
    expect(methods.slice(-2)).toEqual([
      "ui/notifications/tool-input",
      "ui/notifications/tool-result",
    ]);
    harness.host.notify("ui/notifications/tool-cancelled", {});
    expect(harness.all("ui/notifications/tool-cancelled")).toHaveLength(1);
  });

  it("does not replay the queue on a second initialized", () => {
    const harness = ready(null, OPENS);
    harness.host.notify("ui/notifications/tool-input", {});
    harness.host.receive(notification("ui/notifications/initialized", {}));
    harness.host.receive(notification("ui/notifications/initialized", {}));
    expect(harness.all("ui/notifications/tool-input")).toHaveLength(1);
  });
});

describe("host context changes", () => {
  it("sends only the keys that changed", () => {
    const harness = ready(null, OPENS);
    harness.host.updateHostContext({ ...HOST_CONTEXT, theme: "dark" });
    expect(
      harness.all("ui/notifications/host-context-changed").map((m) => m.params),
    ).toEqual([{ theme: "dark" }]);
  });

  it("sends nothing when nothing changed", () => {
    const harness = ready(null, OPENS);
    harness.host.updateHostContext({
      ...HOST_CONTEXT,
      styles: { variables: { "--font-sans": "Figtree" } },
    });
    expect(harness.all("ui/notifications/host-context-changed")).toEqual([]);
  });

  it("answers a later ui/initialize with the updated context", () => {
    const harness = createHarness({ appRequests: null, openLink: OPENS });
    harness.host.receive(proxyReady());
    harness.host.updateHostContext({ ...HOST_CONTEXT, theme: "dark" });
    harness.host.receive(documentReady(NONCE, 120));
    harness.host.receive(request(1, "ui/initialize", {}));
    expect(harness.responseTo(1)?.result).toMatchObject({
      hostContext: { theme: "dark" },
    });
    expect(harness.all("ui/notifications/host-context-changed")).toEqual([]);
  });
});

describe("app requests", () => {
  it("answers -32601 to app methods for a page or wireframe", () => {
    const harness = ready(null, OPENS);
    harness.host.receive(request(1, "tools/call", { name: "x" }));
    harness.host.receive(request(2, "resources/read", { uri: "ui://x" }));
    expect(errorCode(harness.responseTo(1))).toBe(-32601);
    expect(errorCode(harness.responseTo(2))).toBe(-32601);
  });

  it("answers -32601 to an unknown method even for an app", () => {
    const handler = vi.fn(() => Promise.resolve({}));
    const harness = ready(handler, OPENS);
    harness.host.receive(request(1, "tools/explode", {}));
    expect(errorCode(harness.responseTo(1))).toBe(-32601);
    expect(handler).not.toHaveBeenCalled();
  });

  it("routes an app method to the handler and answers its result", async () => {
    const handler = vi.fn(() => Promise.resolve({ content: ["ok"] }));
    const harness = ready(handler, OPENS);
    harness.host.receive(request(1, "tools/call", { name: "x" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledWith("tools/call", { name: "x" });
    expect(harness.responseTo(1)?.result).toEqual({ content: ["ok"] });
  });

  it("answers a rejected handler as a JSON-RPC error", async () => {
    const harness = ready(
      () => Promise.reject(new Error("tool is gone")),
      OPENS,
    );
    harness.host.receive(request(1, "tools/call", {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.responseTo(1)?.error).toEqual({
      code: -32603,
      message: "tool is gone",
    });
  });

  it("refuses the 17th in-flight request and frees a slot on completion", async () => {
    const releases: (() => void)[] = [];
    const harness = ready(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({}));
        }),
      OPENS,
    );
    for (let id = 1; id <= MAX_IN_FLIGHT_APP_REQUESTS; id += 1) {
      harness.host.receive(request(id, "tools/call", {}));
    }
    const extra = MAX_IN_FLIGHT_APP_REQUESTS + 1;
    harness.host.receive(request(extra, "tools/call", {}));
    expect(errorCode(harness.responseTo(extra))).toBe(-32000);
    expect(releases).toHaveLength(MAX_IN_FLIGHT_APP_REQUESTS);

    releases[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    harness.host.receive(request(extra + 1, "tools/call", {}));
    expect(releases).toHaveLength(MAX_IN_FLIGHT_APP_REQUESTS + 1);
    expect(harness.responseTo(extra + 1)).toBeUndefined();
  });

  it("drops an oversized message, answering a request with an error", () => {
    const handler = vi.fn(() => Promise.resolve({}));
    const harness = ready(handler, OPENS);
    const big = "x".repeat(MAX_INBOUND_MESSAGE_BYTES);
    harness.host.receive(request(1, "tools/call", { big }));
    expect(handler).not.toHaveBeenCalled();
    expect(errorCode(harness.responseTo(1))).toBe(-32602);
    const before = harness.sent.length;
    harness.host.receive(
      notification("ui/notifications/size-changed", { big }),
    );
    expect(harness.sent).toHaveLength(before);
    expect(harness.onSize).not.toHaveBeenCalled();
  });

  it("measures the cap in UTF-8 bytes, not UTF-16 units", () => {
    const handler = vi.fn(() => Promise.resolve({}));
    const harness = ready(handler, OPENS);
    const message = (text: string): Sent => request(1, "tools/call", { text });
    const bytes = (text: string): number =>
      new TextEncoder().encode(JSON.stringify(message(text))).byteLength;
    // "é" is one UTF-16 unit and two UTF-8 bytes.
    let text = "é".repeat(MAX_INBOUND_MESSAGE_BYTES / 2);
    while (bytes(text) > MAX_INBOUND_MESSAGE_BYTES) text = text.slice(1);
    expect(JSON.stringify(message(text)).length).toBeLessThan(
      MAX_INBOUND_MESSAGE_BYTES,
    );
    harness.host.receive(message(text));
    expect(handler).toHaveBeenCalledTimes(1);

    harness.host.receive(message(`${text}éé`));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(errorCode(harness.responseTo(1))).toBe(-32602);
  });

  it("refuses a payload that is not JSON and dispatches only parsed JSON", async () => {
    const handler = vi.fn<SandboxAppRequestHandler>(() => Promise.resolve({}));
    const harness = ready(handler, OPENS);
    harness.host.receive(
      request(1, "tools/call", { bytes: new ArrayBuffer(8) }),
    );
    harness.host.receive(request(2, "tools/call", { when: new Date(0) }));
    expect(handler).not.toHaveBeenCalled();
    expect(errorCode(harness.responseTo(1))).toBe(-32602);
    expect(errorCode(harness.responseTo(2))).toBe(-32602);

    const params = { name: "x", nested: { list: [1, "two"] } };
    harness.host.receive(request(3, "tools/call", params));
    await vi.advanceTimersByTimeAsync(0);
    const forwarded = handler.mock.calls[0]?.[1];
    expect(forwarded).toEqual(params);
    expect(forwarded).not.toBe(params);
  });
});

describe("crash detection", () => {
  function pingId(harness: Harness): string | number {
    const id = harness.all("ping")[0]?.id;
    if (typeof id !== "string" && typeof id !== "number") {
      throw new Error("no ping was sent");
    }
    return id;
  }

  it("pings once ready and stays ready when the page answers", () => {
    const harness = ready(null, OPENS);
    harness.host.receive({ jsonrpc: "2.0", id: pingId(harness), result: {} });
    vi.advanceTimersByTime(PING_TIMEOUT_MS * 2);
    expect(harness.host.status).toBe("ready");
  });

  it("marks the frame crashed when the ping goes unanswered for 5 s", () => {
    const harness = ready(null, OPENS);
    vi.advanceTimersByTime(PING_TIMEOUT_MS - 1);
    expect(harness.host.status).toBe("ready");
    vi.advanceTimersByTime(1);
    expect(harness.host.status).toBe("crashed");
    expect(harness.statuses).toEqual(["ready", "crashed"]);
  });

  it("marks a frame crashed at once when it errored early and rendered nothing", () => {
    const harness = createHarness({ appRequests: null, openLink: OPENS });
    harness.host.receive(proxyReady());
    harness.host.receive(notification("traycer/notifications/early-error", {}));
    harness.host.receive(documentReady(NONCE, 0));
    expect(harness.host.status).toBe("crashed");
    expect(harness.all("ping")).toEqual([]);
  });

  it("trusts an early error that still rendered something", () => {
    const harness = createHarness({ appRequests: null, openLink: OPENS });
    harness.host.receive(proxyReady());
    harness.host.receive(notification("traycer/notifications/early-error", {}));
    harness.host.receive(documentReady(NONCE, 300));
    expect(harness.host.status).toBe("ready");
  });

  it("marks a frame crashed when the loader never posts document-ready", () => {
    const harness = createHarness({ appRequests: null, openLink: OPENS });
    harness.host.receive(proxyReady());
    vi.advanceTimersByTime(LOAD_TIMEOUT_MS - 1);
    expect(harness.host.status).toBe("loading");
    vi.advanceTimersByTime(1);
    expect(harness.host.status).toBe("crashed");
    expect(harness.statuses).toEqual(["crashed"]);
  });

  it("marks a frame crashed when the loader never answers at all", () => {
    const harness = createHarness({ appRequests: null, openLink: OPENS });
    vi.advanceTimersByTime(LOAD_TIMEOUT_MS);
    expect(harness.host.status).toBe("crashed");
  });

  it("stays crashed when document-ready comes after the watchdog", () => {
    const harness = createHarness({ appRequests: null, openLink: OPENS });
    harness.host.receive(proxyReady());
    vi.advanceTimersByTime(LOAD_TIMEOUT_MS);
    harness.host.receive(documentReady(NONCE, 120));
    expect(harness.host.status).toBe("crashed");
    expect(harness.statuses).toEqual(["crashed"]);
  });

  it("stops the load watchdog once ready or disposed", () => {
    const loaded = ready(null, OPENS);
    loaded.host.receive({
      jsonrpc: "2.0",
      id: pingId(loaded),
      result: {},
    });
    const disposed = createHarness({ appRequests: null, openLink: OPENS });
    disposed.host.dispose();
    vi.advanceTimersByTime(LOAD_TIMEOUT_MS * 2);
    expect(loaded.host.status).toBe("ready");
    expect(disposed.statuses).toEqual(["disposed"]);
  });

  it("does not report a crash after dispose", () => {
    const harness = ready(null, OPENS);
    harness.host.dispose();
    vi.advanceTimersByTime(PING_TIMEOUT_MS * 2);
    expect(harness.statuses).toEqual(["ready", "disposed"]);
  });
});

describe("teardown", () => {
  it("disposes once the page answers resource-teardown", async () => {
    const harness = ready(null, OPENS);
    const done = harness.host.teardown();
    const asked = harness.all("ui/resource-teardown").at(0);
    expect(asked).toBeDefined();
    if (asked === undefined || asked.id === undefined) return;
    harness.host.receive({ jsonrpc: "2.0", id: asked.id, result: {} });
    await done;
    expect(harness.host.status).toBe("disposed");
  });

  it("disposes after the 2 s grace when the page never answers", async () => {
    const harness = ready(null, OPENS);
    let finished = false;
    void harness.host.teardown().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(TEARDOWN_GRACE_MS - 1);
    expect(finished).toBe(false);
    expect(harness.host.status).not.toBe("disposed");
    await vi.advanceTimersByTimeAsync(1);
    expect(finished).toBe(true);
    expect(harness.host.status).toBe("disposed");
  });

  it("disposes without asking a frame that never loaded the resource", async () => {
    const harness = createHarness({ appRequests: null, openLink: OPENS });
    await harness.host.teardown();
    expect(harness.host.status).toBe("disposed");
    expect(harness.all("ui/resource-teardown")).toEqual([]);
  });
});
