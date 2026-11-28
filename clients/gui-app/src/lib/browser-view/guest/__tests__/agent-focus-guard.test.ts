import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserViewAgentFocusSignal } from "@traycer-clients/shared/platform/browser-view";
import { FakeBrowserViewBridge } from "../../__tests__/fake-browser-view-bridge";
import { startAgentFocusGuard } from "../agent-focus-guard";

const registrationId = "r1";
const beginSignal = (bracketId: string): BrowserViewAgentFocusSignal => ({
  kind: "begin",
  bracketId,
  registrationId,
  agentRegistrationIds: [registrationId],
});

function focusMethod(): typeof HTMLElement.prototype.focus {
  return Reflect.get(HTMLElement.prototype, "focus");
}

interface TrustedFocusEvent {
  readonly event: Event;
  stopCalls(): number;
}

interface ObservedFocusEvent {
  readonly target: EventTarget | null;
  readonly type: string;
  readonly trusted: boolean;
}

function trustedFocusEvent(
  type: string,
  target: EventTarget,
): TrustedFocusEvent {
  let stopCalls = 0;
  const event = new Proxy(new Event(type), {
    get: (nativeEvent, property) => {
      if (property === "isTrusted") return true;
      if (property === "target") return target;
      if (property === "stopImmediatePropagation") {
        return () => {
          stopCalls += 1;
        };
      }
      const value: unknown = Reflect.get(nativeEvent, property);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown =>
        Reflect.apply(value, nativeEvent, args);
    },
  });
  return { event, stopCalls: () => stopCalls };
}

function passToAppWhenNotStopped(
  guardHandler: EventListener,
  event: TrustedFocusEvent,
  appListener: EventListener,
): void {
  guardHandler(event.event);
  if (event.stopCalls() === 0) appListener(event.event);
}

