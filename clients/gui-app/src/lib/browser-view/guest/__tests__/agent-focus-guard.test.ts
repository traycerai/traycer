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

describe("startAgentFocusGuard", () => {
  let dispose: (() => void) | null = null;
  afterEach(() => {
    dispose?.();
    dispose = null;
    document.body.replaceChildren();
    vi.useRealTimers();
  });

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
      registrationId,
    });
    expect(document.activeElement).toBe(input);
    expect(observed.filter((event) => !event.trusted)).toEqual([]);
  });

  // jsdom does not model remote-frame window blur, which both agent-steal
  // microtask settlement and personPress require; the real-Electron harness covers them.

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
        registrationId,
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
      registrationId,
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
      registrationId,
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
      registrationId,
    });

    expect(relatedTarget).toBeNull();
  });
});
