import { randomUUID } from "node:crypto";
import type {
  BrowserViewEnsureTab,
  BrowserViewNativeTabCapability,
} from "@traycer-clients/shared/platform/browser-view";
import type { BrowserStorageState } from "@traycer/protocol/host/browser/contracts";
import { describeLogError, log } from "../../app/logger";
import type { ManagedBrowserView } from "../browser-view-port";
import { browserLocalStorageSeedScript } from "../storage/browser-storage-state";
import type {
  BrowserViewEntry,
  BrowserViewNativeIdentity,
} from "./browser-view-entry";
import {
  nativeBrowserViewGuestKey as nativeGuestKey,
  type BrowserViewEntryRegistry,
} from "./browser-view-entry-registry";
import type { BrowserViewWindowAttachment } from "./browser-view-window-attachment";
import type { BrowserViewDebugSessions } from "./debug-session-for";
import { NativeBrowserViewLifecycle } from "./native-browser-view-lifecycle";

interface BrowserViewProvisioningOptions {
  readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  readonly windows: BrowserViewWindowAttachment;
  readonly debugSessions: BrowserViewDebugSessions;
  readonly createEntry: (
    requestedUrl: string,
    identity: BrowserViewNativeIdentity,
  ) => BrowserViewEntry;
  readonly seedStorageState: (
    storageState: BrowserStorageState | null,
    webContents: ManagedBrowserView["webContents"],
  ) => Promise<void>;
  readonly closeEntry: (entry: BrowserViewEntry) => Promise<void>;
  readonly navigate: (entry: BrowserViewEntry, url: string) => Promise<void>;
  readonly emitStatus: (entry: BrowserViewEntry) => void;
}

/**
 * Birth of a host-owned Electron guest: allocating the view, establishing its
 * first CDP target, seeding storage, and settling the lifecycle promise the
 * host waits on. Everything here talks to `NativeBrowserViewLifecycle`, the
 * debug session and the entry - never to a caller's tile.
 */
export class BrowserViewProvisioning {
  private readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>;
  private readonly windows: BrowserViewWindowAttachment;
  private readonly debugSessions: BrowserViewDebugSessions;
  private readonly createEntry: (
    requestedUrl: string,
    identity: BrowserViewNativeIdentity,
  ) => BrowserViewEntry;
  private readonly seedStorageState: (
    storageState: BrowserStorageState | null,
    webContents: ManagedBrowserView["webContents"],
  ) => Promise<void>;
  private readonly closeEntry: (entry: BrowserViewEntry) => Promise<void>;
  private readonly navigate: (
    entry: BrowserViewEntry,
    url: string,
  ) => Promise<void>;
  private readonly emitStatus: (entry: BrowserViewEntry) => void;

  constructor(options: BrowserViewProvisioningOptions) {
    this.entries = options.entries;
    this.windows = options.windows;
    this.debugSessions = options.debugSessions;
    this.createEntry = options.createEntry;
    this.seedStorageState = options.seedStorageState;
    this.closeEntry = options.closeEntry;
    this.navigate = options.navigate;
    this.emitStatus = options.emitStatus;
  }

  ensureTab(
    windowId: string,
    input: BrowserViewEnsureTab,
  ): Promise<BrowserViewNativeTabCapability> {
    const startedAt = Date.now();
    const guestKey = nativeGuestKey(input);
    const existing = this.entries.getGuest(guestKey);
    if (existing !== undefined) {
      if (existing.closePromise !== null) {
        return existing.closePromise.then(() =>
          this.ensureTab(windowId, input),
        );
      }
      return this.restoreExistingNativeTab(windowId, input, existing);
    }

    logEnsureStage(input, startedAt, "manager_started", "started", null);
    const lifecycle = new NativeBrowserViewLifecycle();
    const identity: BrowserViewNativeIdentity = {
      key: {
        hostId: input.hostId,
        sessionId: input.sessionId,
        tabId: input.tabId,
      },
      registrationId: randomUUID(),
      lifecycleWindowId: windowId,
      lifecycle,
    };
    this.windows.ensureResetListener(windowId);
    const entry = this.createEntry(input.requestedUrl, identity);
    logEnsureStage(input, startedAt, "entry_created", "ok", null);
    void this.settleNativeTabInitialization(entry, input, startedAt);
    return lifecycle.provisioned;
  }

  /**
   * Runs the initial navigation once the host accepts a provisioned tab, then
   * drops the storage seed script so it cannot replay on later navigations.
   */
  async navigateAccepted(entry: BrowserViewEntry): Promise<void> {
    const debugSession = this.debugSessions.ensure(entry);
    try {
      await this.navigate(entry, entry.requestedUrl);
    } finally {
      const seedScriptId = entry.identity.lifecycle.takeSeedScriptId();
      if (seedScriptId !== null) {
        try {
          await debugSession.removeScriptBeforeNavigation(seedScriptId);
        } catch (error) {
          log.warn("[browser-view] failed to remove native tab seed script", {
            error: describeLogError(error),
            sessionId: entry.identity.key.sessionId,
            tabId: entry.identity.key.tabId,
          });
        }
      }
    }
  }

