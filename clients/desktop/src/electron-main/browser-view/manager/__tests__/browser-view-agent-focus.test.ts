import { describe, expect, it, vi } from "vitest";
import type { Input, InputEvent, MouseInputEvent } from "electron";
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
const abandonedResult: BrowserCdpResult = {
  kind: "cdpDispatchMouseEvent",
  ok: false,
  error: {
    kind: "cdp_error",
    message:
      "Input not sent: the app window was reloading or not responding, or the tab closed",
    code: null,
  },
};
const abandonedKeyResult: BrowserCdpResult = {
  ...abandonedResult,
  kind: "cdpDispatchKeyEvent",
};
const mouseDown: MouseInputEvent = { type: "mouseDown", x: 0, y: 0 };
const mouseDownInput: InputEvent = { type: "mouseDown" };
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

function setNoFocusedFrame(window: FocusWindow): void {
  Object.defineProperty(window, "focusedFrame", {
    configurable: true,
    value: null,
  });
}

async function dispatchAroundResult(
  command: BrowserCdpCommand,
  around: (send: () => Promise<unknown>) => Promise<unknown>,
  send: () => Promise<unknown>,
): Promise<BrowserCdpResult> {
  try {
    return (await around(send)) as BrowserCdpResult;
  } catch (error) {
    return {
      kind: command.kind,
      ok: false,
      error: {
        kind: "cdp_error",
        message: error instanceof Error ? error.message : String(error),
        code: null,
      },
    };
  }
}

