import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDesktopBackgroundRendering } from "../desktop-background-rendering";
import {
  acquireBrowserMediaEntry,
  type MediaPeer,
  type MediaPeerFactory,
} from "../webrtc-media-registry";
import type { DesktopWindowsBridge } from "@/lib/windows/types";

const GRACE_MS = 1_000;

const idleDisposable = { dispose: (): void => undefined };

/** Only `backgroundRendering` matters here; the rest is the required shell. */
function bridgeWith(
  backgroundRendering: DesktopWindowsBridge["backgroundRendering"],
): DesktopWindowsBridge {
  return {
    windowId: "window-1",
    list: () => Promise.resolve([]),
    onChange: () => idleDisposable,
    requestNew: () => Promise.resolve(),
    requestFocus: () => Promise.resolve(),
    requestClose: () => Promise.resolve(),
    requestOpenEpicInNewWindow: () =>
      Promise.resolve({ result: "moved" as const, windowId: "window-2" }),
    ownership: {
      snapshot: () => Promise.resolve([]),
      claim: () => Promise.resolve({ ok: true as const }),
      release: () => Promise.resolve(),
      onChange: () => idleDisposable,
    },
    perWindowState: {
      get: () =>
        Promise.resolve({
          epicTabs: [],
          activeTabId: null,
          canvasByTabId: {},
          landingDrafts: [],
          activeLandingDraftId: null,
        }),
      update: () => Promise.resolve(),
      onChange: () => idleDisposable,
    },
    authSession: {
      get: () =>
        Promise.resolve({
          status: "signed-out" as const,
          token: null,
          profile: null,
        }),
      set: () => Promise.resolve({ outcome: "accepted" as const }),
      onChange: () => idleDisposable,
    },
    backgroundRendering,
  };
}

const createPeer: MediaPeerFactory = () => {
  const peer: MediaPeer = {
    answerOffer: () => Promise.resolve("answer"),
    addRemoteCandidate: () => Promise.resolve(),
    getStats: () => Promise.resolve(new Map()),
    close: () => undefined,
  };
  return peer;
};

let keyCounter = 0;
function acquire(): { readonly release: () => void } {
  keyCounter += 1;
  return acquireBrowserMediaEntry({
    key: { hostId: "h1", sessionId: "s1", tabId: `bg-tab-${keyCounter}` },
    createPeer,
  });
}

describe("installDesktopBackgroundRendering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Dispose anything a test left behind so the module registry is empty.
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("does nothing when the preload has no backgroundRendering channel", () => {
    const held = acquire();
    const uninstall = installDesktopBackgroundRendering(bridgeWith(undefined));

    expect(() => uninstall()).not.toThrow();

    held.release();
    vi.runOnlyPendingTimers();
  });

  it("sends the current presence at install, forwards each edge once, and sends false on uninstall", async () => {
    const sent: boolean[] = [];
    const uninstall = installDesktopBackgroundRendering(
      bridgeWith({
        setRequired: (required) => {
          sent.push(required);
          return Promise.resolve();
        },
      }),
    );
    // Nothing held yet: the install itself tells main the window needs no
    // unseen rendering.
    expect(sent).toEqual([false]);

    const first = acquire();
    expect(sent).toEqual([false, true]);

    // A second entry is no edge, and must not resend.
    const second = acquire();
    expect(sent).toEqual([false, true]);

    first.release();
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(sent).toEqual([false, true]);

    // The last release is no edge until the grace has run out.
    second.release();
    await vi.advanceTimersByTimeAsync(GRACE_MS / 2);
    expect(sent).toEqual([false, true]);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(sent).toEqual([false, true, false]);

    // Uninstall while demanding: it hands the demand back.
    const third = acquire();
    expect(sent).toEqual([false, true, false, true]);
    uninstall();
    expect(sent).toEqual([false, true, false, true, false]);

    // And it stopped listening: a later edge sends nothing.
    third.release();
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(sent).toEqual([false, true, false, true, false]);
  });

  it("sends nothing when the same entry is re-acquired inside the release grace", async () => {
    const sent: boolean[] = [];
    const uninstall = installDesktopBackgroundRendering(
      bridgeWith({
        setRequired: (required) => {
          sent.push(required);
          return Promise.resolve();
        },
      }),
    );
    keyCounter += 1;
    const key = {
      hostId: "h1",
      sessionId: "s1",
      tabId: `bg-tab-${keyCounter}`,
    };
    const before = acquireBrowserMediaEntry({ key, createPeer });
    expect(sent).toEqual([false, true]);

    before.release();
    await vi.advanceTimersByTimeAsync(GRACE_MS / 2);
    const after = acquireBrowserMediaEntry({ key, createPeer });
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    // The remount kept the entry alive: no false, and no second true.
    expect(sent).toEqual([false, true]);

    after.release();
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(sent).toEqual([false, true, false]);

    uninstall();
  });

  it("sends true at install when a media entry is already held", async () => {
    const held = acquire();
    const sent: boolean[] = [];
    const uninstall = installDesktopBackgroundRendering(
      bridgeWith({
        setRequired: (required) => {
          sent.push(required);
          return Promise.resolve();
        },
      }),
    );
    expect(sent).toEqual([true]);

    uninstall();
    held.release();
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
  });

  it("survives a rejected setRequired and keeps forwarding later edges", async () => {
    const sent: boolean[] = [];
    const uninstall = installDesktopBackgroundRendering(
      bridgeWith({
        setRequired: (required) => {
          sent.push(required);
          return Promise.reject(new Error("ipc down"));
        },
      }),
    );
    const held = acquire();
    // Let the rejection settle: an uncaught one would fail the run.
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([false, true]);

    held.release();
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(sent).toEqual([false, true, false]);

    uninstall();
  });

  it("resends an answer main never applied: a rejected setRequired does not deduplicate the next identical send", async () => {
    const sent: boolean[] = [];
    let reject = true;
    const uninstall = installDesktopBackgroundRendering(
      bridgeWith({
        setRequired: (required) => {
          sent.push(required);
          if (!reject) return Promise.resolve();
          reject = false;
          return Promise.reject(new Error("ipc down"));
        },
      }),
    );
    // The install's `false` was rejected, so main never applied it.
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([false]);

    // The next `false` (uninstall) is the same value, but it must go out.
    uninstall();
    expect(sent).toEqual([false, false]);
  });
});
