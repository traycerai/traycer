import { describe, expect, it, vi } from "vitest";
import type { Input, MouseInputEvent } from "electron";
import type {
  BrowserCdpCommand,
  BrowserCdpResult,
  BrowserCdpTarget,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserViewAgentFocusReport,
  BrowserViewAgentFocusSignal,
} from "@traycer-clients/shared/platform/browser-view";
import type { BrowserViewWebContents } from "../../browser-view-port";
import { BrowserViewEntryRegistry } from "../browser-view-entry-registry";
import type { BrowserViewEntry } from "../browser-view-entry";
import { BrowserViewAgentFocus } from "../browser-view-agent-focus";
import { BrowserViewDebugSessions } from "../debug-session-for";
import {
  BrowserDebugSession,
  type BrowserDebugLease,
} from "../../debug/browser-debug-session";
import { NativeBrowserViewLifecycle } from "../native-browser-view-lifecycle";
import { FakeWebContents } from "../../debug/__tests__/browser-debug-session-test-support";

const WINDOW_ID = "window-1";
const TARGET: BrowserCdpTarget = { kind: "root" };
const press = {
  kind: "cdpDispatchMouseEvent",
  type: "mousePressed",
  x: 4,
  y: 5,
  button: "left",
  clickCount: 1,
  deltaX: null,
  deltaY: null,
} as const satisfies BrowserCdpCommand;
const key = {
  kind: "cdpDispatchKeyEvent",
  type: "keyDown",
  key: "a",
  code: null,
  text: null,
  modifiers: null,
  unmodifiedText: null,
  windowsVirtualKeyCode: null,
  location: null,
  isKeypad: null,
  autoRepeat: null,
  commands: null,
} as const satisfies BrowserCdpCommand;
const result: BrowserCdpResult = { kind: "cdpDispatchMouseEvent", ok: true };
const mouseDown: MouseInputEvent = { type: "mouseDown", x: 0, y: 0 };
const keyDown: Input = {
  type: "keyDown",
  key: "x",
  code: "KeyX",
  isAutoRepeat: false,
  isComposing: false,
  shift: false,
  control: false,
  alt: false,
  meta: false,
  location: 0,
  modifiers: [],
};

function setFocused(contents: BrowserViewWebContents, focused: boolean): void {
  Object.defineProperty(contents, "focusedFrame", {
    configurable: true,
    value: focused ? {} : null,
  });
}

