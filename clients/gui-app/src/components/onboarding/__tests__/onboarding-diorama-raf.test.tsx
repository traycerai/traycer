import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { OnboardingWorkspaceIllustration } from "@/components/onboarding/onboarding-workspace-illustration";
import {
  __resetDocumentVisibilitySubscribersForTests,
  __setBrowserDocumentHiddenForTests,
} from "@/lib/dom/document-visibility";

const DESKTOP_VIEWPORT_WIDTH = 1280;

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
  window.dispatchEvent(new Event("resize"));
}

function installFrameQueue(): {
  readonly scheduled: () => number;
  readonly flushOne: () => void;
} {
  const pending = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    pending.delete(id);
  });
  return {
    scheduled: () => pending.size,
    flushOne: () => {
      const first = pending.entries().next().value;
      if (first === undefined) return;
      const [id, callback] = first;
      pending.delete(id);
      callback(performance.now());
    },
  };
}

describe("onboarding diorama rAF while the window is off screen", () => {
  beforeEach(() => {
    setViewportWidth(DESKTOP_VIEWPORT_WIDTH);
    __setBrowserDocumentHiddenForTests(false);
  });

  afterEach(() => {
    cleanup();
    __setBrowserDocumentHiddenForTests(false);
    __resetDocumentVisibilitySubscribersForTests();
    vi.restoreAllMocks();
  });

  it("does not schedule another frame after the document is hidden", () => {
    // Desktop diorama and PhoneWalkthrough share useDioramaPlayback. iOS
    // WKWebView already pauses rAF when hidden; this is the Electron and
    // Android path, where rAF keeps firing.
    const frames = installFrameQueue();
    render(<OnboardingWorkspaceIllustration onPassLastScene={vi.fn()} />);
    expect(document.querySelector(".diorama-scene")).not.toBeNull();

    frames.flushOne();
    expect(frames.scheduled()).toBeGreaterThan(0);

    __setBrowserDocumentHiddenForTests(true);
    expect(frames.scheduled()).toBe(0);
    frames.flushOne();
    expect(frames.scheduled()).toBe(0);
  });
});
