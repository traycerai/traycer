import type { BrowserViewNativeTabCapability } from "@traycer-clients/shared/platform/browser-view";
import type { BrowserStorageState } from "@traycer/protocol/host/browser/contracts";
import { describeLogError, log } from "../../app/logger";
import {
  partitionForProfile,
  type BrowserSessionProfile,
} from "../browser-session";
import type {
  BrowserViewEnsureTab,
  BrowserViewGuestAttachRequest,
  BrowserViewGuestAttachResult,
  BrowserViewNativeTabTransfer,
  BrowserViewWebContents,
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
  readonly createEntryFromWebContents: (
    requestedUrl: string,
    identity: BrowserViewNativeIdentity,
    profile: BrowserSessionProfile,
    webContents: BrowserViewWebContents,
  ) => BrowserViewEntry;
  readonly attachRendererGuest: (
    windowId: string,
    request: BrowserViewGuestAttachRequest,
  ) => BrowserViewGuestAttachResult;
  readonly releaseRendererGuest: (
    registrationId: string,
    windowId: string,
  ) => void;
  readonly seedStorageState: (
    input: BrowserViewEnsureTab,
    webContents: BrowserViewWebContents,
  ) => Promise<BrowserStorageState | null>;
  readonly closeEntry: (entry: BrowserViewEntry) => Promise<void>;
  readonly navigate: (entry: BrowserViewEntry, url: string) => Promise<void>;
  readonly emitStatus: (entry: BrowserViewEntry) => void;
  /**
   * The transferred-listener set is the manager's own state rather than
   * provisioning's. An options callback in the `emitStatus` / `closeEntry`
   * pattern, so the cross-window replacement stays here without this module
   * reaching into the manager.
   */
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
  private readonly createEntryFromWebContents: (
    requestedUrl: string,
    identity: BrowserViewNativeIdentity,
    profile: BrowserSessionProfile,
    webContents: BrowserViewWebContents,
  ) => BrowserViewEntry;
  private readonly attachRendererGuest: (
    windowId: string,
    request: BrowserViewGuestAttachRequest,
  ) => BrowserViewGuestAttachResult;
  private readonly releaseRendererGuest: (
    registrationId: string,
    windowId: string,
  ) => void;
  private readonly seedStorageState: (
    input: BrowserViewEnsureTab,
    webContents: BrowserViewWebContents,
  ) => Promise<BrowserStorageState | null>;
  private readonly closeEntry: (entry: BrowserViewEntry) => Promise<void>;
  private readonly navigate: (
    entry: BrowserViewEntry,
    url: string,
  ) => Promise<void>;
  private readonly emitStatus: (entry: BrowserViewEntry) => void;
  private readonly notifyNativeTabTransferred: (
    transfer: BrowserViewNativeTabTransfer,
  ) => void;
  /**
   * Occupies a guest key for the whole async mint so a same-window second
   * ensure joins the in-flight incarnation. A later ensure from a different
   * window supersedes that mint instead of inheriting its guest.
   */
  private readonly inFlightEnsures = new Map<string, InFlightEnsure>();

  constructor(options: BrowserViewProvisioningOptions) {
    this.entries = options.entries;
    this.windows = options.windows;
    this.debugSessions = options.debugSessions;
    this.createEntryFromWebContents = options.createEntryFromWebContents;
    this.attachRendererGuest = options.attachRendererGuest;
    this.releaseRendererGuest = options.releaseRendererGuest;
    this.seedStorageState = options.seedStorageState;
    this.closeEntry = options.closeEntry;
    this.navigate = options.navigate;
    this.emitStatus = options.emitStatus;
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
      if (existing.identity.lifecycleWindowId !== windowId) {
        return this.replaceNativeGuestForWindow(
          guestKey,
          existing,
          windowId,
          input,
        );
      }
      return this.restoreExistingNativeTab(windowId, input, existing);
    }
    const inFlight = this.inFlightEnsures.get(guestKey);
    if (inFlight !== undefined) {
      if (inFlight.windowId === windowId) return inFlight.promise;
      this.supersedeInFlightEnsure(guestKey, inFlight);
    }

    logEnsureStage(input, startedAt, "manager_started", "started", null);
    const lifecycle = new NativeBrowserViewLifecycle();
    const record: InFlightEnsure = {
      windowId,
      registrationId: null,
      entry: null,
      lifecycle,
      promise: lifecycle.provisioned,
    };
    try {
      this.ensureAttachedGuestTab(
        windowId,
        input,
        lifecycle,
        startedAt,
        record,
      );
    } catch (error) {
      lifecycle.failProvisioning(error);
      return record.promise;
    }
    this.inFlightEnsures.set(guestKey, record);
    void record.promise
      .finally(() => {
        if (this.inFlightEnsures.get(guestKey) === record) {
          this.inFlightEnsures.delete(guestKey);
        }
      })
      .catch(() => undefined);
    return record.promise;
  }

  private supersedeInFlightEnsure(
    guestKey: string,
    inFlight: InFlightEnsure,
  ): void {
    this.inFlightEnsures.delete(guestKey);
    const entry = inFlight.entry;
    if (entry !== null) {
      void this.closeEntry(entry).catch((cleanupError: unknown) => {
        log.warn("[browser-view] native tab cleanup failed", {
          error: describeLogError(cleanupError),
          guestKey: entry.guestKey,
        });
      });
    } else if (inFlight.registrationId !== null) {
      this.releaseRendererGuest(inFlight.registrationId, inFlight.windowId);
    }
    inFlight.lifecycle.failProvisioning(
      new Error("native tab ensure superseded by another window"),
    );
  }

  private ensureAttachedGuestTab(
    windowId: string,
    input: BrowserViewEnsureTab,
    lifecycle: NativeBrowserViewLifecycle,
    startedAt: number,
    record: InFlightEnsure,
  ): void {
    const key = {
      hostId: input.hostId,
      sessionId: input.sessionId,
      tabId: input.tabId,
    };
    let prepared: {
      readonly provisioned: BrowserViewNativeTabCapability;
      readonly seedScriptId: string | null;
    } | null = null;
    const mount = this.attachRendererGuest(windowId, {
      partition: partitionForProfile(input.profile, input.sessionId),
      onAttached: async (guest) => {
        const identity: BrowserViewNativeIdentity = {
          key,
          registrationId: mount.registrationId,
          lifecycleWindowId: windowId,
          lifecycle,
        };
        const entry = this.createEntryFromWebContents(
          input.requestedUrl,
          identity,
          input.profile,
          guest,
        );
        record.entry = entry;
        this.windows.ensureResetListener(windowId);
        logEnsureStage(input, startedAt, "entry_created", "ok", null);
        try {
          prepared = await this.initializeNativeTab(entry, input, startedAt);
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
              guestKey: entry.guestKey,
            });
          }
          throw error;
        }
      },
    });
    record.registrationId = mount.registrationId;
    void mount.ready.then(
      () => {
        if (prepared === null) {
          lifecycle.failProvisioning(
            new Error("webview guest attached without a provisioned entry"),
          );
          return;
        }
        lifecycle.completeProvisioning(
          prepared.provisioned,
          prepared.seedScriptId,
        );
      },
      (error: unknown) => {
        const pending = record.entry;
        const cleanup =
          pending === null
            ? Promise.resolve()
            : this.closeEntry(pending).catch((cleanupError: unknown) => {
                log.warn("[browser-view] native tab cleanup failed", {
                  error: describeLogError(cleanupError),
                  guestKey: pending.guestKey,
                });
              });
        return cleanup.then(() => {
          lifecycle.failProvisioning(error);
        });
      },
    );
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
    await entry.identity.lifecycle.provisioned;
    if (!isNativeTabAvailable(this.entries, entry)) {
      await this.closeEntry(entry);
      return this.ensureTab(windowId, input);
    }
    try {
      await this.debugSessions.ensure(entry).enableAfterCommit();
      const provisioned = this.resolveNativeTabProvisioned(entry);
      // A renderer reload destroys the guest, so the availability check above
      // re-ensures a dead one and a surviving entry only needs the state the
      // new renderer could not have observed replayed.
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
   * Re-homes a native tab from the window that holds it to the window that
   * just ensured it - the desktop half of "Show here" - by REPLACING the
   * guest: the old window's guest is closed and a fresh one is born in the new
   * window at the same tab identity, which the host's `"move"` create then
   * navigates to the tab's current URL.
   *
   * A replacement rather than a hand-over, and that is not a shortcut. A guest
   * is a `<webview>` mounted in ONE window's renderer DOM (`attachRendererGuest`
   * asks that window to mount it; `releaseRendererGuest` asks the same window
   * to unmount it), and Electron has no way to re-embed a live guest under a
   * different renderer. What survives a move is therefore the tab - its host
   * identity, its URL, its session storage in the shared partition - and not
   * the page's in-memory state (scroll, unsaved form input). That is the same
   * trade the renderer-owned guest cutover already made for a window reload.
   *
   * Unconditional on the window differing, not on the create's reason. Two
   * callers reach it. The host's `moveTab` is the one it exists for. The other
   * is a rebind or reconcile that resolves a tab to a different window while
   * the tab's own window is still open but holds no route - which the host
   * routes away from today, and which now performs a REAL re-home rather than
   * the silent adoption it used to. That is correct only because of the
   * transfer notice: without retiring the old window's birth and the renderer
   * binding it feeds, the old window would go on believing it owns a guest it
   * no longer has, refuse the move back as an identity violation, and keep
   * answering `isTabViewed` and CDP frames for it.
   *
   * In order:
   *
   * 1. Tell the old window's `ElectronTabs`, which retires its accepted birth
   *    and releases the renderer's directory entry through the ordinary
   *    `tabReleased` path. Its `previousRegistrationId` is the only id the old
   *    window ever held; nothing it sends under that id can touch the new
   *    guest, whose registration is minted fresh below.
   * 2. Close the old entry - which detaches its surface, ends its PiP lease,
   *    releases the old window's renderer guest and drops the reset listener
   *    if the window has nothing else. A birth still in flight is superseded
   *    exactly as a competing window's ensure supersedes a cold mint: its
   *    lifecycle fails with the same error, so the old window's `ensureTab`
   *    settles instead of waiting on a guest that is gone.
   * 3. Re-enter `ensureTab`, which chains behind the close (the entry's
   *    `closePromise` is set synchronously) and then births the replacement
   *    in the new window through the ordinary cold path.
   */
  private replaceNativeGuestForWindow(
    guestKey: string,
    entry: BrowserViewEntry,
    windowId: string,
    input: BrowserViewEnsureTab,
  ): Promise<BrowserViewNativeTabCapability> {
    this.notifyNativeTabTransferred({
      key: entry.identity.key,
      previousRegistrationId: entry.identity.registrationId,
      toWindowId: windowId,
    });
    const inFlight = this.inFlightEnsures.get(guestKey);
    if (inFlight !== undefined && inFlight.entry === entry) {
      this.supersedeInFlightEnsure(guestKey, inFlight);
    } else {
      void this.closeEntry(entry).catch((cleanupError: unknown) => {
        log.warn("[browser-view] native tab cleanup failed", {
          error: describeLogError(cleanupError),
          guestKey: entry.guestKey,
        });
      });
    }
    return this.ensureTab(windowId, input);
  }

  private async initializeNativeTab(
    entry: BrowserViewEntry,
    input: BrowserViewEnsureTab,
    startedAt: number,
  ): Promise<{
    readonly provisioned: BrowserViewNativeTabCapability;
    readonly seedScriptId: string | null;
  }> {
    // The script is built from what the seed path RETURNED, never from the
    // host's raw frame: the localStorage half is narrowed to the tab's own
    // site there, and refused outright when the cookie half was refused.
    const seeded = await this.seedStorageState(input, entry.webContents);
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
    return { provisioned, seedScriptId };
  }

  private async activateNativeTabTarget(
    entry: BrowserViewEntry,
    input: BrowserViewEnsureTab,
    startedAt: number,
  ): Promise<void> {
    // The renderer creates the guest at about:blank, but Page CDP does not
    // accept commands until the first document target has loaded. This
    // internal navigation establishes that target before storage seeding; it
    // is deliberately suppressed from browser-session state and history.
    entry.internalNavigation = true;
    try {
      await entry.webContents.loadURL("about:blank");
    } finally {
      entry.webContents.navigationHistory?.clear();
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
    !entry.webContents.isDestroyed()
  );
}

interface InFlightEnsure {
  readonly windowId: string;
  registrationId: string | null;
  entry: BrowserViewEntry | null;
  readonly lifecycle: NativeBrowserViewLifecycle;
  readonly promise: Promise<BrowserViewNativeTabCapability>;
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
