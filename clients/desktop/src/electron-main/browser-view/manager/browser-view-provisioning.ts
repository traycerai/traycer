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
  readonly releaseRendererGuest: (registrationId: string) => void;
  readonly seedStorageState: (
    input: BrowserViewEnsureTab,
    webContents: BrowserViewWebContents,
  ) => Promise<BrowserStorageState | null>;
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
  private readonly releaseRendererGuest: (registrationId: string) => void;
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
      this.releaseRendererGuest(inFlight.registrationId);
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
  ): Promise<BrowserViewNativeTabCapability> {
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
      identity: key,
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
