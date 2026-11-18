import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserTabId,
  resetBrowserTabIdentityForTesting,
} from "@/lib/browser-tab-identity";
import { setMobileApp } from "@/lib/mobile-app";

// Hand-transcribed, like `persist/__tests__/keys.test.ts`: a changed key would
// hand every install, or every open tab, a new identity on upgrade.
const MOBILE_WINDOW_KEY = "traycer-gui-app:mobile-window";
const BROWSER_TAB_KEY = "traycer-gui-app:file-edit-recovery-tab";
const CLAIM_CHANNEL = "traycer-gui-app:file-edit-recovery-tab-claim:v1";

/** Records which claim channels were opened. No peers: no case here has one. */
class RecordingBroadcastChannel {
  static readonly opened: string[] = [];

  constructor(name: string) {
    RecordingBroadcastChannel.opened.push(name);
  }

  addEventListener(): void {}

  postMessage(): void {}

  close(): void {}
}

/** What a force-quit leaves: durable storage, and nothing else. */
function coldStart(): void {
  window.sessionStorage.clear();
  resetBrowserTabIdentityForTesting();
}

afterEach(() => {
  setMobileApp(false);
  resetBrowserTabIdentityForTesting();
  vi.unstubAllGlobals();
  RecordingBroadcastChannel.opened.length = 0;
  window.localStorage.removeItem(MOBILE_WINDOW_KEY);
  window.sessionStorage.clear();
});

describe("browserTabId in the installed app", () => {
  it("keeps one id across a cold start, stored in localStorage", () => {
    setMobileApp(true);

    const id = browserTabId();

    expect(window.localStorage.getItem(MOBILE_WINDOW_KEY)).toBe(id);
    expect(window.sessionStorage.getItem(BROWSER_TAB_KEY)).toBeNull();

    coldStart();

    expect(browserTabId()).toBe(id);
  });

  it("opens no claim channel", () => {
    vi.stubGlobal("BroadcastChannel", RecordingBroadcastChannel);
    setMobileApp(true);

    browserTabId();

    expect(RecordingBroadcastChannel.opened).toEqual([]);
  });

  it("falls back to the shared 'default' id when localStorage is denied", () => {
    vi.stubGlobal("window", {
      ...window,
      // Working, so only the installed app's own path can answer "default".
      sessionStorage: window.sessionStorage,
      localStorage: {
        getItem: () => {
          throw new Error("localStorage is disabled");
        },
      },
    });
    setMobileApp(true);

    expect(browserTabId()).toBe("default");
  });
});

describe("browserTabId in a browser tab", () => {
  it("keeps its id in sessionStorage and claims it over the channel", () => {
    vi.stubGlobal("BroadcastChannel", RecordingBroadcastChannel);

    const id = browserTabId();

    expect(window.sessionStorage.getItem(BROWSER_TAB_KEY)).toBe(id);
    expect(window.localStorage.getItem(MOBILE_WINDOW_KEY)).toBeNull();
    expect(RecordingBroadcastChannel.opened).toEqual([CLAIM_CHANNEL]);
  });

  it("gets a new id when sessionStorage is gone", () => {
    const id = browserTabId();

    coldStart();

    expect(browserTabId()).not.toBe(id);
  });
});
