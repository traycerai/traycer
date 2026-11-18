import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useLandingPanelStore } from "@/stores/home/landing-panel-store";
import {
  hasPrimaryFocusIntent,
  resetPrimaryFocusCoordinatorForTests,
} from "@/lib/focus/primary-focus-coordinator";
import { resetTerminalFocusRegistryForTests } from "@/lib/terminals/terminal-focus-registry";
import { restoreLandingSurfaceFocus } from "../landing-surface-focus-restore";

const DRAFT_ID = "draft-a";

function mountSurface(): {
  readonly surface: HTMLDivElement;
  readonly previous: HTMLButtonElement;
} {
  const surface = document.createElement("div");
  const previous = document.createElement("button");
  surface.appendChild(previous);
  document.body.appendChild(surface);
  return { surface, previous };
}

beforeEach(() => {
  useLandingPanelStore.getState().resetForTests();
  resetTerminalFocusRegistryForTests();
  resetPrimaryFocusCoordinatorForTests();
});

afterEach(() => {
  document.body.innerHTML = "";
  useLandingPanelStore.getState().resetForTests();
  resetTerminalFocusRegistryForTests();
  resetPrimaryFocusCoordinatorForTests();
});

/**
 * The surface ranks a MAXIMIZED panel's terminal above the element that last
 * held focus. A maximized panel showing a browser tab has no terminal to rank,
 * and a terminal focus request aimed at that row would park forever - so the
 * ranking has to fall through to the element instead.
 */
describe("restoreLandingSurfaceFocus", () => {
  it("restores the previous element when the maximized panel's active row is a browser tab", () => {
    const store = useLandingPanelStore.getState();
    store.addTab({
      kind: "browser",
      instanceId: "browser-instance",
      hostId: "host-a",
      sessionId: "browser-session",
      tabId: "browser-tab",
      name: "example.com",
      titleSource: "default",
    });
    store.activateTab("browser-instance");
    store.setPanelOpen(DRAFT_ID, true);
    store.setPanelMaximized(DRAFT_ID, true);
    const { surface, previous } = mountSurface();

    restoreLandingSurfaceFocus(DRAFT_ID, surface, previous);

    expect(document.activeElement).toBe(previous);
    expect(
      hasPrimaryFocusIntent(
        (target) =>
          target.kind === "terminal" &&
          target.instanceId === "browser-instance",
      ),
    ).toBe(false);
  });

  it("still hands a maximized panel's terminal row the keyboard", () => {
    const store = useLandingPanelStore.getState();
    store.addTab({
      kind: "terminal",
      instanceId: "terminal-instance",
      sessionId: "terminal-session",
      hostId: "host-a",
      cwd: "/work/repo",
      name: "shell",
      titleSource: "default",
    });
    store.activateTab("terminal-instance");
    store.setPanelOpen(DRAFT_ID, true);
    store.setPanelMaximized(DRAFT_ID, true);
    const { surface, previous } = mountSurface();

    restoreLandingSurfaceFocus(DRAFT_ID, surface, previous);

    expect(document.activeElement).not.toBe(previous);
    expect(
      hasPrimaryFocusIntent(
        (target) =>
          target.kind === "terminal" &&
          target.instanceId === "terminal-instance",
      ),
    ).toBe(true);
  });
});