  private async restoreExistingNativeTab(
    windowId: string,
    input: BrowserViewEnsureTab,
    entry: BrowserViewEntry,
  ): Promise<BrowserViewNativeTabCapability> {
    this.transferNativeLifecycle(entry, windowId);
    await entry.identity.lifecycle.provisioned;
    if (!isNativeTabAvailable(this.entries, entry)) {
      await this.closeEntry(entry);
      return this.ensureTab(windowId, input);
    }
    try {
      await this.debugSessions.ensure(entry).enableAfterCommit();
      const provisioned = this.resolveNativeTabProvisioned(entry);
      // A renderer reload reuses the guest without causing navigation, so
      // replay the state that the new renderer could not have observed.
      this.emitStatus(entry);
      return provisioned;
    } catch (error) {
      log.warn("[browser-view] native tab debugger recovery failed", {
        error: describeLogError(error),
        guestKey: entry.guestKey,
      });
      await this.closeEntry(entry);
      return this.ensureTab(windowId, input);
    }
  }

  private transferNativeLifecycle(
    entry: BrowserViewEntry,
    windowId: string,
  ): void {
    const previousWindowId = entry.identity.lifecycleWindowId;
    if (previousWindowId === windowId) return;
    entry.identity.lifecycleWindowId = windowId;
    this.windows.ensureResetListener(windowId);
    this.windows.detachResetListenerIfUnused(previousWindowId);
  }

  private async settleNativeTabInitialization(
    entry: BrowserViewEntry,
    input: BrowserViewEnsureTab,
    startedAt: number,
  ): Promise<void> {
    try {
      await this.initializeNativeTab(entry, input, startedAt);
    } catch (error) {
      logEnsureStage(
        input,
        startedAt,
        "manager_settled",
        "failed",
        error instanceof Error ? error.name : typeof error,
      );
      try {
        await this.closeEntry(entry);
      } catch (cleanupError) {
        log.warn("[browser-view] native tab cleanup failed", {
          error: describeLogError(cleanupError),
          hostId: input.hostId,
          sessionId: input.sessionId,
          tabId: input.tabId,
        });
      }
      entry.identity.lifecycle.failProvisioning(error);
    }
  }

  private async initializeNativeTab(
    entry: BrowserViewEntry,
    input: BrowserViewEnsureTab,
    startedAt: number,
  ): Promise<BrowserViewNativeTabCapability> {
    await this.seedStorageState(input.seedStorageState, entry.view.webContents);
    const seedScript = browserLocalStorageSeedScript(input.seedStorageState);
    await this.activateNativeTabTarget(entry, input, startedAt);
    const debugSession = this.debugSessions.ensure(entry);
    const seedScriptId =
      seedScript === null
        ? null
        : await debugSession.installScriptBeforeNavigation(seedScript);
    await debugSession.enableAfterCommit();
    const provisioned = this.resolveNativeTabProvisioned(entry);
    logEnsureStage(input, startedAt, "manager_settled", "ok", null);
    entry.identity.lifecycle.completeProvisioning(provisioned, seedScriptId);
    return provisioned;
  }

  private async activateNativeTabTarget(
    entry: BrowserViewEntry,
    input: BrowserViewEnsureTab,
    startedAt: number,
  ): Promise<void> {
    // Electron allocates WebContentsView eagerly, but its Page CDP domain does
    // not accept commands until the first document target has loaded. This
    // internal navigation establishes that target before storage seeding; it
    // is deliberately suppressed from browser-session state and history.
    entry.internalNavigation = true;
    try {
      await entry.view.webContents.loadURL("about:blank");
    } finally {
      entry.view.webContents.navigationHistory?.clear();
      entry.internalNavigation = false;
    }
    logEnsureStage(input, startedAt, "target_activated", "ok", null);
  }

  private resolveNativeTabProvisioned(
    entry: BrowserViewEntry,
  ): BrowserViewNativeTabCapability {
    if (
      !isNativeTabAvailable(this.entries, entry) ||
      entry.debugSession?.isReady() !== true
    ) {
      throw new Error("Native browser tab CDP route is no longer available.");
    }
    return {
      ...entry.identity.key,
      registrationId: entry.identity.registrationId,
    };
  }
}

/** The guest is still this key's incarnation, alive, and has a live renderer. */
export function isNativeTabAvailable(
  entries: BrowserViewEntryRegistry<BrowserViewEntry>,
  entry: BrowserViewEntry,
): boolean {
  return (
    entries.isCurrent(entry) &&
    entry.status !== "dead" &&
    !entry.view.webContents.isDestroyed()
  );
}

function logEnsureStage(
  input: BrowserViewEnsureTab,
  startedAt: number,
  stage:
    | "manager_started"
    | "entry_created"
    | "target_activated"
    | "manager_settled",
  outcome: "started" | "ok" | "failed",
  cause: string | null,
): void {
  log.info("[browser-view] native tab ensure stage", {
    kind: "electron_tab_create",
    stage,
    outcome,
    cause,
    hostId: input.hostId,
    sessionId: input.sessionId,
    tabId: input.tabId,
    durationMs: Date.now() - startedAt,
  });
}
