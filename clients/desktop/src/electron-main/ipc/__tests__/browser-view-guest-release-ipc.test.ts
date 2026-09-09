import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: (_key: string): string => "/tmp/traycer-desktop-test",
    getVersion: (): string => "1.0.0",
  },
  BrowserWindow: class {
    constructor(_options: unknown) {}
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showMessageBox: vi.fn(async () => ({ response: 0 })),
  },
  session: {
    fromPartition: (): unknown => ({
      on: (): void => undefined,
    }),
  },
  safeStorage: {
    isEncryptionAvailable: (): boolean => false,
    getSelectedStorageBackend: (): string => "unknown",
  },
}));

vi.mock("../../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
  describeLogError: (err: unknown) => String(err),
}));

vi.mock("../../app/cert-trust", () => ({
  trustBrowserCertificate: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../browser-view/browser-view-manager", () => ({
  BrowserViewManager: class {
    dispose(): void {}
  },
}));

vi.mock("../../browser-view/browser-session", () => ({
  createBrowserViewWebPreferences: vi.fn(),
  cancelBrowserViewDownload: vi.fn(),
  clearBrowserViewPendingCertificateError: vi.fn(),
  ensureBrowserViewSession: vi.fn(),
  ensureBrowserViewSessionForPartition: vi.fn(),
  BROWSER_VIEW_PARTITION: "persist:traycer-browser",
  BROWSER_VIEW_EPHEMERAL_PARTITION: "traycer-browser-ephemeral",
  onBrowserPrimaryProfileDelta: vi.fn(() => () => undefined),
  onBrowserViewCertificateError: vi.fn(),
  onBrowserViewDownloadChange: vi.fn(),
  readBrowserViewPendingCertificateError: vi.fn(() => null),
  registerBrowserViewWebContents: vi.fn(),
  suppressAllBrowserPrimaryProfileDeltas: vi.fn(
    (action: () => Promise<unknown>) => action(),
  ),
  partitionForProfile: vi.fn(() => "persist:traycer-browser"),
  releaseBrowserViewSession: vi.fn(() => Promise.resolve()),
  forgetBrowserPrimaryProfileAppliedKeys: vi.fn(),
  noteBrowserPrimaryProfileAppliedKeys: vi.fn(),
}));

vi.mock("../../browser-view/storage/browser-saved-logins", () => ({
  isBrowserSavedLoginsEnabled: vi.fn(() => true),
  setBrowserSavedLoginsEnabled: vi.fn(() => Promise.resolve(true)),
  wrapStoreKey: vi.fn(() => "wrapped"),
  unwrapStoreKey: vi.fn(() => "unwrapped"),
}));

vi.mock("../../browser-view/storage/browser-storage-state", () => ({
  BrowserPrimaryProfileSnapshotCoordinator: class {
    observe(): void {}
    clearableOrigins() {
      return [];
    }
    forgetOriginsUnder(): void {}
    retainSeededOrigins(): void {}
    reset(): void {}
    capture() {
      return Promise.resolve({
        status: "captured",
        storageState: { cookies: [], origins: [] },
        reason: null,
      });
    }
  },
  captureBrowserOriginLocalStorage: vi.fn(() => Promise.resolve(null)),
  captureBrowserPrimaryProfile: vi.fn(() =>
    Promise.resolve({
      status: "captured",
      storageState: { cookies: [], origins: [] },
      reason: null,
    }),
  ),
  clearBrowserSite: vi.fn(() => Promise.resolve()),
  clearBrowserSiteLocalStorage: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../browser-sessions/browser-sessions-transport", () => ({
  createBrowserSessionsHostDirectory: () => ({
    invalidate: (): void => undefined,
    reset: (): void => undefined,
    resolve: () => Promise.reject(new Error("not used in this suite")),
    endpoint: () => null,
  }),
  openBrowserSessionsTransport: vi.fn(),
}));

import {
  requestRendererGuestMount,
  requestRendererGuestRelease,
} from "../browser-view-ipc";
import { releaseAttachmentGrant } from "../../browser-view/webview-guest-birth";
import { RunnerHostEvent } from "../../../ipc-contracts/ipc-channels";

interface SentMessage {
  readonly channel: string;
  readonly payload: unknown;
}

function makeBridge(): {
  readonly bridge: never;
  readonly sent: SentMessage[];
} {
  const sent: SentMessage[] = [];
  const bridge = {
    safeSendToWindow: (
      _windowId: string,
      channel: string,
      payload: unknown,
    ) => {
      sent.push({ channel, payload });
      return true;
    },
  };
  return { bridge: bridge as never, sent };
}

describe("requestRendererGuestRelease", () => {
  it("sends the release event even when no grant exists for the id", () => {
    const { bridge, sent } = makeBridge();
    requestRendererGuestRelease(bridge, "never-minted", "window-1");
    expect(sent).toEqual([
      {
        channel: RunnerHostEvent.browserViewGuestReleaseRequested,
        payload: { registrationId: "never-minted" },
      },
    ]);
  });

  it("sends the release event and consumes a minted grant", async () => {
    const { bridge, sent } = makeBridge();
    const { registrationId } = requestRendererGuestMount(bridge, "window-1", {
      partition: "persist:traycer-browser",
      onAttached: async () => undefined,
    });

    requestRendererGuestRelease(bridge, registrationId, "window-1");

    expect(sent).toContainEqual({
      channel: RunnerHostEvent.browserViewGuestReleaseRequested,
      payload: { registrationId },
    });
    expect(releaseAttachmentGrant(registrationId)).toBeNull();
  });
});
