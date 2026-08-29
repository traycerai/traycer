import type { BrowserStorageState } from "@traycer/protocol/host/browser/contracts";
import { RunnerHostEvent } from "../../../ipc-contracts/ipc-channels";
import type {
  BrowserPrimaryProfileCaptureResult,
  BrowserViewElectronTabHandoffChange,
} from "@traycer-clients/shared/platform/browser-view";
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
  readonly capturePrimaryProfile: () => Promise<BrowserPrimaryProfileCaptureResult>;
}

/**
 * Captures a native session's URLs plus one partition-wide storage jar and
 * hands them to the renderer before destructive teardown, so the tabs can be
 * re-created headless without losing the pages they were on or the sign-ins
 * the partition holds.
 */
export class BrowserViewHandoff {
  private readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  private readonly send: BrowserViewSend;
  private readonly captureStorageState: (
    input: { readonly origin: string },
    webContents: ManagedBrowserView["webContents"],
  ) => Promise<BrowserStorageStateCaptureResult>;
  private readonly capturePrimaryProfile: () => Promise<BrowserPrimaryProfileCaptureResult>;

  constructor(options: BrowserViewHandoffOptions) {
    this.entries = options.entries;
    this.send = options.send;
    this.captureStorageState = options.captureStorageState;
    this.capturePrimaryProfile = options.capturePrimaryProfile;
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
      const capturedStorageState = await this.capturePartition(
        entry,
        reason,
        capturedUrl,
      );
      const siblingTabs = capturedSiblings.map(({ entry: sibling, url }) => ({
        tabId: sibling.identity.key.tabId,
        registrationId: sibling.identity.registrationId,
        url,
      }));
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

  /**
   * One partition-wide jar per handoff, with the handed-off tab's own origin
   * merged over it. The coordinator only keeps localStorage for the last
   * `PRIMARY_PROFILE_LOCAL_STORAGE_ORIGIN_LIMIT` (8) observed origins, so the
   * active tab's origin is captured again here rather than risking the one
   * origin the LRU evicted. No partition jar means no capture at all: the
   * tab-scoped capture holds only one origin's cookies, and the host stores
   * whatever arrives here as the whole jar, so sending it would delete every
   * other sign-in. Null routes the session to the cached snapshot instead.
   */
  private async capturePartition(
    entry: BrowserViewEntry,
    reason: HandoffReason,
    capturedUrl: string,
  ): Promise<BrowserStorageState | null> {
    if (reason === "crash-no-capture") return null;
    const profile = await this.capturePrimaryProfile().catch(() => null);
    const jar =
      profile !== null && profile.status === "captured"
        ? profile.storageState
        : null;
    if (jar === null) return null;
    const own = await this.captureState(entry, reason, capturedUrl);
    if (own === null) return jar;
    const ownOrigins = new Set(own.origins.map((origin) => origin.origin));
    return {
      cookies: jar.cookies,
      origins: [
        ...own.origins,
        ...jar.origins.filter((origin) => !ownOrigins.has(origin.origin)),
      ],
    };
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