class FocusWindow extends FakeWebContents {
  focused = true;
  destroyed = false;
  get webContents(): FakeWebContents {
    return this;
  }
  isFocused(): boolean {
    return this.focused;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  focus(): void {
    this.focused = true;
    this.emit("focus");
  }
  blur(): void {
    this.focused = false;
    this.emit("blur");
  }
}

function createEntry(
  registrationId: string,
  options: { agent?: boolean; focused?: boolean },
): BrowserViewEntry & { readonly webContents: FakeWebContents } {
  const keyId = `tab-${registrationId}`;
  const capability = {
    hostId: "host-1",
    sessionId: "session-1",
    tabId: keyId,
    registrationId,
  };
  const lifecycle = new NativeBrowserViewLifecycle();
  lifecycle.completeProvisioning(capability, null);
  lifecycle.accept();
  const webContents = new FakeWebContents();
  webContents.debugger.attached = options.agent !== false;
  if (options.focused) setFocused(webContents, true);
  vi.spyOn(webContents.debugger, "sendCommand").mockImplementation(
    async (method, params, sessionId) => {
      webContents.debugger.commands.push({ method, params, sessionId });
      if (method === "Input.dispatchMouseEvent") {
        setFocused(webContents, true);
      }
      return {};
    },
  );
  return {
    surface: {
      windowId: WINDOW_ID,
      viewTabId: keyId,
      paneId: "pane",
      tileInstanceId: `tile-${registrationId}`,
      pageSessionId: "page",
    },
    surfaceBindingId: null,
    guestKey: `guest-${registrationId}`,
    identity: {
      key: capability,
      ...capability,
      lifecycleWindowId: WINDOW_ID,
      lifecycle,
    },
    profile: "primary",
    webContents,
    listeners: {},
    desiredVisible: true,
    requestedUrl: "https://example.test",
    currentUrl: "https://example.test",
    currentTitle: "Example",
    status: "ready",
    statusReason: null,
    navigationAttempt: 0,
    findState: {
      appRequestId: 0,
      query: "",
      matchCase: false,
      sessionsByElectronRequestId: new Map(),
    },
    certificateError: null,
    debugSession: null,
    seedLease: null,
    agentCdpLease:
      options.agent === false
        ? null
        : ({
            release: vi.fn(),
            ready: async () => undefined,
          } satisfies BrowserDebugLease),
    annotationSession: null,
    devToolsWindow: null,
    rendererResetPending: false,
    internalNavigation: false,
    succeededByReplacement: false,
    closePromise: null,
  };
}

function createSession(entry: BrowserViewEntry) {
  const session = new BrowserDebugSession({
    webContents: entry.webContents,
    onDetached: () => undefined,
    interceptFileChooser: () => false,
  });
  vi.spyOn(session, "attachment").mockReturnValue(1);
  vi.spyOn(session, "isReady").mockReturnValue(true);
  vi.spyOn(session, "sendCommand").mockResolvedValue({});
  const dispatch = vi.spyOn(session, "dispatch").mockResolvedValue(result);
  const dispatchInput = vi
    .spyOn(session, "dispatchInput")
    .mockImplementation(async (_target, _command, around) => {
      const response = await around(async () => {
        setFocused(entry.webContents, true);
        return result;
      });
      return response as BrowserCdpResult;
    });
  return { session, dispatch, dispatchInput };
}

function harness(options: {
  focused?: boolean;
  hostAttached?: boolean;
  failAttach?: boolean;
  autoReady?: boolean;
  guardStarted?: boolean;
}) {
  const registry = new BrowserViewEntryRegistry<BrowserViewEntry>();
  const window = new FocusWindow();
  const app = window;
  app.debugger.attached = options.hostAttached ?? false;
  const attach = vi.spyOn(app.debugger, "attach").mockImplementation(() => {
    if (options.failAttach) throw new Error("attach failed");
    app.debugger.attached = true;
  });
  const detach = vi.spyOn(app.debugger, "detach").mockImplementation(() => {
    app.debugger.attached = false;
  });
  const entry = createEntry("agent", {});
  const owner = createEntry("owner", { agent: false });
  const other = createEntry("other", { agent: false });
  const hostSendCommand = vi
    .spyOn(app.debugger, "sendCommand")
    .mockImplementation(async (method, params, sessionId) => {
      app.debugger.commands.push({ method, params, sessionId });
      if (method === "Input.dispatchMouseEvent") {
        setFocused(app, true);
        for (const guest of registry.guestValues())
          setFocused(guest.webContents, false);
      }
      return {};
    });
  window.focused = options.focused ?? true;
  registry.register(entry);
  registry.register(owner);
  registry.register(other);
  const events: BrowserViewAgentFocusSignal[] = [];
  const acknowledgements: BrowserViewAgentFocusReport[] = [];
  const focus = new BrowserViewAgentFocus({
    entries: registry,
    debugSessions: new BrowserViewDebugSessions({
      onDetached: () => undefined,
      isOnScreen: () => true,
    }),
    getWindow: () => window,
    send: (_windowId, _channel, payload) => {
      const signal = payload as BrowserViewAgentFocusSignal;
      events.push(signal);
      if (signal.kind === "begin" && options.autoReady !== false) {
        queueMicrotask(() =>
          acknowledge({ kind: "bracketOpened", bracketId: signal.bracketId }),
        );
      }
      return true;
    },
  });
  const acknowledge = (ready: BrowserViewAgentFocusReport): void => {
    acknowledgements.push(ready);
    focus.report(WINDOW_ID, ready);
  };
  if (options.guardStarted !== false) acknowledge({ kind: "guardStarted" });
  const { session, dispatch, dispatchInput } = createSession(entry);
  return {
    focus,
    window,
    app,
    entry,
    owner,
    other,
    events,
    acknowledgements,
    acknowledge,
    session,
    dispatch,
    dispatchInput,
    createSession,
    registry,
    attach,
    detach,
    hostSendCommand,
  };
}

describe("BrowserViewAgentFocus", () => {
  it("hands an agent press back to the app synchronously inside around", async () => {
    const h = harness({});
    const stages: string[] = [];
    h.dispatchInput.mockImplementation(async (_target, _command, around) => {
      const value = await around(async () => {
        stages.push("send");
        setFocused(h.entry.webContents, true);
        return result;
      });
      expect(
        h.app.debugger.commands.filter(
          (call) => call.method === "Input.dispatchMouseEvent",
        ),
      ).toHaveLength(2);
      stages.push("around-return");
      return value as BrowserCdpResult;
    });
    const output = await h.focus.dispatchInput(
      h.entry,
      h.session,
      TARGET,
      press,
    );
    stages.push("dispatch-return");
    expect(output).toEqual(result);
    expect(stages).toEqual(["send", "around-return", "dispatch-return"]);
    expect(
      h.app.debugger.commands
        .filter((call) => call.method === "Input.dispatchMouseEvent")
        .map((call) => call.params),
    ).toEqual([
      { type: "mousePressed", x: -1, y: -1, button: "none" },
      { type: "mouseReleased", x: -1, y: -1, button: "none" },
    ]);
  });

  it("pre-steals to the tab before a key, sends the key, then hands back", async () => {
    const h = harness({});
    const order: string[] = [];
    h.dispatchInput.mockImplementation(async (_target, _command, around) => {
      const value = await around(async () => {
        order.push("key");
        setFocused(h.entry.webContents, true);
        return result;
      });
      return value as BrowserCdpResult;
    });
    await h.focus.dispatchInput(h.entry, h.session, TARGET, key);
    const tabInputs = h.entry.webContents.debugger.commands.filter(
      (call) => call.method === "Input.dispatchMouseEvent",
    );
    expect(tabInputs.slice(0, 2).map((call) => call.params.type)).toEqual([
      "mousePressed",
      "mouseReleased",
    ]);
    expect(order).toEqual(["key"]);
    expect(
      h.app.debugger.commands.filter(
        (call) => call.method === "Input.dispatchMouseEvent",
      ),
    ).toHaveLength(2);
  });

  it("parks a focused tab while the window is behind and hands back on focus", async () => {
    const h = harness({ focused: false });
    await h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    expect(
      h.app.debugger.commands.filter(
        (call) => call.method === "Input.dispatchMouseEvent",
      ),
    ).toHaveLength(0);
    expect(h.focus.suppressesTileFocus(h.entry)).toBe(true);
    h.window.focus();
    expect(
      h.app.debugger.commands.filter(
        (call) => call.method === "Input.dispatchMouseEvent",
      ),
    ).toHaveLength(2);
  });

  it("makes a person's press the owner and signals only while input is in flight", async () => {
    const h = harness({});
    let finish!: (value: unknown) => void;
    h.dispatchInput.mockImplementation(async (_target, _command, around) => {
      const value = await around(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      return value as BrowserCdpResult;
    });
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, key);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    h.focus.handleGuestMouse(h.entry, mouseDown);
    expect(
      h.events.filter((event) => event.kind === "personPress"),
    ).toHaveLength(1);
    expect(h.focus.suppressesTileFocus(h.entry)).toBe(false);
    finish(result);
    await pending;
    const another = harness({});
    await another.focus.dispatchInput(
      another.entry,
      another.session,
      TARGET,
      key,
    );
    another.focus.handleGuestMouse(another.entry, mouseDown);
    expect(another.events.some((event) => event.kind === "personPress")).toBe(
      false,
    );
  });

  it("hands an in-flight agent press back to a person's tile", async () => {
    const h = harness({});
    let finish!: (value: unknown) => void;
    h.dispatchInput.mockImplementation(async (_target, _command, around) => {
      const value = await around(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      return value as BrowserCdpResult;
    });
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));

    h.focus.handleGuestMouse(h.other, mouseDown);
    expect(h.other.webContents.debugger.isAttached()).toBe(true);
    setFocused(h.entry.webContents, true);
    setFocused(h.other.webContents, false);
    setFocused(h.app, false);
    finish(result);
    await expect(pending).resolves.toEqual(result);

    expect(
      h.other.webContents.debugger.commands
        .filter(
          (command) =>
            command.method === "Input.dispatchMouseEvent" &&
            command.params.button === "none",
        )
        .map((command) => command.params.type),
    ).toEqual(["mousePressed", "mouseReleased"]);
  });

  it("hands a behind window back to the app after another tab's press", async () => {
    const h = harness({ focused: false });
    let finishA!: (value: unknown) => void;
    h.dispatchInput.mockImplementation(async (_target, _command, around) => {
      const value = await around(
        () =>
          new Promise((resolve) => {
            setFocused(h.entry.webContents, true);
            setFocused(h.app, false);
            finishA = resolve;
          }),
      );
      return value as BrowserCdpResult;
    });
    const inputA = h.focus.dispatchInput(h.entry, h.session, TARGET, key);
    await vi.waitFor(() => expect(finishA).toBeTypeOf("function"));

    const tabB = createEntry("agent-b", {});
    h.registry.register(tabB);
    const sessionB = h.createSession(tabB);
    sessionB.dispatchInput.mockImplementation(
      async (_target, _command, around) => {
        const value = await around(async () => {
          setFocused(h.entry.webContents, false);
          setFocused(tabB.webContents, true);
          setFocused(h.app, false);
          return result;
        });
        return value as BrowserCdpResult;
      },
    );
    await h.focus.dispatchInput(tabB, sessionB.session, TARGET, press);
    const tabAHandBacksBeforeFocus =
      h.entry.webContents.debugger.commands.filter(
        (command) =>
          command.method === "Input.dispatchMouseEvent" &&
          command.params.button === "none",
      ).length;
    const appHandBacksBeforeFocus = h.app.debugger.commands.filter(
      (command) =>
        command.method === "Input.dispatchMouseEvent" &&
        command.params.button === "none",
    ).length;

    h.window.focus();
    expect(
      h.app.debugger.commands
        .filter(
          (command) =>
            command.method === "Input.dispatchMouseEvent" &&
            command.params.button === "none",
        )
        .map((command) => command.params.type),
    ).toHaveLength(appHandBacksBeforeFocus + 2);
    finishA(result);
    await expect(inputA).resolves.toEqual(result);
    expect(
      h.entry.webContents.debugger.commands.filter(
        (command) =>
          command.method === "Input.dispatchMouseEvent" &&
          command.params.button === "none",
      ),
    ).toHaveLength(tabAHandBacksBeforeFocus);
  });

  it("reattaches a detached host debugger for hand-back and releases it when idle", async () => {
    const h = harness({ hostAttached: true });
    h.dispatchInput.mockImplementation(async (_target, _command, around) => {
      const value = await around(async () => {
        h.app.debugger.attached = false;
        setFocused(h.entry.webContents, true);
        setFocused(h.app, false);
        return result;
      });
      return value as BrowserCdpResult;
    });

    await expect(
      h.focus.dispatchInput(h.entry, h.session, TARGET, press),
    ).resolves.toEqual(result);
    expect(h.attach).toHaveBeenCalledTimes(1);
    expect(
      h.app.debugger.commands
        .filter(
          (command) =>
            command.method === "Input.dispatchMouseEvent" &&
            command.params.button === "none",
        )
        .map((command) => command.params.type),
    ).toEqual(["mousePressed", "mouseReleased"]);
    expect(h.detach).toHaveBeenCalledTimes(1);
  });

  it("consumes a late-routed press token as agent input", async () => {
    const h = harness({});
    let finish!: (value: unknown) => void;
    h.dispatchInput.mockImplementation(async (_target, _command, around) => {
      const value = await around(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      return value as BrowserCdpResult;
    });
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    h.focus.handleGuestMouse(h.entry, mouseDown);
    expect(h.events.some((event) => event.kind === "personPress")).toBe(false);
    expect(h.focus.suppressesTileFocus(h.entry)).toBe(true);
    finish(result);
    await pending;

    const person = harness({});
    await person.focus.dispatchInput(
      person.entry,
      person.session,
      TARGET,
      press,
    );
    person.focus.handleGuestMouse(person.entry, mouseDown);
    expect(person.focus.suppressesTileFocus(person.entry)).toBe(false);
  });

  it("redirects a stray key during an agent press and reports it handled", async () => {
    const h = harness({});
    let finish!: (value: unknown) => void;
    h.dispatchInput.mockImplementation(async (_target, _command, around) => {
      const value = await around(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      return value as BrowserCdpResult;
    });
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(h.focus.redirectStrayKey(h.entry, keyDown)).toBe(true);
    expect(
      h.app.debugger.commands.some(
        (call) =>
          call.method === "Input.dispatchKeyEvent" && call.params.text === "x",
      ),
    ).toBe(true);
    finish(result);
    await pending;
  });

  it("suppresses only agent-owned focus and allows the person's tile", async () => {
    const h = harness({});
    expect(h.focus.suppressesTileFocus(h.entry)).toBe(false);
    let finish!: (value: unknown) => void;
    h.dispatchInput.mockImplementation(async (_target, _command, around) => {
      const value = await around(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      return value as BrowserCdpResult;
    });
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, key);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(h.focus.suppressesTileFocus(h.entry)).toBe(true);
    h.focus.handleGuestMouse(h.entry, mouseDown);
    expect(h.focus.suppressesTileFocus(h.entry)).toBe(false);
    finish(result);
    await pending;
  });

  it("waits for bracketOpened before dispatching input", async () => {
    const h = harness({ autoReady: false });
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "begin")).toBe(true),
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(h.session.dispatchInput).not.toHaveBeenCalled();
    const begin = h.events.find((event) => event.kind === "begin");
    if (begin?.kind !== "begin") throw new Error("missing begin");
    h.acknowledge({ kind: "bracketOpened", bracketId: begin.bracketId });
    await expect(pending).resolves.toEqual(result);
    expect(h.session.dispatchInput).toHaveBeenCalledTimes(1);
  });

  it("keeps an input held after bracketHeld cancels the begin deadline", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ autoReady: false });
      const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
      await vi.waitFor(() =>
        expect(h.events.some((event) => event.kind === "begin")).toBe(true),
      );
      const begin = h.events.find((event) => event.kind === "begin");
      if (begin?.kind !== "begin") throw new Error("missing begin");
      h.acknowledge({ kind: "bracketHeld", bracketId: begin.bracketId });
      await vi.advanceTimersByTimeAsync(10_001);
      expect(h.session.dispatchInput).not.toHaveBeenCalled();
      h.acknowledge({ kind: "bracketOpened", bracketId: begin.bracketId });
      await expect(pending).resolves.toEqual(result);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves pending and future inputs when the guard stops", async () => {
    const h = harness({ autoReady: false });
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "begin")).toBe(true),
    );
    h.acknowledge({ kind: "guardStopped" });
    await expect(pending).resolves.toEqual(result);
    await expect(
      h.focus.dispatchInput(h.entry, h.session, TARGET, press),
    ).resolves.toEqual(result);
  });

  it("does not wait for a bracket ack in an unguarded window", async () => {
    const h = harness({ autoReady: false, guardStarted: false });
    await expect(
      h.focus.dispatchInput(h.entry, h.session, TARGET, press),
    ).resolves.toEqual(result);
    expect(h.acknowledgements).toEqual([]);
    expect(h.events.some((event) => event.kind === "begin")).toBe(true);
  });

  it("uses the begin deadline when the page does not acknowledge", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ autoReady: false });
      const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
      await vi.advanceTimersByTimeAsync(10_001);
      await expect(pending).resolves.toEqual(result);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a pending begin when the renderer resets", async () => {
    const h = harness({ autoReady: false });
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "begin")).toBe(true),
    );
    h.app.emit("did-start-navigation", {}, "https://next.test/", false, true);
    await expect(pending).resolves.toEqual(result);
    const begin = h.events.find((event) => event.kind === "begin");
    if (begin?.kind !== "begin") throw new Error("missing begin");
    h.acknowledge({ kind: "bracketOpened", bracketId: begin.bracketId });
    const ackCount = h.acknowledgements.length;
    await expect(
      h.focus.dispatchInput(h.entry, h.session, TARGET, press),
    ).resolves.toEqual(result);
    expect(h.acknowledgements).toHaveLength(ackCount);
  });

  it("keeps the host debugger attached while another tab waits for its begin ack", async () => {
    const h = harness({ autoReady: false });
    const tabB = createEntry("agent-b", {});
    h.registry.register(tabB);
    const sessionB = h.createSession(tabB);
    const inputB = h.focus.dispatchInput(tabB, sessionB.session, TARGET, press);
    await vi.waitFor(() =>
      expect(
        h.events.some(
          (event) =>
            event.kind === "begin" && event.registrationId === "agent-b",
        ),
      ).toBe(true),
    );

    const inputA = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await vi.waitFor(() =>
      expect(
        h.events.some(
          (event) =>
            event.kind === "begin" &&
            event.registrationId === h.entry.identity.registrationId,
        ),
      ).toBe(true),
    );
    const beginA = h.events.find(
      (event) =>
        event.kind === "begin" &&
        event.registrationId === h.entry.identity.registrationId,
    );
    if (beginA?.kind !== "begin") throw new Error("missing tab A begin");
    h.acknowledge({ kind: "bracketOpened", bracketId: beginA.bracketId });
    await inputA;
    expect(h.app.debugger.isAttached()).toBe(true);

    const beforeBHandBack = h.app.debugger.commands.filter(
      (command) =>
        command.method === "Input.dispatchMouseEvent" &&
        command.params.button === "none",
    ).length;
    const beginB = h.events.find(
      (event) => event.kind === "begin" && event.registrationId === "agent-b",
    );
    if (beginB?.kind !== "begin") throw new Error("missing tab B begin");
    h.acknowledge({ kind: "bracketOpened", bracketId: beginB.bracketId });
    await inputB;
    const afterBHandBack = h.app.debugger.commands.filter(
      (command) =>
        command.method === "Input.dispatchMouseEvent" &&
        command.params.button === "none",
    ).length;
    expect(afterBHandBack).toBe(beforeBHandBack + 2);
  });

  it("ends the bracket and releases the host debugger only after hand-back answers", async () => {
    const h = harness({});
    const releases: Array<() => void> = [];
    h.hostSendCommand.mockImplementation(async (method, params, sessionId) => {
      h.app.debugger.commands.push({ method, params, sessionId });
      if (method !== "Input.dispatchMouseEvent") return {};
      setFocused(h.app, true);
      for (const guest of [h.entry, h.owner, h.other])
        setFocused(guest.webContents, false);
      return new Promise((resolve) => {
        releases.push(() => resolve({}));
      });
    });

    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(h.events.some((event) => event.kind === "end")).toBe(false);
    expect(h.detach).not.toHaveBeenCalled();
    expect(
      h.app.debugger.commands
        .filter((command) => command.method === "Input.dispatchMouseEvent")
        .map((command) => command.params.type),
    ).toEqual(["mousePressed", "mouseReleased"]);

    releases.forEach((release) => release());
    await pending;
    expect(h.events.some((event) => event.kind === "end")).toBe(true);
    expect(h.detach).toHaveBeenCalledTimes(1);
  });

  it("attaches the host debugger for input and detaches it when idle only when owned", async () => {
    const guarded = harness({});
    let finish!: (value: unknown) => void;
    guarded.dispatchInput.mockImplementation(
      async (_target, _command, around) => {
        const value = await around(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        );
        return value as BrowserCdpResult;
      },
    );
    const pending = guarded.focus.dispatchInput(
      guarded.entry,
      guarded.session,
      TARGET,
      press,
    );
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(guarded.attach).toHaveBeenCalledTimes(1);
    expect(guarded.app.debugger.isAttached()).toBe(true);
    finish(result);
    await pending;
    expect(guarded.detach).toHaveBeenCalledTimes(1);
    const preattached = harness({ hostAttached: true });
    await preattached.focus.dispatchInput(
      preattached.entry,
      preattached.session,
      TARGET,
      press,
    );
    expect(
      preattached.app.debugger.commands.some(
        (command) =>
          command.method === "Emulation.setFocusEmulationEnabled" &&
          command.params.enabled === false,
      ),
    ).toBe(true);
    expect(preattached.detach).not.toHaveBeenCalled();
  });

  it("resolves an agent press when the window is destroyed during send", async () => {
    const h = harness({});
    h.dispatchInput.mockImplementation(async (_target, _command, around) => {
      const value = await around(async () => {
        h.window.destroyed = true;
        vi.spyOn(h.window, "isFocused").mockImplementation(() => {
          throw new Error("Object has been destroyed");
        });
        setFocused(h.entry.webContents, true);
        return result;
      });
      return value as BrowserCdpResult;
    });

    await expect(
      h.focus.dispatchInput(h.entry, h.session, TARGET, press),
    ).resolves.toEqual(result);
  });

  it("falls back to plain dispatch when host debugger attach fails", async () => {
    const h = harness({ failAttach: true });
    await expect(
      h.focus.dispatchInput(h.entry, h.session, TARGET, key),
    ).resolves.toEqual(result);
    expect(h.dispatch).toHaveBeenCalledWith(TARGET, key);
  });
});
