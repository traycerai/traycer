import { randomUUID } from "node:crypto";
import type { BrowserViewNativeTabCapability } from "@traycer-clients/shared/platform/browser-view";
import type { BrowserStorageState } from "@traycer/protocol/host/browser/contracts";
import { describeLogError, log } from "../../app/logger";
import type { BrowserSessionProfile } from "../browser-session";
import type {
  BrowserViewEnsureTab,
  BrowserViewNativeTabTransfer,
  ManagedBrowserView,
} from "../browser-view-port";
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
    profile: BrowserSessionProfile,
  ) => BrowserViewEntry;
  readonly seedStorageState: (
    input: BrowserViewEnsureTab,
    webContents: ManagedBrowserView["webContents"],
  ) => Promise<BrowserStorageState | null>;
  readonly closeEntry: (entry: BrowserViewEntry) => Promise<void>;
  readonly navigate: (entry: BrowserViewEntry, url: string) => Promise<void>;
  readonly emitStatus: (entry: BrowserViewEntry) => void;
  /**
   * The three collaborators the cross-window transfer needs, all of them the
   * manager's own state rather than provisioning's: the surface binding, the
   * PiP lease and the transferred-listener set. Options callbacks in the
   * `emitStatus` / `closeEntry` pattern, so the transfer stays here without
   * this module reaching into the manager.
   */
  readonly detachEntrySurface: (entry: BrowserViewEntry) => void;
  readonly endPipCapture: (entry: BrowserViewEntry) => void;
  readonly notifyNativeTabTransferred: (
    transfer: BrowserViewNativeTabTransfer,
  ) => void;
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
    profile: BrowserSessionProfile,
  ) => BrowserViewEntry;
  private readonly seedStorageState: (
    input: BrowserViewEnsureTab,
    webContents: ManagedBrowserView["webContents"],
  ) => Promise<BrowserStorageState | null>;
  private readonly closeEntry: (entry: BrowserViewEntry) => Promise<void>;
  private readonly navigate: (
    entry: BrowserViewEntry,
    url: string,
  ) => Promise<void>;
  private readonly emitStatus: (entry: BrowserViewEntry) => void;
  private readonly detachEntrySurface: (entry: BrowserViewEntry) => void;
  private readonly endPipCapture: (entry: BrowserViewEntry) => void;
  private readonly notifyNativeTabTransferred: (
    transfer: BrowserViewNativeTabTransfer,
  ) => void;

  constructor(options: BrowserViewProvisioningOptions) {
    this.entries = options.entries;
    this.windows = options.windows;
    this.debugSessions = options.debugSessions;
    this.createEntry = options.createEntry;
    this.seedStorageState = options.seedStorageState;
    this.closeEntry = options.closeEntry;
    this.navigate = options.navigate;
    this.emitStatus = options.emitStatus;
    this.detachEntrySurface = options.detachEntrySurface;
    this.endPipCapture = options.endPipCapture;
    this.notifyNativeTabTransferred = options.notifyNativeTabTransferred;
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
    const entry = this.createEntry(input.requestedUrl, identity, input.profile);
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

  /**
   * Moves a live guest from the window that holds it to the window that just
   * ensured it, WITHOUT touching its WebContents - the desktop half of "Show
   * here". Same page, same scroll, same in-page state; only who owns it moves.
   *
   * Unconditional on the window differing, not on the create's reason. Two
   * callers reach it. The host's `moveTab` is the one it exists for. The other
   * is a rebind or reconcile that resolves a tab to a different window while
   * the tab's own window is still open but holds no route - which the host
   * routes away from today, and which now performs a REAL transfer rather than
   * the silent adoption it used to. That is correct only because of step 3
   * below: without retiring the old window's birth and the renderer binding it
   * feeds, the old window would go on believing it owns a guest it no longer
   * has, refuse the move back as an identity violation, and keep answering
   * `isTabViewed` and CDP frames for it.
   *
   * In order, and the order matters:
   *
   * 1. Mint a new `registrationId`. That alone makes every consumer holding
   *    the old one inert (`findExactNativeEntry` plus `releaseTab`'s own
   *    check), so no per-consumer guard is needed - including the release the
   *    old window may still send, which would otherwise close the guest the
   *    new window just adopted.
   * 2. Detach the old surface, or the new window's `attachSurface` is refused
   *    as an active binding; and end any PiP lease, which the surface detach
   *    deliberately does not touch and which `reconcileVisibility` SKIPS an
   *    entry for - a moved tab in PiP would otherwise keep compositing in the
   *    window it left. The detach runs before the `lifecycleWindowId` move so
   *    its status emission still names the old window, and so the old window's
   *    reset listener is still seen as in use until step 4 decides.
   * 3. Tell the old window's `ElectronTabs`, which retires its accepted birth
   *    and releases the renderer's directory entry through the ordinary
   *    `tabReleased` path.
   * 4. The lifecycle move itself, which `hasNativeTabsForWindow` (who owes the
   *    final primary-profile capture) and `handleHostWindowRendererReset` (who
   *    may close an unaccepted guest) both read, so both follow the guest.
   */
  private transferNativeLifecycle(
    entry: BrowserViewEntry,
    windowId: string,
  ): void {
    const previousWindowId = entry.identity.lifecycleWindowId;
    if (previousWindowId === windowId) return;
    const previousRegistrationId = entry.identity.registrationId;
    entry.identity.registrationId = randomUUID();
    this.detachEntrySurface(entry);
    this.endPipCapture(entry);
    this.notifyNativeTabTransferred({
      key: entry.identity.key,
      previousRegistrationId,
      toWindowId: windowId,
    });
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
    // The script is built from what the seed path RETURNED, never from the
    // host's raw frame: the localStorage half is narrowed to the tab's own
    // site there, and refused outright when the cookie half was refused.
    const seeded = await this.seedStorageState(input, entry.view.webContents);
    const seedScript = browserLocalStorageSeedScript(seeded);
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
