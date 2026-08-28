import type { BrowserStorageState } from "@traycer/protocol/host/browser/contracts";
import { RunnerHostEvent } from "../../../ipc-contracts/ipc-channels";
import type { BrowserViewElectronTabHandoffChange } from "@traycer-clients/shared/platform/browser-view";
import type { BrowserViewEntry, BrowserViewSend } from "./browser-view-entry";
import {
  nativeBrowserSessionKey,
  type BrowserViewEntryRegistry,
} from "./browser-view-entry-registry";
import type { ManagedBrowserView } from "../browser-view-port";
import type { BrowserStorageStateCaptureResult } from "../storage/browser-storage-state";

type HandoffReason = BrowserViewElectronTabHandoffChange["reason"];

interface BrowserViewHandoffOptions {
  readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  readonly send: BrowserViewSend;
  readonly captureStorageState: (
    input: { readonly origin: string },
    webContents: ManagedBrowserView["webContents"],
  ) => Promise<BrowserStorageStateCaptureResult>;
}

/**
 * Captures a native session's URL + storage state and hands it to the
 * renderer before destructive teardown, so the tab can be re-created
 * headless without losing the page it was on.
 */
export class BrowserViewHandoff {
  private readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  private readonly send: BrowserViewSend;
  private readonly captureStorageState: (
    input: { readonly origin: string },
    webContents: ManagedBrowserView["webContents"],
  ) => Promise<BrowserStorageStateCaptureResult>;

  constructor(options: BrowserViewHandoffOptions) {
    this.entries = options.entries;
    this.send = options.send;
    this.captureStorageState = options.captureStorageState;
  }

  async drainForWindow(windowId: string): Promise<void> {
    await Promise.all(
      Array.from(this.entries.guestValues())
        .filter(
          (entry) =>
            entry.status !== "dead" &&
            entry.identity.lifecycleWindowId === windowId &&
            entry.identity.lifecycle.canHandoff,
        )
        .map((entry) => this.push(entry, "gui-quit")),
    );
  }

  /**
   * Claims every still-live native tab in the same host session before the
   * first await, then captures one atomic handoff. The shared promise keeps
   * sibling close paths from destroying their guests during capture.
   */
  async push(entry: BrowserViewEntry, reason: HandoffReason): Promise<void> {
    const identity = entry.identity;
    if (!identity.lifecycle.canHandoff) return;
    const sessionKey = nativeBrowserSessionKey(identity.key);
    const siblings = Array.from(this.entries.guestValues()).filter(
      (candidate) =>
        candidate !== entry &&
        nativeBrowserSessionKey(candidate.identity.key) === sessionKey &&
        candidate.identity.lifecycle.canHandoff,
    );
    const { promise: aggregationPromise, resolve: resolveAggregation } =
      Promise.withResolvers<void>();
    if (!identity.lifecycle.beginHandoffCapture(aggregationPromise)) return;
    for (const sibling of siblings) {
      sibling.identity.lifecycle.beginHandoffCapture(aggregationPromise);
    }
    const capturedUrl = this.readUrl(entry);
    const capturedSiblings = siblings.map((sibling) => ({
      entry: sibling,
      url: this.readUrl(sibling),
    }));
    let delivered = false;
    try {
      const capturedStorageState = await this.captureState(
        entry,
        reason,
        capturedUrl,
      );
      const siblingTabs = await Promise.all(
        capturedSiblings.map(async ({ entry: sibling, url }) => {
          return {
            tabId: sibling.identity.key.tabId,
            registrationId: sibling.identity.registrationId,
            url,
            capturedStorageState: await this.captureState(
              sibling,
              sibling.status === "dead" ? "crash-no-capture" : reason,
              url,
            ),
          };
        }),
      );
      delivered = this.send(
        identity.lifecycleWindowId,
        RunnerHostEvent.browserViewElectronTabHandoff,
        {
          ...identity.key,
          registrationId: identity.registrationId,
          capturedUrl,
          capturedStorageState,
          siblingTabs,
          reason,
        },
      );
      if (!delivered) {
        throw new Error(
          "Electron tab handoff could not be delivered to its renderer window.",
        );
      }
    } finally {
      identity.lifecycle.finishHandoffCapture(aggregationPromise, delivered);
      for (const sibling of siblings) {
        sibling.identity.lifecycle.finishHandoffCapture(
          aggregationPromise,
          delivered,
        );
      }
      resolveAggregation();
    }
  }

  private async captureState(
    entry: BrowserViewEntry,
    reason: HandoffReason,
    capturedUrl: string,
  ): Promise<BrowserStorageState | null> {
    // A crashed renderer cannot safely run `executeJavaScript` for
    // localStorage, and its webContents state is not trustworthy - honor
    // "no-capture" in the reason literally rather than attempting one.
    if (reason === "crash-no-capture") return null;
    try {
      const result = await this.captureStorageState(
        { origin: capturedUrl },
        entry.view.webContents,
      );
      return result.storageState;
    } catch {
      // `capturedUrl` is not http(s) (e.g. a fresh "about:blank" tile
      // never navigated), or the capture raced the teardown it precedes.
      // Still hand the session off at its URL, just without carried
      // storage, rather than dropping the whole handoff over this.
      return null;
    }
  }

  private readUrl(entry: BrowserViewEntry): string {
    if (!this.entries.isCurrent(entry)) return entry.currentUrl;
    const webContents = entry.view.webContents;
    if (webContents.isDestroyed()) return entry.currentUrl;
    try {
      const url = webContents.getURL();
      return url.length > 0 ? url : entry.currentUrl;
    } catch {
      return entry.currentUrl;
    }
  }
}