class FocusWindow extends FakeWebContents {
  focused = true;
  destroyed = false;
  constructor() {
    super();
    Object.defineProperty(this, "focusedFrame", {
      configurable: true,
      value: {},
    });
  }
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
  options: {
    agent?: boolean;
    focused?: boolean;
    focusedNodeGone?: boolean;
  },
): BrowserViewEntry & {
  readonly webContents: FakeWebContents;
  readonly focusedNodeGone: boolean;
} {
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
      if (
        method === "Input.dispatchMouseEvent" &&
        options.focusedNodeGone !== true
      ) {
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
    focusedNodeGone: options.focusedNodeGone ?? false,
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

function createSession(
  entry: BrowserViewEntry & {
    readonly webContents: FakeWebContents;
    readonly focusedNodeGone: boolean;
  },
) {
  const session = new BrowserDebugSession({
    webContents: entry.webContents,
    onDetached: () => undefined,
    interceptFileChooser: () => false,
  });
  vi.spyOn(session, "attachment").mockReturnValue(1);
  vi.spyOn(session, "isReady").mockReturnValue(true);
  vi.spyOn(session, "sendCommand").mockResolvedValue({});
  const dispatch = vi.spyOn(session, "dispatch").mockResolvedValue(result);
  const rawSend = vi.fn(async (_command: BrowserCdpCommand) => result);
  const dispatchAround = vi
    .spyOn(session, "dispatchAround")
    .mockImplementation(async (_target, command, around) => {
      return dispatchAroundResult(command, around, async () => {
        if (!entry.focusedNodeGone) setFocused(entry.webContents, true);
        return rawSend(command);
      });
    });
  return { session, dispatch, dispatchAround, rawSend };
}

function harness(options: {
  focused?: boolean;
  noFocusedFrame?: boolean;
  hostAttached?: boolean;
  failAttach?: boolean;
  autoReady?: boolean;
  guardStarted?: boolean;
  beginSignalSends?: boolean;
  focusedNodeGone?: boolean;
}) {
  const registry = new BrowserViewEntryRegistry<BrowserViewEntry>();
  const window = new FocusWindow();
  if (options.noFocusedFrame === true) setNoFocusedFrame(window);
  const app = window;
  app.debugger.attached = options.hostAttached ?? false;
  const attach = vi.spyOn(app.debugger, "attach").mockImplementation(() => {
    if (options.failAttach) throw new Error("attach failed");
    app.debugger.attached = true;
  });
  const detach = vi.spyOn(app.debugger, "detach").mockImplementation(() => {
    app.debugger.attached = false;
  });
  const entry = createEntry(
    "agent",
    options.focusedNodeGone === undefined
      ? {}
      : { focusedNodeGone: options.focusedNodeGone },
  );
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
      const sent =
        signal.kind !== "begin" || options.beginSignalSends !== false;
      if (signal.kind === "begin" && sent && options.autoReady !== false) {
        queueMicrotask(() =>
          acknowledge({ kind: "bracketOpened", bracketId: signal.bracketId }),
        );
      }
      return sent;
    },
  });
  const acknowledge = (ready: BrowserViewAgentFocusReport): void => {
    acknowledgements.push(ready);
    focus.report(WINDOW_ID, ready);
  };
  if (options.guardStarted !== false) acknowledge({ kind: "guardStarted" });
  const { session, dispatch, dispatchAround, rawSend } = createSession(entry);
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
    dispatchAround,
    rawSend,
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
    vi.mocked(h.dispatchAround).mockImplementation(
      async (_target, command, around) => {
        const value = await dispatchAroundResult(command, around, async () => {
          stages.push("send");
          setFocused(h.entry.webContents, true);
          return h.rawSend(command);
        });
        expect(
          h.app.debugger.commands.filter(
            (call) => call.method === "Input.dispatchMouseEvent",
          ),
        ).toHaveLength(2);
        stages.push("around-return");
        return value;
      },
    );
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
    vi.mocked(h.rawSend).mockImplementation(async () => {
      order.push("key");
      setFocused(h.entry.webContents, true);
      return result;
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

  it("hands back a blind tab's key after its buttonless pre-press", async () => {
    const h = harness({ focusedNodeGone: true });
    const order: string[] = [];
    vi.mocked(h.rawSend).mockImplementation(async () => {
      expect(
        h.entry.webContents.debugger.commands.filter(
          (command) => command.method === "Input.dispatchMouseEvent",
        ),
      ).toHaveLength(2);
      order.push("agent-key");
      return result;
    });
    vi.mocked(h.hostSendCommand).mockImplementation(
      async (method, params, sessionId) => {
        h.app.debugger.commands.push({ method, params, sessionId });
        if (method === "Input.dispatchMouseEvent") {
          order.push(`app-${String(params.type)}`);
        }
        return {};
      },
    );

    await expect(
      h.focus.dispatchInput(h.entry, h.session, TARGET, key),
    ).resolves.toEqual(result);

    expect(order).toEqual([
      "agent-key",
      "app-mousePressed",
      "app-mouseReleased",
    ]);
    expect(
      h.app.debugger.commands
        .filter((command) => command.method === "Input.dispatchMouseEvent")
        .map((command) => command.params),
    ).toEqual([
      { type: "mousePressed", x: -1, y: -1, button: "none" },
      { type: "mouseReleased", x: -1, y: -1, button: "none" },
    ]);
  });

  it("redirects a parked blind tab's key to the app and settles on window focus", async () => {
    const h = harness({ focused: false, focusedNodeGone: true });
    await h.focus.dispatchInput(h.entry, h.session, TARGET, key);
    expect(
      h.app.debugger.commands.filter(
        (command) => command.method === "Input.dispatchMouseEvent",
      ),
    ).toHaveLength(0);

    expect(h.focus.redirectStrayKey(h.entry, keyDown)).toBe(true);
    expect(
      h.app.debugger.commands.some(
        (command) => command.method === "Input.dispatchKeyEvent",
      ),
    ).toBe(true);
    h.window.focus();

    await vi.waitFor(() => expect(h.detach).toHaveBeenCalledTimes(1));
    expect(
      h.app.debugger.commands.filter(
        (command) =>
          command.method === "Input.dispatchMouseEvent" &&
          command.params.button === "none",
      ),
    ).toHaveLength(2);
  });

  it("does not adopt a parked blind tab as the owner of another agent tab", async () => {
    const h = harness({ focused: false, focusedNodeGone: true });
    await h.focus.dispatchInput(h.entry, h.session, TARGET, key);
    const initialAHandbacks = h.entry.webContents.debugger.commands.filter(
      (command) =>
        command.method === "Input.dispatchMouseEvent" &&
        command.params.button === "none",
    ).length;
    const secondEntry = createEntry("agent-b", {});
    h.registry.register(secondEntry);
    const secondSession = h.createSession(secondEntry);

    await h.focus.dispatchInput(
      secondEntry,
      secondSession.session,
      TARGET,
      press,
    );
    h.window.focus();

    expect(
      h.app.debugger.commands
        .filter(
          (command) =>
            command.method === "Input.dispatchMouseEvent" &&
            command.params.button === "none",
        )
        .map((command) => command.params.type),
    ).toEqual(["mousePressed", "mouseReleased"]);
    expect(
      h.entry.webContents.debugger.commands.filter(
        (command) =>
          command.method === "Input.dispatchMouseEvent" &&
          command.params.button === "none",
      ),
    ).toHaveLength(initialAHandbacks);
  });

  it("pre-presses into a parked tab after app focus moves out of it", async () => {
    const h = harness({ focused: false });
    await h.focus.dispatchInput(h.entry, h.session, TARGET, key);

    setFocused(h.other.webContents, true);
    h.focus.handleGuestMouse(h.other, mouseDown);
    setFocused(h.entry.webContents, false);
    await h.focus.dispatchInput(h.entry, h.session, TARGET, key);

    setFocused(h.entry.webContents, false);
    setFocused(h.other.webContents, false);
    const order: string[] = [];
    vi.mocked(h.entry.webContents.debugger.sendCommand).mockImplementation(
      async (method, params, sessionId) => {
        h.entry.webContents.debugger.commands.push({
          method,
          params,
          sessionId,
        });
        if (method === "Input.dispatchMouseEvent" && params.button === "none") {
          order.push(`tile-pre-press-${String(params.type)}`);
          setFocused(h.entry.webContents, true);
          setFocused(h.other.webContents, false);
        }
        return {};
      },
    );
    vi.mocked(h.rawSend).mockImplementation(async () => {
      order.push("agent-key");
      return result;
    });

    await h.focus.dispatchInput(h.entry, h.session, TARGET, key);

    expect(order).toEqual([
      "tile-pre-press-mousePressed",
      "tile-pre-press-mouseReleased",
      "agent-key",
    ]);
    h.window.focus();
    await vi.waitFor(() =>
      expect(
        h.app.debugger.commands.filter(
          (command) =>
            command.method === "Input.dispatchMouseEvent" &&
            command.params.button === "none",
        ),
      ).toHaveLength(2),
    );
    expect(
      h.other.webContents.debugger.commands.filter(
        (command) =>
          command.method === "Input.dispatchMouseEvent" &&
          command.params.button === "none",
      ),
    ).toEqual([]);
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

  it("hands back after keyboard focus clears a stale person press", async () => {
    const h = harness({ focused: false });
    await h.focus.dispatchInput(h.entry, h.session, TARGET, key);
    h.focus.handleGuestMouse(h.entry, mouseDown);
    setFocused(h.entry.webContents, false);
    vi.mocked(h.rawSend).mockImplementation(async () => {
      setFocused(h.entry.webContents, true);
      return result;
    });

    await h.focus.dispatchInput(h.entry, h.session, TARGET, key);
    h.window.focus();

    expect(
      h.app.debugger.commands.filter(
        (command) =>
          command.method === "Input.dispatchMouseEvent" &&
          command.params.button === "none",
      ),
    ).toHaveLength(2);
  });

  it("hands an in-flight agent press back to a person's tile", async () => {
    const h = harness({});
    let finish!: (value: unknown) => void;
    vi.mocked(h.rawSend).mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));

    h.focus.handleGuestMouse(h.other, mouseDown);
    expect(h.other.webContents.debugger.isAttached()).toBe(true);
    await vi.waitFor(() =>
      expect(
        h.other.webContents.debugger.commands.some(
          (command) =>
            command.method === "Emulation.setFocusEmulationEnabled" &&
            command.params.enabled === true,
        ),
      ).toBe(true),
    );
    expect(
      h.other.webContents.debugger.commands.filter((command) =>
        [
          "Page.enable",
          "Runtime.enable",
          "Network.enable",
          "DOM.enable",
        ].includes(command.method),
      ),
    ).toEqual([]);
    vi.mocked(h.other.webContents.debugger.sendCommand).mockImplementation(
      async (method, params, sessionId) => {
        h.other.webContents.debugger.commands.push({
          method,
          params,
          sessionId,
        });
        if (method === "Input.dispatchMouseEvent") {
          setFocused(h.other.webContents, true);
          setFocused(h.entry.webContents, false);
        }
        return {};
      },
    );
    setFocused(h.entry.webContents, true);
    setFocused(h.other.webContents, false);
    finish(result);
    await expect(pending).resolves.toEqual(result);
    await vi.waitFor(() =>
      expect(h.other.webContents.debugger.isAttached()).toBe(false),
    );

    expect(
      h.other.webContents.debugger.commands
        .filter(
          (command) =>
            command.method === "Input.dispatchMouseEvent" &&
            command.params.button === "none",
        )
        .map((command) => command.params.type),
    ).toEqual(["mousePressed", "mouseReleased"]);
    expect(
      h.other.webContents.debugger.commands.some(
        (command) =>
          command.method === "Emulation.setFocusEmulationEnabled" &&
          command.params.enabled === false,
      ),
    ).toBe(true);
  });

  it("keeps a tile owner leased until its delayed hand-back finishes", async () => {
    const h = harness({});
    h.focus.handleGuestMouse(h.other, mouseDown);
    setFocused(h.other.webContents, true);
    setFocused(h.entry.webContents, false);
    const handBackAnswers: Array<() => void> = [];
    vi.mocked(h.other.webContents.debugger.sendCommand).mockImplementation(
      async (method, params, sessionId) => {
        h.other.webContents.debugger.commands.push({
          method,
          params,
          sessionId,
        });
        if (method !== "Input.dispatchMouseEvent") return {};
        setFocused(h.other.webContents, true);
        setFocused(h.entry.webContents, false);
        return new Promise<unknown>((resolve) => {
          handBackAnswers.push(() => resolve({}));
        });
      },
    );

    await expect(
      h.focus.dispatchInput(h.entry, h.session, TARGET, press),
    ).resolves.toEqual(result);
    await vi.waitFor(() => expect(handBackAnswers).toHaveLength(2));
    expect(h.events.some((event) => event.kind === "end")).toBe(true);
    expect(h.other.webContents.debugger.isAttached()).toBe(true);
    expect(
      h.other.webContents.debugger.commands.some(
        (command) =>
          command.method === "Emulation.setFocusEmulationEnabled" &&
          command.params.enabled === true,
      ),
    ).toBe(true);
    expect(
      h.other.webContents.debugger.commands.some(
        (command) =>
          command.method === "Emulation.setFocusEmulationEnabled" &&
          command.params.enabled === false,
      ),
    ).toBe(false);

    handBackAnswers.forEach((answer) => answer());
    await vi.waitFor(() =>
      expect(
        h.other.webContents.debugger.commands.some(
          (command) =>
            command.method === "Emulation.setFocusEmulationEnabled" &&
            command.params.enabled === false,
        ),
      ).toBe(true),
    );
    await vi.waitFor(() =>
      expect(h.other.webContents.debugger.isAttached()).toBe(false),
    );
  });

  it("hands a behind window back to the app after another tab's press", async () => {
    const h = harness({ focused: false });
    let finishA!: (value: unknown) => void;
    vi.mocked(h.rawSend).mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          setFocused(h.entry.webContents, true);
          finishA = resolve;
        }),
    );
    const inputA = h.focus.dispatchInput(h.entry, h.session, TARGET, key);
    await vi.waitFor(() => expect(finishA).toBeTypeOf("function"));

    const tabB = createEntry("agent-b", {});
    h.registry.register(tabB);
    const sessionB = h.createSession(tabB);
    vi.mocked(sessionB.rawSend).mockImplementation(async () => {
      setFocused(h.entry.webContents, false);
      setFocused(tabB.webContents, true);
      return result;
    });
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
    vi.mocked(h.rawSend).mockImplementation(async () => {
      h.app.debugger.attached = false;
      setFocused(h.entry.webContents, true);
      return result;
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

  it("redirects a stray key during an agent press and reports it handled", async () => {
    const h = harness({});
    let finish!: (value: unknown) => void;
    vi.mocked(h.rawSend).mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          finish = resolve;
        }),
    );
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

  it("ends a hung agent key after the app hand-back answers", async () => {
    const h = harness({});
    let rawSendStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      rawSendStarted = resolve;
    });
    vi.mocked(h.rawSend).mockImplementation(() => {
      rawSendStarted();
      return new Promise<unknown>(() => undefined);
    });
    void h.focus.dispatchInput(h.entry, h.session, TARGET, key);
    await started;

    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "end")).toBe(true),
    );
    expect(
      h.app.debugger.commands.filter(
        (command) => command.method === "Input.dispatchMouseEvent",
      ),
    ).toHaveLength(2);
  });

  it("ends a press that moves focus during dispatch without its CDP answer", async () => {
    const h = harness({});
    let rawSendStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      rawSendStarted = resolve;
    });
    vi.mocked(h.rawSend).mockImplementation(() => {
      setFocused(h.entry.webContents, true);
      rawSendStarted();
      return new Promise<unknown>(() => undefined);
    });
    void h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await started;

    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "end")).toBe(true),
    );
    expect(
      h.app.debugger.commands.filter(
        (command) => command.method === "Input.dispatchMouseEvent",
      ),
    ).toHaveLength(2);
  });

  it("ends a cross-site press after its CDP answer reports the focus move", async () => {
    const h = harness({ focusedNodeGone: true });
    let rawSendStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      rawSendStarted = resolve;
    });
    let finish!: (value: unknown) => void;
    vi.mocked(h.rawSend).mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          rawSendStarted();
          finish = resolve;
        }),
    );
    const handBackAnswers: Array<() => void> = [];
    vi.mocked(h.hostSendCommand).mockImplementation(
      async (method, params, sessionId) => {
        h.app.debugger.commands.push({ method, params, sessionId });
        if (method !== "Input.dispatchMouseEvent") return {};
        return new Promise<unknown>((resolve) => {
          handBackAnswers.push(() => resolve({}));
        });
      },
    );
    void h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await started;
    expect(h.events.some((event) => event.kind === "end")).toBe(false);
    expect(handBackAnswers).toHaveLength(0);
    setFocused(h.entry.webContents, true);
    finish(result);
    await vi.waitFor(() => expect(handBackAnswers).toHaveLength(2));
    expect(h.events.some((event) => event.kind === "end")).toBe(false);
    handBackAnswers.forEach((answer) => answer());
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "end")).toBe(true),
    );
  });

  it("settles a hung press when tileTookFocus confirms Chromium moved focus", async () => {
    const h = harness({ focusedNodeGone: true });
    let rawSendStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      rawSendStarted = resolve;
    });
    vi.mocked(h.rawSend).mockImplementation(() => {
      rawSendStarted();
      return new Promise<unknown>(() => undefined);
    });
    const handBackAnswers: Array<() => void> = [];
    vi.mocked(h.hostSendCommand).mockImplementation(
      async (method, params, sessionId) => {
        h.app.debugger.commands.push({ method, params, sessionId });
        if (method !== "Input.dispatchMouseEvent") return {};
        return new Promise<unknown>((resolve) => {
          handBackAnswers.push(() => resolve({}));
        });
      },
    );
    void h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await started;

    const appHandBack = () =>
      h.app.debugger.commands.filter(
        (command) =>
          command.method === "Input.dispatchMouseEvent" &&
          command.params.button === "none",
      );
    const report = {
      kind: "tileTookFocus",
      registrationId: h.entry.identity.registrationId,
    } as const;
    expect(h.events.some((event) => event.kind === "end")).toBe(false);
    h.focus.report(WINDOW_ID, report);
    expect(h.events.some((event) => event.kind === "end")).toBe(false);
    expect(appHandBack()).toHaveLength(0);

    setFocused(h.entry.webContents, true);
    h.focus.report(WINDOW_ID, report);
    await vi.waitFor(() => expect(handBackAnswers).toHaveLength(2));
    expect(appHandBack()).toHaveLength(2);
    expect(h.events.some((event) => event.kind === "end")).toBe(false);
    handBackAnswers.forEach((answer) => answer());
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "end")).toBe(true),
    );
  });

  it("ignores tileTookFocus when the tab has no unsettled press", () => {
    const h = harness({});

    h.focus.report(WINDOW_ID, {
      kind: "tileTookFocus",
      registrationId: h.entry.identity.registrationId,
    });

    expect(
      h.app.debugger.commands.filter(
        (command) => command.method === "Input.dispatchMouseEvent",
      ),
    ).toEqual([]);
  });

  it("hands back a press when a guest input event arrives after send returns", async () => {
    const h = harness({ focusedNodeGone: true });
    let finish!: (value: unknown) => void;
    vi.mocked(h.rawSend).mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    h.focus.handleGuestMouse(h.entry, mouseDown);
    setFocused(h.entry.webContents, true);
    h.focus.handleGuestInput(h.entry, mouseDownInput);

    expect(
      h.app.debugger.commands.filter(
        (command) => command.method === "Input.dispatchMouseEvent",
      ),
    ).toHaveLength(2);
    finish(result);
    await expect(pending).resolves.toEqual(result);
  });

  it("waits for send to return before handing back a press seen by guest input", async () => {
    const h = harness({ focusedNodeGone: true });
    const order: string[] = [];
    let rawSendStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      rawSendStarted = resolve;
    });
    vi.mocked(h.rawSend).mockImplementation(() => {
      order.push("send-started");
      setFocused(h.entry.webContents, true);
      h.focus.handleGuestMouse(h.entry, mouseDown);
      h.focus.handleGuestInput(h.entry, mouseDownInput);
      rawSendStarted();
      return new Promise<unknown>(() => undefined);
    });
    vi.mocked(h.dispatchAround).mockImplementation(
      async (_target, command, around) =>
        dispatchAroundResult(command, around, async () => {
          const response = h.rawSend(command);
          order.push("send-returned");
          return response;
        }),
    );
    const handBackAnswers: Array<() => void> = [];
    vi.mocked(h.hostSendCommand).mockImplementation(
      async (method, params, sessionId) => {
        h.app.debugger.commands.push({ method, params, sessionId });
        if (method !== "Input.dispatchMouseEvent") return {};
        order.push("hand-back");
        setFocused(h.entry.webContents, false);
        return new Promise<unknown>((resolve) => {
          handBackAnswers.push(() => resolve({}));
        });
      },
    );

    void h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await started;
    await vi.waitFor(() =>
      expect(
        h.app.debugger.commands.filter(
          (command) =>
            command.method === "Input.dispatchMouseEvent" &&
            command.params.button === "none",
        ),
      ).toHaveLength(2),
    );
    const begin = h.events.find((event) => event.kind === "begin");
    if (begin?.kind !== "begin") throw new Error("missing begin");

    expect(order).toEqual([
      "send-started",
      "send-returned",
      "hand-back",
      "hand-back",
    ]);
    expect(
      h.app.debugger.commands.filter(
        (command) =>
          command.method === "Input.dispatchMouseEvent" &&
          command.params.button === "none",
      ),
    ).toHaveLength(2);
    expect(h.events.some((event) => event.kind === "end")).toBe(false);

    handBackAnswers.forEach((answer) => answer());
    await vi.waitFor(() =>
      expect(h.events).toContainEqual({
        kind: "end",
        bracketId: begin.bracketId,
      }),
    );
  });

  it("consumes a late-routed press token as agent input", async () => {
    const h = harness({});
    let finish!: (value: unknown) => void;
    vi.mocked(h.rawSend).mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));

    h.focus.handleGuestMouse(h.entry, mouseDown);

    expect(h.events.some((event) => event.kind === "personPress")).toBe(false);
    expect(h.focus.redirectStrayKey(h.entry, keyDown)).toBe(true);
    expect(h.focus.suppressesTileFocus(h.entry)).toBe(true);
    expect(
      h.app.debugger.commands.some(
        (command) => command.method === "Input.dispatchKeyEvent",
      ),
    ).toBe(true);
    finish(result);
    await pending;

    h.focus.handleGuestMouse(h.entry, mouseDown);

    expect(h.focus.redirectStrayKey(h.entry, keyDown)).toBe(false);
    expect(h.focus.suppressesTileFocus(h.entry)).toBe(false);
    expect(h.events.some((event) => event.kind === "personPress")).toBe(false);
  });

  it("signals a person's press only while an agent bracket is open", async () => {
    const h = harness({ focusedNodeGone: true });
    let finish!: (value: unknown) => void;
    vi.mocked(h.rawSend).mockImplementation(() => {
      h.focus.handleGuestMouse(h.entry, mouseDown);
      return new Promise<unknown>((resolve) => (finish = resolve));
    });
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));

    h.focus.handleGuestMouse(h.entry, mouseDown);

    expect(h.events.filter((event) => event.kind === "personPress")).toEqual([
      {
        kind: "personPress",
        registrationId: h.entry.identity.registrationId,
      },
    ]);
    expect(h.focus.suppressesTileFocus(h.entry)).toBe(false);
    finish(result);
    await pending;

    const another = harness({ focusedNodeGone: true });
    vi.mocked(another.rawSend).mockImplementation(async () => {
      another.focus.handleGuestMouse(another.entry, mouseDown);
      return result;
    });
    await another.focus.dispatchInput(
      another.entry,
      another.session,
      TARGET,
      press,
    );
    another.focus.handleGuestMouse(another.entry, mouseDown);
    expect(another.events.some((event) => event.kind === "personPress")).toBe(
      false,
    );
  });

  it("suppresses only agent-owned focus and allows the person's tile", async () => {
    const h = harness({});
    expect(h.focus.suppressesTileFocus(h.entry)).toBe(false);
    let finish!: (value: unknown) => void;
    vi.mocked(h.rawSend).mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          finish = resolve;
        }),
    );
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
    expect(h.rawSend).not.toHaveBeenCalled();
    expect(h.events.filter((event) => event.kind === "begin")).toHaveLength(1);
    const begin = h.events.find((event) => event.kind === "begin");
    if (begin?.kind !== "begin") throw new Error("missing begin");
    h.acknowledge({ kind: "bracketOpened", bracketId: begin.bracketId });
    await expect(pending).resolves.toEqual(result);
    expect(h.rawSend).toHaveBeenCalledTimes(1);
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
      expect(h.rawSend).not.toHaveBeenCalled();
      h.acknowledge({ kind: "bracketOpened", bracketId: begin.bracketId });
      await expect(pending).resolves.toEqual(result);
      expect(h.rawSend).toHaveBeenCalledTimes(1);
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
    await expect(pending).resolves.toEqual(abandonedResult);
    expect(h.rawSend).not.toHaveBeenCalled();
    await expect(
      h.focus.dispatchInput(h.entry, h.session, TARGET, press),
    ).resolves.toEqual(result);
    expect(h.rawSend).toHaveBeenCalledTimes(1);
  });

  it("does not wait for a bracket ack in an unguarded window", async () => {
    const h = harness({ autoReady: false, guardStarted: false });
    await expect(
      h.focus.dispatchInput(h.entry, h.session, TARGET, press),
    ).resolves.toEqual(result);
    expect(h.acknowledgements).toEqual([]);
    expect(h.rawSend).toHaveBeenCalledTimes(1);
    expect(h.events.some((event) => event.kind === "begin")).toBe(true);
  });

  it("uses the begin deadline when the page does not acknowledge", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ autoReady: false });
      const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
      await vi.waitFor(() =>
        expect(h.events.some((event) => event.kind === "begin")).toBe(true),
      );
      const begin = h.events.find((event) => event.kind === "begin");
      if (begin?.kind !== "begin") throw new Error("missing begin");
      await vi.advanceTimersByTimeAsync(10_001);
      await expect(pending).resolves.toEqual(abandonedResult);
      expect(h.rawSend).not.toHaveBeenCalled();
      expect(h.events).toContainEqual({
        kind: "end",
        bracketId: begin.bracketId,
      });
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
    h.app.emit("did-navigate", {}, "https://next.test/");
    await expect(pending).resolves.toEqual(abandonedResult);
    expect(h.rawSend).not.toHaveBeenCalled();
    const begin = h.events.find((event) => event.kind === "begin");
    if (begin?.kind !== "begin") throw new Error("missing begin");
    expect(h.events).toContainEqual({
      kind: "end",
      bracketId: begin.bracketId,
    });
    h.acknowledge({ kind: "bracketOpened", bracketId: begin.bracketId });
    await expect(
      h.focus.dispatchInput(h.entry, h.session, TARGET, press),
    ).resolves.toEqual(abandonedResult);
    expect(h.rawSend).not.toHaveBeenCalled();

    h.acknowledge({ kind: "guardStarted" });
    const nextInput = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await vi.waitFor(() =>
      expect(h.events.filter((event) => event.kind === "begin")).toHaveLength(
        3,
      ),
    );
    expect(h.rawSend).not.toHaveBeenCalled();
    const nextBegin = h.events.filter((event) => event.kind === "begin").at(-1);
    if (nextBegin?.kind !== "begin") throw new Error("missing new begin");
    h.acknowledge({
      kind: "bracketOpened",
      bracketId: nextBegin.bracketId,
    });
    await expect(nextInput).resolves.toEqual(result);
    expect(h.rawSend).toHaveBeenCalledTimes(1);
  });

  it("ends an input and releases the host when the app renderer is lost during hand-back", async () => {
    const h = harness({});
    vi.mocked(h.hostSendCommand).mockImplementation(
      async (method, params, sessionId) => {
        h.app.debugger.commands.push({ method, params, sessionId });
        if (method === "Input.dispatchMouseEvent" && params.button === "none") {
          setFocused(h.entry.webContents, false);
          return new Promise<unknown>(() => undefined);
        }
        return {};
      },
    );
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await vi.waitFor(() =>
      expect(
        h.app.debugger.commands.filter(
          (command) =>
            command.method === "Input.dispatchMouseEvent" &&
            command.params.button === "none",
        ),
      ).toHaveLength(2),
    );
    const begin = h.events.find((event) => event.kind === "begin");
    if (begin?.kind !== "begin") throw new Error("missing begin");
    expect(h.events.some((event) => event.kind === "end")).toBe(false);

    h.app.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });

    await expect(pending).resolves.toEqual(result);
    expect(h.events).toContainEqual({
      kind: "end",
      bracketId: begin.bracketId,
    });
    await vi.waitFor(() => expect(h.detach).toHaveBeenCalledTimes(1));
  });

  it("waits for a new page's hand-back after navigation replaces the lost page", async () => {
    const h = harness({});
    const handBackAnswers: Array<() => void> = [];
    vi.mocked(h.hostSendCommand).mockImplementation(
      async (method, params, sessionId) => {
        h.app.debugger.commands.push({ method, params, sessionId });
        if (method !== "Input.dispatchMouseEvent" || params.button !== "none") {
          return {};
        }
        setFocused(h.entry.webContents, false);
        return new Promise<unknown>((resolve) => {
          handBackAnswers.push(() => resolve({}));
        });
      },
    );

    const firstInput = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await vi.waitFor(() =>
      expect(
        h.app.debugger.commands.filter(
          (command) =>
            command.method === "Input.dispatchMouseEvent" &&
            command.params.button === "none",
        ),
      ).toHaveLength(2),
    );
    const firstBegin = h.events.find((event) => event.kind === "begin");
    if (firstBegin?.kind !== "begin") throw new Error("missing first begin");
    h.app.emit("did-navigate", {}, "https://next.test/");
    await expect(firstInput).resolves.toEqual(result);
    expect(h.events).toContainEqual({
      kind: "end",
      bracketId: firstBegin.bracketId,
    });
    handBackAnswers.slice(0, 2).forEach((answer) => answer());

    h.acknowledge({ kind: "guardStarted" });
    let secondSettled = false;
    const secondInput = h.focus
      .dispatchInput(h.entry, h.session, TARGET, press)
      .then((value) => {
        secondSettled = true;
        return value;
      });
    await vi.waitFor(() =>
      expect(h.events.filter((event) => event.kind === "begin")).toHaveLength(
        2,
      ),
    );
    await vi.waitFor(() =>
      expect(
        h.app.debugger.commands.filter(
          (command) =>
            command.method === "Input.dispatchMouseEvent" &&
            command.params.button === "none",
        ),
      ).toHaveLength(4),
    );
    const begins = h.events.filter((event) => event.kind === "begin");
    const secondBegin = begins.at(-1);
    if (secondBegin?.kind !== "begin") throw new Error("missing second begin");
    expect(secondSettled).toBe(false);
    expect(
      h.events.some(
        (event) =>
          event.kind === "end" && event.bracketId === secondBegin.bracketId,
      ),
    ).toBe(false);

    handBackAnswers.slice(2).forEach((answer) => answer());
    await expect(secondInput).resolves.toEqual(result);
    expect(h.events).toContainEqual({
      kind: "end",
      bracketId: secondBegin.bracketId,
    });
  });

  it("keeps a tile owner leased until a hand-back made after the input is answered", async () => {
    const h = harness({});
    setFocused(h.other.webContents, true);
    const handBackAnswers: Array<() => void> = [];
    vi.mocked(h.other.webContents.debugger.sendCommand).mockImplementation(
      (method, params, sessionId) => {
        h.other.webContents.debugger.commands.push({
          method,
          params,
          sessionId,
        });
        if (method !== "Input.dispatchMouseEvent" || params.button !== "none") {
          return Promise.resolve({});
        }
        // Focus moves as the press is dispatched; its answer is held.
        setFocused(h.entry.webContents, false);
        setFocused(h.other.webContents, true);
        return new Promise<unknown>((resolve) => {
          handBackAnswers.push(() => resolve({}));
        });
      },
    );
    const emulationOff = (): boolean =>
      h.other.webContents.debugger.commands.some(
        (command) =>
          command.method === "Emulation.setFocusEmulationEnabled" &&
          command.params.enabled === false,
      );

    await expect(
      h.focus.dispatchInput(h.entry, h.session, TARGET, key),
    ).resolves.toEqual(result);
    await vi.waitFor(() => expect(handBackAnswers).toHaveLength(2));
    // Focus found in the agent's tab after its input ended goes back on window focus.
    setFocused(h.entry.webContents, true);
    setFocused(h.other.webContents, false);
    h.window.focus();
    await vi.waitFor(() => expect(handBackAnswers).toHaveLength(4));

    handBackAnswers.slice(0, 2).forEach((answer) => answer());
    // Every chain the first answer starts has run by the next macrotask.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.other.webContents.debugger.isAttached()).toBe(true);
    expect(emulationOff()).toBe(false);

    handBackAnswers.slice(2).forEach((answer) => answer());
    await vi.waitFor(() =>
      expect(h.other.webContents.debugger.isAttached()).toBe(false),
    );
    expect(emulationOff()).toBe(true);
  });

  it("does not abandon a pending bracket when navigation starts", async () => {
    const h = harness({ autoReady: false });
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "begin")).toBe(true),
    );
    const begin = h.events.find((event) => event.kind === "begin");
    if (begin?.kind !== "begin") throw new Error("missing begin");
    h.app.emit("did-start-navigation", {}, "https://next.test/", false, true);
    h.acknowledge({ kind: "bracketOpened", bracketId: begin.bracketId });

    await expect(pending).resolves.toEqual(result);
    expect(h.rawSend).toHaveBeenCalledTimes(1);
  });

  it("does not begin input after the tab closes during preparation", async () => {
    const h = harness({});
    let releaseEmulation!: () => void;
    let emulationStarted!: () => void;
    const emulationGate = new Promise<void>((resolve) => {
      releaseEmulation = resolve;
    });
    const emulationPending = new Promise<void>((resolve) => {
      emulationStarted = resolve;
    });
    vi.mocked(h.session.sendCommand).mockImplementation(async (method) => {
      if (method === "Emulation.setFocusEmulationEnabled") {
        emulationStarted();
        await emulationGate;
      }
      return {};
    });
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await emulationPending;
    let closeEntry!: () => void;
    h.entry.closePromise = new Promise<void>((resolve) => {
      closeEntry = resolve;
    });
    closeEntry();
    releaseEmulation();

    await expect(pending).resolves.toEqual(abandonedResult);
    expect(h.events.some((event) => event.kind === "begin")).toBe(false);
  });

  it("retries focus setup after a failed preparation and keeps it after success", async () => {
    const h = harness({});
    let emulationCalls = 0;
    vi.mocked(h.session.sendCommand).mockImplementation(async (method) => {
      if (method === "Emulation.setFocusEmulationEnabled") {
        emulationCalls += 1;
        if (emulationCalls === 1) throw new Error("setup failed");
      }
      return {};
    });

    await h.focus.dispatchInput(h.entry, h.session, TARGET, key);
    await h.focus.dispatchInput(h.entry, h.session, TARGET, key);
    await h.focus.dispatchInput(h.entry, h.session, TARGET, key);

    expect(emulationCalls).toBe(2);
  });

  it("re-reads the owner immediately before sending agent input", async () => {
    const h = harness({});
    await h.focus.dispatchInput(h.entry, h.session, TARGET, key);
    const appHandbacksBefore = h.app.debugger.commands.filter(
      (command) =>
        command.method === "Input.dispatchMouseEvent" &&
        command.params.button === "none",
    ).length;
    setFocused(h.entry.webContents, false);
    setFocused(h.other.webContents, true);
    h.focus.handleGuestMouse(h.other, mouseDown);
    vi.mocked(h.dispatchAround).mockImplementation(
      async (_target, command, around) => {
        setFocused(h.other.webContents, false);
        return dispatchAroundResult(command, around, async () => {
          setFocused(h.entry.webContents, true);
          return h.rawSend(command);
        });
      },
    );

    await expect(
      h.focus.dispatchInput(h.entry, h.session, TARGET, press),
    ).resolves.toEqual(result);
    expect(
      h.app.debugger.commands
        .filter(
          (command) =>
            command.method === "Input.dispatchMouseEvent" &&
            command.params.button === "none",
        )
        .slice(appHandbacksBefore)
        .map((command) => command.params.type),
    ).toEqual(["mousePressed", "mouseReleased"]);
    expect(
      h.other.webContents.debugger.commands.filter(
        (command) =>
          command.method === "Input.dispatchMouseEvent" &&
          command.params.button === "none",
      ),
    ).toEqual([]);
  });

  it("keeps parked focus until the owner can receive hand-back", async () => {
    const h = harness({ focused: false });
    await h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    h.app.debugger.emitDetach("target closed");
    vi.mocked(h.attach).mockImplementation(() => {
      throw new Error("attach failed");
    });
    h.window.focus();
    expect(h.focus.suppressesTileFocus(h.entry)).toBe(true);
    expect(h.detach).not.toHaveBeenCalled();

    vi.mocked(h.attach).mockImplementation(() => {
      h.app.debugger.attached = true;
    });
    h.app.debugger.attached = true;
    expect(h.focus.redirectStrayKey(h.entry, keyDown)).toBe(true);
    await vi.waitFor(() =>
      expect(
        h.app.debugger.commands.some(
          (command) =>
            command.method === "Emulation.setFocusEmulationEnabled" &&
            command.params.enabled === false,
        ),
      ).toBe(true),
    );
    expect(h.detach).not.toHaveBeenCalled();
  });

  it("reattaches the app for a parked key and sends it only when reachable", async () => {
    const h = harness({ focused: false });
    await h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    h.app.debugger.attached = false;
    h.attach.mockImplementation(() => {
      throw new Error("attach failed");
    });

    expect(h.focus.redirectStrayKey(h.entry, keyDown)).toBe(true);
    const keyCommandsWhileDetached = [
      h.app.debugger.commands,
      h.entry.webContents.debugger.commands,
      h.owner.webContents.debugger.commands,
      h.other.webContents.debugger.commands,
    ].flatMap((commands) =>
      commands.filter((command) => command.method === "Input.dispatchKeyEvent"),
    );
    expect(keyCommandsWhileDetached).toEqual([]);

    h.attach.mockImplementation(() => {
      h.app.debugger.attached = true;
    });
    expect(h.focus.redirectStrayKey(h.entry, keyDown)).toBe(true);
    expect(h.attach).toHaveBeenCalled();
    expect(
      h.app.debugger.commands.some(
        (command) =>
          command.method === "Input.dispatchKeyEvent" &&
          command.params.type === "keyDown" &&
          command.params.text === "x",
      ),
    ).toBe(true);
    expect(
      h.app.debugger.commands.filter(
        (command) =>
          command.method === "Input.dispatchMouseEvent" &&
          command.params.button === "none",
      ),
    ).toHaveLength(2);
    await vi.waitFor(() => expect(h.detach).toHaveBeenCalledTimes(1));
  });

  it("abandons an input and releases the guard when its tab is forgotten", async () => {
    const h = harness({ autoReady: false });
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "begin")).toBe(true),
    );
    const begin = h.events.find((event) => event.kind === "begin");
    if (begin?.kind !== "begin") throw new Error("missing begin");
    h.acknowledge({ kind: "bracketHeld", bracketId: begin.bracketId });
    h.focus.forget(h.entry);

    await expect(pending).resolves.toEqual(abandonedResult);
    expect(h.rawSend).not.toHaveBeenCalled();
    expect(h.detach).toHaveBeenCalledTimes(1);
  });

  it("releases a parked guard after the person clicks the app following a failed hand-back", async () => {
    const h = harness({ focused: false });
    await h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    h.app.debugger.emitDetach("target closed");
    h.attach.mockImplementation(() => {
      throw new Error("attach failed");
    });
    h.window.focus();
    h.app.debugger.attached = true;
    h.app.emit("before-mouse-event", {}, mouseDown);

    await vi.waitFor(() =>
      expect(
        h.app.debugger.commands.some(
          (command) =>
            command.method === "Emulation.setFocusEmulationEnabled" &&
            command.params.enabled === false,
        ),
      ).toBe(true),
    );
    expect(h.detach).not.toHaveBeenCalled();
  });

  it("redirects a key to the owner while an agent tab remains parked", async () => {
    const h = harness({ focused: false });
    await h.focus.dispatchInput(h.entry, h.session, TARGET, press);

    expect(h.focus.redirectStrayKey(h.entry, keyDown)).toBe(true);
    expect(
      h.app.debugger.commands.some(
        (command) =>
          command.method === "Input.dispatchKeyEvent" &&
          command.params.type === "keyDown" &&
          command.params.text === "x",
      ),
    ).toBe(true);
  });

  it("enables emulation for a new owner tile after its lease is ready", async () => {
    const h = harness({});
    let finish!: (value: unknown) => void;
    vi.mocked(h.dispatchAround).mockImplementation(
      async (_target, command, around) =>
        dispatchAroundResult(
          command,
          around,
          () =>
            new Promise<unknown>((resolve) => {
              finish = resolve;
            }),
        ),
    );
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, key);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    h.focus.handleGuestMouse(h.other, mouseDown);

    await vi.waitFor(() =>
      expect(
        h.other.webContents.debugger.commands.some(
          (command) =>
            command.method === "Emulation.setFocusEmulationEnabled" &&
            command.params.enabled === true,
        ),
      ).toBe(true),
    );
    finish(result);
    await pending;
  });

  it("keeps emulation enabled when an owner tile becomes an agent tab", async () => {
    const h = harness({});
    let finish!: (value: unknown) => void;
    vi.mocked(h.dispatchAround).mockImplementation(
      async (_target, command, around) =>
        dispatchAroundResult(
          command,
          around,
          () =>
            new Promise<unknown>((resolve) => {
              finish = resolve;
            }),
        ),
    );
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, key);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    h.focus.handleGuestMouse(h.other, mouseDown);
    await vi.waitFor(() =>
      expect(
        h.other.webContents.debugger.commands.some(
          (command) =>
            command.method === "Emulation.setFocusEmulationEnabled" &&
            command.params.enabled === true,
        ),
      ).toBe(true),
    );
    h.other.agentCdpLease = {
      release: vi.fn(),
      ready: async () => undefined,
    } satisfies BrowserDebugLease;
    h.app.emit("before-mouse-event", {}, mouseDown);
    setFocused(h.entry.webContents, false);
    finish(result);
    await pending;

    expect(
      h.other.webContents.debugger.commands.some(
        (command) =>
          command.method === "Emulation.setFocusEmulationEnabled" &&
          command.params.enabled === false,
      ),
    ).toBe(false);
  });

  it("does not detach a host debugger another consumer reattached", async () => {
    const h = harness({});
    let finish!: (value: unknown) => void;
    vi.mocked(h.dispatchAround).mockImplementation(
      async (_target, command, around) =>
        dispatchAroundResult(
          command,
          around,
          () =>
            new Promise<unknown>((resolve) => {
              setFocused(h.entry.webContents, true);
              finish = resolve;
            }),
        ),
    );
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, key);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await vi.waitFor(() =>
      expect(
        h.app.debugger.commands.filter(
          (command) =>
            command.method === "Input.dispatchMouseEvent" &&
            command.params.button === "none",
        ),
      ).toHaveLength(2),
    );
    expect(h.attach).toHaveBeenCalledTimes(1);
    h.app.debugger.emitDetach("target closed");
    h.app.debugger.attached = true;
    finish(result);
    await pending;

    expect(h.detach).not.toHaveBeenCalled();
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
      for (const guest of [h.entry, h.owner, h.other])
        setFocused(guest.webContents, false);
      return new Promise<unknown>((resolve) => {
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
    vi.mocked(guarded.dispatchAround).mockImplementation(
      async (_target, _command, around) => {
        return dispatchAroundResult(
          _command,
          around,
          () =>
            new Promise<unknown>((resolve) => {
              finish = resolve;
            }),
        );
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
    vi.mocked(h.dispatchAround).mockImplementation(
      async (_target, command, around) => {
        return dispatchAroundResult(command, around, async () => {
          h.window.destroyed = true;
          vi.spyOn(h.window, "isFocused").mockImplementation(() => {
            throw new Error("Object has been destroyed");
          });
          setFocused(h.entry.webContents, true);
          return result;
        });
      },
    );

    await expect(
      h.focus.dispatchInput(h.entry, h.session, TARGET, press),
    ).resolves.toEqual(result);
  });

  it("falls back to plain dispatch when an unguarded window cannot attach", async () => {
    const h = harness({ failAttach: true, guardStarted: false });
    await expect(
      h.focus.dispatchInput(h.entry, h.session, TARGET, key),
    ).resolves.toEqual(result);
    expect(h.dispatch).toHaveBeenCalledWith(TARGET, key);
  });

  it("does not dispatch guarded input when the host debugger cannot attach", async () => {
    const h = harness({ failAttach: true });
    await expect(
      h.focus.dispatchInput(h.entry, h.session, TARGET, key),
    ).resolves.toEqual(abandonedKeyResult);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.rawSend).not.toHaveBeenCalled();
  });

  it("abandons a guarded input when its begin signal cannot be sent", async () => {
    const h = harness({ beginSignalSends: false });
    await expect(
      h.focus.dispatchInput(h.entry, h.session, TARGET, key),
    ).resolves.toEqual(abandonedKeyResult);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.rawSend).not.toHaveBeenCalled();
    expect(h.events.some((event) => event.kind === "end")).toBe(true);
  });

  it("reclaims an agent key before the app hand-back press when Chromium reads no focus", async () => {
    const h = harness({ noFocusedFrame: true, focusedNodeGone: true });
    const appPressAnswers: Array<() => void> = [];
    vi.mocked(h.hostSendCommand).mockImplementation(
      async (method, params, sessionId) => {
        h.app.debugger.commands.push({ method, params, sessionId });
        if (method === "Input.dispatchMouseEvent") {
          setFocused(h.app, true);
          return new Promise<unknown>((resolve) => {
            appPressAnswers.push(() => resolve({}));
          });
        }
        return {};
      },
    );

    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, key);
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "reclaim")).toBe(true),
    );
    const reclaim = h.events.find((event) => event.kind === "reclaim");
    if (reclaim?.kind !== "reclaim") throw new Error("missing reclaim");
    expect(
      h.app.debugger.commands.some(
        (command) => command.method === "Input.dispatchMouseEvent",
      ),
    ).toBe(false);

    h.acknowledge({ kind: "reclaimed", reclaimId: reclaim.reclaimId });
    await vi.waitFor(() => expect(appPressAnswers).toHaveLength(2));
    expect(h.events.some((event) => event.kind === "end")).toBe(false);
    appPressAnswers.forEach((answer) => answer());
    await expect(pending).resolves.toEqual(result);
    expect(h.events.some((event) => event.kind === "end")).toBe(true);
  });

  it("ends a no-focus agent press after the reclaim chain without its answer", async () => {
    const h = harness({ noFocusedFrame: true, focusedNodeGone: true });
    let finishPress!: (value: BrowserCdpResult) => void;
    vi.mocked(h.rawSend).mockImplementation(
      () =>
        new Promise<BrowserCdpResult>((resolve) => {
          finishPress = resolve;
        }),
    );
    const appPressAnswers: Array<() => void> = [];
    vi.mocked(h.hostSendCommand).mockImplementation(
      async (method, params, sessionId) => {
        h.app.debugger.commands.push({ method, params, sessionId });
        if (method === "Input.dispatchMouseEvent") {
          setFocused(h.app, true);
          return new Promise<unknown>((resolve) => {
            appPressAnswers.push(() => resolve({}));
          });
        }
        return {};
      },
    );

    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "reclaim")).toBe(true),
    );
    const reclaim = h.events.find((event) => event.kind === "reclaim");
    if (reclaim?.kind !== "reclaim") throw new Error("missing reclaim");
    h.acknowledge({ kind: "reclaimed", reclaimId: reclaim.reclaimId });
    await vi.waitFor(() => expect(appPressAnswers).toHaveLength(2));
    appPressAnswers.forEach((answer) => answer());
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "end")).toBe(true),
    );
    finishPress(result);
    await expect(pending).resolves.toEqual(result);
  });

  it("hands back an unsettled press when tile focus is reported with no frame focused", async () => {
    const h = harness({ focusedNodeGone: true });
    let finishPress!: (value: BrowserCdpResult) => void;
    vi.mocked(h.rawSend).mockImplementation(
      () =>
        new Promise<BrowserCdpResult>((resolve) => {
          finishPress = resolve;
        }),
    );
    const appPressAnswers: Array<() => void> = [];
    vi.mocked(h.hostSendCommand).mockImplementation(
      async (method, params, sessionId) => {
        h.app.debugger.commands.push({ method, params, sessionId });
        if (method === "Input.dispatchMouseEvent") {
          setFocused(h.app, true);
          return new Promise<unknown>((resolve) => {
            appPressAnswers.push(() => resolve({}));
          });
        }
        return {};
      },
    );

    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    await vi.waitFor(() => expect(finishPress).toBeTypeOf("function"));
    setNoFocusedFrame(h.window);
    h.focus.report(WINDOW_ID, {
      kind: "tileTookFocus",
      registrationId: "agent",
    });
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "reclaim")).toBe(true),
    );
    const reclaim = h.events.find((event) => event.kind === "reclaim");
    if (reclaim?.kind !== "reclaim") throw new Error("missing reclaim");
    h.acknowledge({ kind: "reclaimed", reclaimId: reclaim.reclaimId });
    await vi.waitFor(() => expect(appPressAnswers).toHaveLength(2));
    appPressAnswers.forEach((answer) => answer());
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "end")).toBe(true),
    );
    finishPress(result);
    await expect(pending).resolves.toEqual(result);
  });

  it("reclaims to a tile owner when no frame is focused", async () => {
    const h = harness({});
    h.focus.handleGuestMouse(h.other, mouseDown);
    setFocused(h.other.webContents, true);
    setFocused(h.entry.webContents, false);
    await h.focus.dispatchInput(h.entry, h.session, TARGET, press);
    const previousTilePressCount = h.other.webContents.debugger.commands.filter(
      (command) => command.method === "Input.dispatchMouseEvent",
    ).length;
    setFocused(h.other.webContents, false);
    setFocused(h.entry.webContents, false);
    setNoFocusedFrame(h.window);
    const previousEndCount = h.events.filter(
      (event) => event.kind === "end",
    ).length;
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, key);
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "reclaim")).toBe(true),
    );
    const reclaim = h.events.find((event) => event.kind === "reclaim");
    if (reclaim?.kind !== "reclaim") throw new Error("missing reclaim");

    const tileAnswers: Array<() => void> = [];
    vi.mocked(h.other.webContents.debugger.sendCommand).mockImplementation(
      async (method, params, sessionId) => {
        h.other.webContents.debugger.commands.push({
          method,
          params,
          sessionId,
        });
        if (method === "Input.dispatchMouseEvent") {
          return new Promise<unknown>((resolve) => {
            tileAnswers.push(() => resolve({}));
          });
        }
        return {};
      },
    );
    const appReleaseAnswers: Array<() => void> = [];
    vi.mocked(h.hostSendCommand).mockImplementation(
      async (method, params, sessionId) => {
        h.app.debugger.commands.push({ method, params, sessionId });
        if (
          method === "Input.dispatchMouseEvent" &&
          params.type === "mouseReleased"
        ) {
          return new Promise<unknown>((resolve) => {
            appReleaseAnswers.push(() => resolve({}));
          });
        }
        return {};
      },
    );

    h.acknowledge({ kind: "reclaimed", reclaimId: reclaim.reclaimId });
    await vi.waitFor(() => expect(tileAnswers).toHaveLength(2));
    await vi.waitFor(() => expect(appReleaseAnswers).toHaveLength(1));
    expect(h.events.filter((event) => event.kind === "end")).toHaveLength(
      previousEndCount,
    );
    const answerAppRelease = appReleaseAnswers[0];
    if (answerAppRelease === undefined) {
      throw new Error("missing app release answer");
    }
    answerAppRelease();
    await vi.waitFor(() =>
      expect(h.events.filter((event) => event.kind === "end")).toHaveLength(
        previousEndCount + 1,
      ),
    );
    expect(tileAnswers).toHaveLength(2);
    tileAnswers.forEach((answer) => answer());
    await expect(pending).resolves.toEqual(result);
    expect(
      h.other.webContents.debugger.commands
        .filter((command) => command.method === "Input.dispatchMouseEvent")
        .slice(previousTilePressCount)
        .map((command) => command.params.type),
    ).toEqual(["mousePressed", "mouseReleased"]);
    expect(
      h.app.debugger.commands
        .filter((command) => command.method === "Input.dispatchMouseEvent")
        .map((command) => command.params.type),
    ).toEqual(["mouseReleased"]);
  });

  it("uses an app press without reclaim when the page has no guard", async () => {
    const h = harness({
      guardStarted: false,
      noFocusedFrame: true,
      focusedNodeGone: true,
    });
    await h.focus.dispatchInput(h.entry, h.session, TARGET, press);

    expect(h.events.some((event) => event.kind === "reclaim")).toBe(false);
    expect(
      h.app.debugger.commands
        .filter((command) => command.method === "Input.dispatchMouseEvent")
        .map((command) => command.params.type),
    ).toEqual(["mousePressed", "mouseReleased"]);
  });

  it("ends a pending reclaim when the app page is replaced", async () => {
    const h = harness({ noFocusedFrame: true, focusedNodeGone: true });
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, key);
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "reclaim")).toBe(true),
    );
    h.app.emit("did-navigate");
    await expect(pending).resolves.toEqual(result);
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "end")).toBe(true),
    );
    await vi.waitFor(() =>
      expect(
        h.app.debugger.commands.filter(
          (command) =>
            command.method === "Input.dispatchMouseEvent" &&
            command.params.button === "none",
        ),
      ).toHaveLength(2),
    );
    expect(
      h.app.debugger.commands
        .filter(
          (command) =>
            command.method === "Input.dispatchMouseEvent" &&
            command.params.button === "none",
        )
        .map((command) => command.params.type),
    ).toEqual(["mousePressed", "mouseReleased"]);
  });

  it("sends the reclaim's owner press to the tile that was pressed while it waited", async () => {
    const h = harness({ noFocusedFrame: true, focusedNodeGone: true });
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, key);
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "reclaim")).toBe(true),
    );
    setFocused(h.other.webContents, true);
    h.focus.handleGuestMouse(h.other, mouseDown);
    await vi.waitFor(() =>
      expect(h.other.webContents.debugger.isAttached()).toBe(true),
    );
    const reclaim = h.events.find((event) => event.kind === "reclaim");
    if (reclaim?.kind !== "reclaim") throw new Error("missing reclaim");

    h.acknowledge({ kind: "reclaimed", reclaimId: reclaim.reclaimId });
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
    expect(
      h.app.debugger.commands
        .filter(
          (command) =>
            command.method === "Input.dispatchMouseEvent" &&
            command.params.button === "none",
        )
        .map((command) => command.params.type),
    ).toEqual(["mouseReleased"]);
  });

  it("answers a pending reclaim when the guard stops", async () => {
    const h = harness({ noFocusedFrame: true, focusedNodeGone: true });
    const pending = h.focus.dispatchInput(h.entry, h.session, TARGET, key);
    await vi.waitFor(() =>
      expect(h.events.some((event) => event.kind === "reclaim")).toBe(true),
    );

    h.acknowledge({ kind: "guardStopped" });

    await expect(pending).resolves.toEqual(result);
    expect(h.events.some((event) => event.kind === "end")).toBe(true);
    expect(
      h.app.debugger.commands
        .filter(
          (command) =>
            command.method === "Input.dispatchMouseEvent" &&
            command.params.button === "none",
        )
        .map((command) => command.params.type),
    ).toEqual(["mousePressed", "mouseReleased"]);
  });
});
