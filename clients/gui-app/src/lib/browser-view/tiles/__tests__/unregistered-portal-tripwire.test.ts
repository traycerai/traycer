import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBrowserOverlay as registerBrowserOverlayDirect } from "@/lib/browser-view/tiles/browser-overlay-coordinator";
import { appLogger } from "@/lib/logger";
import { installUnregisteredPortalTripwire } from "@/lib/browser-view/tiles/unregistered-portal-tripwire";

// Registry map hygiene, same idiom as browser-overlay-coordinator.test.ts:
// the registry is module-level state, so every registration made in a test
// must be deregistered here rather than left to leak into the next one.
let pendingDeregisters: Array<() => void> = [];
function registerBrowserOverlay(
  input: Parameters<typeof registerBrowserOverlayDirect>[0],
): () => void {
  const deregister = registerBrowserOverlayDirect(input);
  pendingDeregisters.push(deregister);
  return deregister;
}

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  pendingDeregisters.forEach((deregister) => deregister());
  pendingDeregisters = [];
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const FULL_RECT = {
  left: 0,
  top: 0,
  right: 100,
  bottom: 100,
  width: 100,
  height: 100,
};
const ZERO_RECT = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };

function stubRect(element: HTMLElement, rect: typeof FULL_RECT): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ ...rect, x: rect.left, y: rect.top, toJSON: () => ({}) }),
  });
}

/** MutationObserver callbacks fire as a microtask - flush before asserting. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

describe("installUnregisteredPortalTripwire", () => {
  it("reports a positive-area portal child with no registry entry, once", async () => {
    const appRoot = document.createElement("div");
    appRoot.id = "root";
    document.body.append(appRoot);
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    dispose = installUnregisteredPortalTripwire(appRoot);

    const portal = document.createElement("div");
    portal.setAttribute("data-slot", "mystery-portal");
    portal.className = "hand-rolled";
    stubRect(portal, FULL_RECT);
    document.body.append(portal);
    await flushMicrotasks();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "unregistered portal painted outside the browser-overlay registry",
      { tag: "div", dataSlot: "mystery-portal", classList: "hand-rolled" },
    );

    // A second mutation touching the same still-unregistered element (e.g. a
    // re-render nudging an attribute) must not spam - dedupe is per element.
    portal.setAttribute("data-extra", "1");
    document.body.append(document.createElement("span"));
    document.body.lastElementChild?.remove();
    await flushMicrotasks();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("does not report a registered portal child", async () => {
    const appRoot = document.createElement("div");
    appRoot.id = "root";
    document.body.append(appRoot);
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    dispose = installUnregisteredPortalTripwire(appRoot);

    const portal = document.createElement("div");
    stubRect(portal, FULL_RECT);
    document.body.append(portal);
    registerBrowserOverlay({ element: portal });
    await flushMicrotasks();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not report a zero-area portal child", async () => {
    const appRoot = document.createElement("div");
    appRoot.id = "root";
    document.body.append(appRoot);
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    dispose = installUnregisteredPortalTripwire(appRoot);

    const portal = document.createElement("div");
    stubRect(portal, ZERO_RECT);
    document.body.append(portal);
    await flushMicrotasks();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("reports an element that mounts zero-area then grows", async () => {
    const appRoot = document.createElement("div");
    appRoot.id = "root";
    document.body.append(appRoot);
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    dispose = installUnregisteredPortalTripwire(appRoot);

    const portal = document.createElement("div");
    portal.setAttribute("data-slot", "growing-portal");
    stubRect(portal, ZERO_RECT);
    document.body.append(portal);
    await flushMicrotasks();
    expect(warnSpy).not.toHaveBeenCalled();

    // The element grows in place (no mutation on `portal` itself), but a
    // separate body childList mutation gives the observer a chance to
    // re-scan `document.body.children` and catch the now-positive rect.
    stubRect(portal, FULL_RECT);
    document.body.append(document.createElement("span"));
    await flushMicrotasks();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "unregistered portal painted outside the browser-overlay registry",
      { tag: "div", dataSlot: "growing-portal", classList: "" },
    );
  });

  it("never reports the app root itself", async () => {
    const appRoot = document.createElement("div");
    appRoot.id = "root";
    stubRect(appRoot, FULL_RECT);
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    dispose = installUnregisteredPortalTripwire(appRoot);

    document.body.append(appRoot);
    await flushMicrotasks();

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
