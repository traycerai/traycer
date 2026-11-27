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
    expect(bridge.agentFocusReadyCalls[0]).toEqual({ kind: "guardStarted" });
    return { input, tile, webview, originalFocus, bridge };
  }

  it("checks whether jsdom's element.focus events are trusted", () => {
    const element = document.createElement("input");
    document.body.append(element);
    let trusted: boolean | undefined;
    element.addEventListener("focus", (event) => {
      trusted = event.isTrusted;
    });
    element.focus();
    expect(trusted).toBe(true);
  });

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
      expect(bridge.agentFocusReadyCalls).toEqual([
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

  it("waits to acknowledge begin until compositionend", async () => {
    const { bridge } = setup();
    document.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    bridge.emitAgentFocusSignal(beginSignal("b3"));
    await Promise.resolve();
    expect(bridge.agentFocusReadyCalls).toEqual([{ kind: "guardStarted" }]);
    document.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    await vi.waitFor(() =>
      expect(bridge.agentFocusReadyCalls).toEqual([
        { kind: "guardStarted" },
        { kind: "bracketOpened", bracketId: "b3" },
      ]),
    );
  });

  it("does not leave a bracket open when end arrives before a composition-held begin", async () => {
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
    document.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    await vi.waitFor(() =>
      expect(bridge.agentFocusReadyCalls).toEqual([
        { kind: "guardStarted" },
        { kind: "bracketOpened", bracketId: "b4" },
      ]),
    );
    let focusReachedApp = false;
    webview.addEventListener("focus", () => {
      focusReachedApp = true;
    });
    Reflect.apply(originalFocus, webview, []);
    expect(focusReachedApp).toBe(true);
  });

  it("restores HTMLElement.prototype.focus on dispose", () => {
    const { originalFocus } = setup();
    expect(focusMethod()).not.toBe(originalFocus);
    dispose?.();
    dispose = null;
    expect(focusMethod()).toBe(originalFocus);
  });
});