describe("startAgentFocusGuard", () => {
  let dispose: (() => void) | null = null;
  let activeElementDescriptor: PropertyDescriptor | undefined;
  let activeElementWasOverridden = false;
  afterEach(() => {
    dispose?.();
    dispose = null;
    if (activeElementWasOverridden) {
      if (activeElementDescriptor === undefined) {
        Reflect.deleteProperty(document, "activeElement");
      } else {
        Object.defineProperty(
          document,
          "activeElement",
          activeElementDescriptor,
        );
      }
    }
    activeElementDescriptor = undefined;
    activeElementWasOverridden = false;
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  function setActiveElement(element: Element | null): void {
    if (!activeElementWasOverridden) {
      activeElementDescriptor = Object.getOwnPropertyDescriptor(
        document,
        "activeElement",
      );
      activeElementWasOverridden = true;
    }
    Object.defineProperty(document, "activeElement", {
      configurable: true,
      value: element,
    });
  }

  function setup() {
    const input = document.createElement("input");
    const tile = document.createElement("div");
    tile.dataset.browserGuestRegistration = registrationId;
    const webview = document.createElement("webview");
    webview.tabIndex = 0;
    tile.append(webview);
    document.body.append(input, tile);
    input.focus();
    const originalFocus = focusMethod();
    const bridge = new FakeBrowserViewBridge(undefined);
    dispose = startAgentFocusGuard(bridge);
    expect(bridge.agentFocusReports[0]).toEqual({ kind: "guardStarted" });
    return { input, tile, webview, originalFocus, bridge };
  }

  function setupWithGuardHandlers() {
    const guardHandlers = new Map<string, EventListener>();
    const addEventListener = window.addEventListener;
    const addEventListenerSpy = vi
      .spyOn(window, "addEventListener")
      .mockImplementation((type, listener, options) => {
        if (
          options === true &&
          typeof listener === "function" &&
          (type === "blur" ||
            type === "focus" ||
            type === "focusin" ||
            type === "focusout")
        ) {
          guardHandlers.set(type, listener);
        }
        Reflect.apply(addEventListener, window, [type, listener, options]);
      });
    const fixture = setup();
    addEventListenerSpy.mockRestore();
    return { ...fixture, guardHandlers };
  }

  it("hides trusted focus events inside a bracket and restores through end → settle", async () => {
    const { input, webview, originalFocus, bridge } = setup();
    const observed: Array<{ type: string; trusted: boolean }> = [];
    for (const type of ["blur", "focus", "focusin", "focusout"] as const) {
      window.addEventListener(type, (event) =>
        observed.push({ type, trusted: event.isTrusted }),
      );
    }
    bridge.emitAgentFocusSignal(beginSignal("b1"));
    await vi.waitFor(() =>
      expect(bridge.agentFocusReports).toEqual([
        { kind: "guardStarted" },
        { kind: "bracketOpened", bracketId: "b1" },
      ]),
    );
    Reflect.apply(originalFocus, webview, []);
    expect(observed.filter((event) => event.trusted)).toEqual([]);
    bridge.emitAgentFocusSignal({
      kind: "end",
      bracketId: "b1",
    });
    expect(document.activeElement).toBe(input);
    expect(observed.filter((event) => !event.trusted)).toEqual([]);
  });

  // jsdom does not model Chromium's remote-frame focus changes or window blur.

  it("reports a held begin before opening it after compositionend", async () => {
    const { bridge } = setup();
    document.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    bridge.emitAgentFocusSignal(beginSignal("b3"));
    expect(bridge.agentFocusReports).toEqual([
      { kind: "guardStarted" },
      { kind: "bracketHeld", bracketId: "b3" },
    ]);
    document.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    await vi.waitFor(() =>
      expect(bridge.agentFocusReports).toEqual([
        { kind: "guardStarted" },
        { kind: "bracketHeld", bracketId: "b3" },
        { kind: "bracketOpened", bracketId: "b3" },
      ]),
    );
  });

  it("does not leave a bracket open when end arrives before a composition-held begin", async () => {
    vi.useFakeTimers();
    try {
      const { webview, originalFocus, bridge } = setup();
      document.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      bridge.emitAgentFocusSignal(beginSignal("b4"));
      bridge.emitAgentFocusSignal({
        kind: "end",
        bracketId: "b4",
      });
      expect(bridge.agentFocusReports).toEqual([
        { kind: "guardStarted" },
        { kind: "bracketHeld", bracketId: "b4" },
      ]);
      document.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      );
      await vi.runAllTimersAsync();
      expect(bridge.agentFocusReports).toEqual([
        { kind: "guardStarted" },
        { kind: "bracketHeld", bracketId: "b4" },
      ]);
      let focusReachedApp = false;
      webview.addEventListener("focus", () => {
        focusReachedApp = true;
      });
      Reflect.apply(originalFocus, webview, []);
      expect(focusReachedApp).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores HTMLElement.prototype.focus on dispose", () => {
    const { originalFocus, bridge } = setup();
    expect(focusMethod()).not.toBe(originalFocus);
    dispose?.();
    dispose = null;
    expect(focusMethod()).toBe(originalFocus);
    expect(bridge.agentFocusReports.at(-1)).toEqual({ kind: "guardStopped" });
  });

  it("reports one synthetic focus sequence after a parked restore and holds back Chromium's repeat", () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { input, webview, originalFocus, bridge, guardHandlers } =
      setupWithGuardHandlers();
    const activeElementDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "activeElement",
    );
    const listeners = new Map<string, (event: Event) => void>();
    let restoreElementFocus: (() => void) | null = null;
    try {
      const trustedFocusHandler = guardHandlers.get("focus");
      if (trustedFocusHandler === undefined) {
        throw new Error("missing guard focus listener");
      }
      // The guard reads only trusted window events, which jsdom cannot make.
      trustedFocusHandler(trustedFocusEvent("blur", window).event);
      bridge.emitAgentFocusSignal(beginSignal("b8"));
      Reflect.apply(originalFocus, webview, []);
      Object.defineProperty(document, "activeElement", {
        configurable: true,
        value: document.body,
      });
      hasFocus.mockReturnValue(false);
      bridge.emitAgentFocusSignal({ kind: "end", bracketId: "b8" });
      trustedFocusHandler(trustedFocusEvent("blur", window).event);

      const focusElement = vi.spyOn(input, "focus").mockImplementation(() => {
        // activeElement is pinned above, so the restore's move is set here.
        Object.defineProperty(document, "activeElement", {
          configurable: true,
          value: input,
        });
      });
      restoreElementFocus = () => focusElement.mockRestore();
      hasFocus.mockReturnValue(true);
      const observed: ObservedFocusEvent[] = [];
      const appListener = (event: Event): void => {
        observed.push({
          target: event.target,
          type: event.type,
          trusted: event.isTrusted,
        });
      };
      for (const type of ["focus", "focusin"] as const) {
        listeners.set(type, appListener);
        window.addEventListener(type, appListener, true);
      }
      passToAppWhenNotStopped(
        trustedFocusHandler,
        trustedFocusEvent("focus", window),
        appListener,
      );

      expect(document.activeElement).toBe(input);
      expect(
        observed.map((event) => {
          let target = "other";
          if (event.target instanceof Window) target = "window";
          else if (event.target === input) target = "input";
          return { target, type: event.type, trusted: event.trusted };
        }),
      ).toEqual([
        { target: "window", type: "focus", trusted: false },
        { target: "input", type: "focus", trusted: false },
        { target: "input", type: "focusin", trusted: false },
      ]);

      const focusInHandler = guardHandlers.get("focusin");
      if (focusInHandler === undefined) {
        throw new Error("missing guard focusin listener");
      }
      const repeatedFocus = trustedFocusEvent("focus", input);
      passToAppWhenNotStopped(trustedFocusHandler, repeatedFocus, appListener);
      const repeatedFocusIn = trustedFocusEvent("focusin", input);
      passToAppWhenNotStopped(focusInHandler, repeatedFocusIn, appListener);

      expect(repeatedFocus.stopCalls()).toBe(1);
      expect(repeatedFocusIn.stopCalls()).toBe(1);
      expect(observed).toHaveLength(3);
    } finally {
      for (const [type, listener] of listeners) {
        window.removeEventListener(type, listener, true);
      }
      restoreElementFocus?.();
      hasFocus.mockRestore();
      if (activeElementDescriptor === undefined) {
        Reflect.deleteProperty(document, "activeElement");
      } else {
        Object.defineProperty(
          document,
          "activeElement",
          activeElementDescriptor,
        );
      }
    }
  });

  it("suppresses Chromium's focus replay after an agent bracket", async () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { input, webview, bridge, guardHandlers } = setupWithGuardHandlers();
    const focusHandler = guardHandlers.get("focus");
    const focusInHandler = guardHandlers.get("focusin");
    const blurHandler = guardHandlers.get("blur");
    if (
      focusHandler === undefined ||
      focusInHandler === undefined ||
      blurHandler === undefined
    ) {
      throw new Error("missing guard focus listeners");
    }
    const focusElement = vi.spyOn(input, "focus").mockImplementation(() => {
      setActiveElement(input);
    });
    const observed: ObservedFocusEvent[] = [];
    const appListener = (event: Event): void => {
      observed.push({
        target: event.target,
        type: event.type,
        trusted: event.isTrusted,
      });
    };
    for (const type of ["focus", "focusin"] as const) {
      window.addEventListener(type, appListener, true);
    }

    try {
      bridge.emitAgentFocusSignal(beginSignal("focus-replay"));
      setActiveElement(webview);
      const windowBlur = trustedFocusEvent("blur", window);
      passToAppWhenNotStopped(blurHandler, windowBlur, appListener);
      await Promise.resolve();
      bridge.emitAgentFocusSignal({ kind: "end", bracketId: "focus-replay" });
      expect(document.activeElement).toBe(input);
      expect(observed).toEqual([]);

      const repeatedFocus = trustedFocusEvent("focus", input);
      passToAppWhenNotStopped(focusHandler, repeatedFocus, appListener);
      const repeatedFocusIn = trustedFocusEvent("focusin", input);
      passToAppWhenNotStopped(focusInHandler, repeatedFocusIn, appListener);
      const repeatedWindowFocus = trustedFocusEvent("focus", window);
      passToAppWhenNotStopped(focusHandler, repeatedWindowFocus, appListener);

      expect(repeatedFocus.stopCalls()).toBe(1);
      expect(repeatedFocusIn.stopCalls()).toBe(1);
      expect(repeatedWindowFocus.stopCalls()).toBe(1);
      expect(observed).toEqual([]);
    } finally {
      for (const type of ["focus", "focusin"] as const) {
        window.removeEventListener(type, appListener, true);
      }
      focusElement.mockRestore();
      hasFocus.mockRestore();
    }
  });

  it("lets a different element's trusted focus and focusin reach app code", () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    setup();
    const other = document.createElement("input");
    document.body.append(other);
    const observed: ObservedFocusEvent[] = [];
    const appListener = (event: Event): void => {
      if (event.target !== other) return;
      observed.push({
        target: event.target,
        type: event.type,
        trusted: event.isTrusted,
      });
    };
    window.addEventListener("focus", appListener, true);
    window.addEventListener("focusin", appListener, true);

    try {
      other.focus();

      expect(observed).toEqual([
        { target: other, type: "focus", trusted: true },
        { target: other, type: "focusin", trusted: true },
      ]);
    } finally {
      window.removeEventListener("focus", appListener, true);
      window.removeEventListener("focusin", appListener, true);
      hasFocus.mockRestore();
    }
  });

  it("lets window focus reach app code after a trusted window blur", () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { guardHandlers } = setupWithGuardHandlers();
    const blurHandler = guardHandlers.get("blur");
    const focusHandler = guardHandlers.get("focus");
    if (blurHandler === undefined || focusHandler === undefined) {
      throw new Error("missing guard window listeners");
    }
    const observed: string[] = [];
    const appListener = (event: Event): void => {
      observed.push(event.type);
    };

    const blur = trustedFocusEvent("blur", window);
    passToAppWhenNotStopped(blurHandler, blur, appListener);
    const focus = trustedFocusEvent("focus", window);
    passToAppWhenNotStopped(focusHandler, focus, appListener);

    expect(blur.stopCalls()).toBe(0);
    expect(focus.stopCalls()).toBe(0);
    expect(observed).toEqual(["blur", "focus"]);
    hasFocus.mockRestore();
  });

  it("reports the input that has focus after blur handlers run", () => {
    const { input: a, bridge } = setup();
    const b = document.createElement("input");
    const c = document.createElement("input");
    document.body.append(b, c);
    bridge.emitAgentFocusSignal(beginSignal("b5"));
    expect(bridge.agentFocusReports).toEqual([
      { kind: "guardStarted" },
      { kind: "bracketOpened", bracketId: "b5" },
    ]);

    a.addEventListener("blur", () => c.focus(), { once: true });
    const focusedInputs: HTMLInputElement[] = [];
    window.addEventListener(
      "focus",
      (event) => {
        if (event.target instanceof HTMLInputElement) {
          focusedInputs.push(event.target);
        }
      },
      true,
    );
    b.focus();
    bridge.emitAgentFocusSignal({
      kind: "end",
      bracketId: "b5",
    });

    expect(document.activeElement).toBe(c);
    expect(focusedInputs).toEqual([c]);
  });

  it("does not send focusin after a synthetic focus handler moves focus", () => {
    const { bridge } = setup();
    const b = document.createElement("input");
    const c = document.createElement("input");
    document.body.append(b, c);
    bridge.emitAgentFocusSignal(beginSignal("b6"));
    b.addEventListener("focus", () => c.focus(), { once: true });
    const focusinTargets: EventTarget[] = [];
    window.addEventListener(
      "focusin",
      (event) => {
        if (event.target === b) focusinTargets.push(event.target);
      },
      true,
    );
    b.focus();
    bridge.emitAgentFocusSignal({
      kind: "end",
      bracketId: "b6",
    });

    expect(document.activeElement).toBe(c);
    expect(focusinTargets).toEqual([]);
  });

  it("gives focusout a null relatedTarget when a blur handler moves focus", () => {
    const { input: a, bridge } = setup();
    const b = document.createElement("input");
    const c = document.createElement("input");
    document.body.append(b, c);
    bridge.emitAgentFocusSignal(beginSignal("b7"));
    let relatedTarget: EventTarget | null | undefined;
    a.addEventListener("blur", () => c.focus(), { once: true });
    a.addEventListener("focusout", (event) => {
      relatedTarget = event.relatedTarget;
    });
    b.focus();
    bridge.emitAgentFocusSignal({
      kind: "end",
      bracketId: "b7",
    });

    expect(relatedTarget).toBeNull();
  });

  it("refocuses intent before acknowledging reclaim inside a bracket", async () => {
    const { input, webview, bridge } = setup();
    bridge.emitAgentFocusSignal(beginSignal("reclaim-bracket"));
    await vi.waitFor(() =>
      expect(bridge.agentFocusReports.at(-1)).toEqual({
        kind: "bracketOpened",
        bracketId: "reclaim-bracket",
      }),
    );
    setActiveElement(webview);
    const focusElement = vi.spyOn(input, "focus").mockImplementation(() => {
      Object.defineProperty(document, "activeElement", {
        configurable: true,
        value: input,
      });
    });
    const focusAtReclaimed: Array<Element | null> = [];
    vi.spyOn(bridge, "reportAgentFocus").mockImplementation((report) => {
      if (report.kind === "reclaimed")
        focusAtReclaimed.push(document.activeElement);
      return Promise.resolve();
    });
    const observed: Event[] = [];
    const listener = (event: Event): void => {
      observed.push(event);
    };
    window.addEventListener("focus", listener, true);
    window.addEventListener("focusin", listener, true);

    bridge.emitAgentFocusSignal({ kind: "reclaim", reclaimId: "r1" });

    expect(focusAtReclaimed).toEqual([input]);
    expect(observed).toEqual([]);
    window.removeEventListener("focus", listener, true);
    window.removeEventListener("focusin", listener, true);
    focusElement.mockRestore();
  });

  it("blurs the registered tile when reclaim has no intent element", async () => {
    const { webview, bridge } = setup();
    dispose?.();
    setActiveElement(null);
    dispose = startAgentFocusGuard(bridge);
    bridge.emitAgentFocusSignal(beginSignal("no-intent"));
    await vi.waitFor(() =>
      expect(bridge.agentFocusReports.at(-1)).toEqual({
        kind: "bracketOpened",
        bracketId: "no-intent",
      }),
    );
    bridge.emitAgentFocusSignal({ kind: "end", bracketId: "no-intent" });
    setActiveElement(webview);
    vi.spyOn(webview, "blur").mockImplementation(() => {
      setActiveElement(document.body);
    });

    bridge.emitAgentFocusSignal({ kind: "reclaim", reclaimId: "r2" });

    expect(document.activeElement).toBe(document.body);
    expect(bridge.agentFocusReports.at(-1)).toEqual({
      kind: "reclaimed",
      reclaimId: "r2",
    });
  });

  it("reports the net focus change once for a reclaim outside a bracket", () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { input, webview, bridge } = setup();
    bridge.emitAgentFocusSignal(beginSignal("outside-reclaim"));
    bridge.emitAgentFocusSignal({
      kind: "end",
      bracketId: "outside-reclaim",
    });
    const focusElement = vi.spyOn(input, "focus").mockImplementation(() => {
      setActiveElement(input);
    });
    setActiveElement(webview);
    hasFocus.mockReturnValue(true);
    const observed: Array<{ target: string; type: string }> = [];
    const listener = (event: Event): void => {
      let target = "other";
      if (event.target instanceof Window) target = "window";
      else if (event.target === input) target = "input";
      observed.push({ target, type: event.type });
    };
    window.addEventListener("focus", listener, true);
    window.addEventListener("focusin", listener, true);

    bridge.emitAgentFocusSignal({ kind: "reclaim", reclaimId: "r3" });

    expect(document.activeElement).toBe(input);
    expect(observed).toEqual([
      { target: "window", type: "focus" },
      { target: "input", type: "focus" },
      { target: "input", type: "focusin" },
    ]);
    window.removeEventListener("focus", listener, true);
    window.removeEventListener("focusin", listener, true);
    focusElement.mockRestore();
    hasFocus.mockRestore();
  });

  it("blurs and refocuses an already active intent before acknowledging reclaim", () => {
    const { input, bridge } = setup();
    const focus = input.focus.bind(input);
    const blur = input.blur.bind(input);
    const order: string[] = [];
    const focusSpy = vi.spyOn(input, "focus").mockImplementation(() => {
      order.push("focus");
      focus();
    });
    const blurSpy = vi.spyOn(input, "blur").mockImplementation(() => {
      order.push("blur");
      blur();
    });
    const observed: Array<{ type: string; trusted: boolean }> = [];
    const appListener = (event: Event): void => {
      observed.push({ type: event.type, trusted: event.isTrusted });
    };
    for (const type of ["blur", "focus", "focusin", "focusout"] as const) {
      window.addEventListener(type, appListener, true);
    }
    const reportAgentFocus = vi
      .spyOn(bridge, "reportAgentFocus")
      .mockImplementation((report) => {
        if (report.kind === "reclaimed") order.push("reclaimed");
        return Promise.resolve();
      });

    try {
      bridge.emitAgentFocusSignal({ kind: "reclaim", reclaimId: "r6" });

      expect(document.activeElement).toBe(input);
      expect(order).toEqual(["blur", "focus", "reclaimed"]);
      expect(observed).toEqual([]);
    } finally {
      for (const type of ["blur", "focus", "focusin", "focusout"] as const) {
        window.removeEventListener(type, appListener, true);
      }
      reportAgentFocus.mockRestore();
      focusSpy.mockRestore();
      blurSpy.mockRestore();
    }
  });

  it("blurs the agent tile when intent cannot take focus during reclaim", async () => {
    const { input, webview, bridge } = setup();
    bridge.emitAgentFocusSignal(beginSignal("reclaim-refocus-fails"));
    await vi.waitFor(() =>
      expect(bridge.agentFocusReports.at(-1)).toEqual({
        kind: "bracketOpened",
        bracketId: "reclaim-refocus-fails",
      }),
    );
    setActiveElement(webview);
    vi.spyOn(input, "focus").mockImplementation(() => {
      setActiveElement(webview);
    });
    vi.spyOn(webview, "blur").mockImplementation(() => {
      setActiveElement(document.body);
    });
    const activeAtReclaimed: Array<Element | null> = [];
    vi.spyOn(bridge, "reportAgentFocus").mockImplementation((report) => {
      if (report.kind === "reclaimed") {
        activeAtReclaimed.push(document.activeElement);
      }
      return Promise.resolve();
    });

    bridge.emitAgentFocusSignal({ kind: "reclaim", reclaimId: "r4" });

    expect(activeAtReclaimed).toEqual([document.body]);
  });

  it("leaves a non-agent tile alone when reclaim has no intent", async () => {
    const { webview, bridge } = setup();
    dispose?.();
    setActiveElement(null);
    dispose = startAgentFocusGuard(bridge);
    bridge.emitAgentFocusSignal({
      kind: "begin",
      bracketId: "non-agent-tile",
      registrationId,
      agentRegistrationIds: [],
    });
    await vi.waitFor(() =>
      expect(bridge.agentFocusReports.at(-1)).toEqual({
        kind: "bracketOpened",
        bracketId: "non-agent-tile",
      }),
    );
    setActiveElement(webview);
    vi.spyOn(webview, "blur").mockImplementation(() => {
      setActiveElement(document.body);
    });
    const activeAtReclaimed: Array<Element | null> = [];
    vi.spyOn(bridge, "reportAgentFocus").mockImplementation((report) => {
      if (report.kind === "reclaimed") {
        activeAtReclaimed.push(document.activeElement);
      }
      return Promise.resolve();
    });

    bridge.emitAgentFocusSignal({ kind: "reclaim", reclaimId: "r5" });

    expect(activeAtReclaimed).toEqual([webview]);
  });
});
