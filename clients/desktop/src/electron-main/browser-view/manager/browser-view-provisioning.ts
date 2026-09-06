import type { BrowserViewNativeTabCapability } from "@traycer-clients/shared/platform/browser-view";
import type { BrowserStorageState } from "@traycer/protocol/host/browser/contracts";
import { describeLogError, log } from "../../app/logger";
import {
  partitionForProfile,
  pendingBrowserViewPartitionRelease,
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
  nativeBrowserSessionKey as nativeSessionKey,
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
  /**
   * The release an entry's close skipped because it was `succeededByReplacement`,
   * run after all when the successor never came. Consults the registry the
   * same way the close does, so a sibling that arrived meanwhile still keeps
   * the partition.
   */
  readonly releaseIsolatedSessionStorage: (entry: BrowserViewEntry) => void;
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
  private readonly releaseIsolatedSessionStorage: (
    entry: BrowserViewEntry,
  ) => void;
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
  /**
   * The isolated release one SESSION still owes, and any entry of that session
   * that can answer it.
   *
   * A guest closed to be re-born elsewhere is not its session's last tab, so
   * its close skips the partition release (`succeededByReplacement`). Who runs
   * that release if the successor never arrives is the obligation kept here,
   * and it has to OUTLIVE the successor: a third window can supersede a
   * replacement mid-birth, and its own cold ensure knows nothing about the
   * entry whose release was skipped.
   *
   * Keyed by SESSION and not by guest key, because the partition is the
   * session's and every one of its tabs is born into the same one. A guest-key
   * debt could only ask "is anything still coming for THIS tab", and a move of
   * two sibling tabs (the host restores or rebinds a session's tabs together)
   * answers no for the first while the second is still being born with no
   * registry entry yet - so the partition would be cleared out from under it.
   * `releaseIsolatedSessionStorage` cannot catch that either: it consults
   * REGISTERED siblings, and an ensure held before `onAttached` has none.
   */
  private readonly owedIsolatedReleases = new Map<string, BrowserViewEntry>();

  constructor(options: BrowserViewProvisioningOptions) {
    this.entries = options.entries;
    this.windows = options.windows;
    this.debugSessions = options.debugSessions;
    this.createEntryFromWebContents = options.createEntryFromWebContents;
    this.attachRendererGuest = options.attachRendererGuest;
    this.releaseRendererGuest = options.releaseRendererGuest;
    this.seedStorageState = options.seedStorageState;
    this.closeEntry = options.closeEntry;
    this.releaseIsolatedSessionStorage = options.releaseIsolatedSessionStorage;
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
    const sessionKey = nativeSessionKey(input);
    const record: InFlightEnsure = {
      windowId,
      sessionKey,
      registrationId: null,
      entry: null,
      lifecycle,
      promise: lifecycle.provisioned,
    };
    // Recorded in flight BEFORE the guest is minted, which it was not before
    // the partition barrier existed. A birth that is waiting for its
    // partition's jar to finish being cleared is every bit as much a guest on
    // its way into that partition as one already attaching, so it has to be
    // visible to `hasEnsureForSession` for the whole wait - otherwise the
    // session's owed release would settle straight through it. Registering
    // first also gives a synchronous mint failure the same settlement path as
    // every other failure instead of the bespoke early return it used to take.
    this.inFlightEnsures.set(guestKey, record);
    void record.promise
      .finally(() => {
        if (this.inFlightEnsures.get(guestKey) === record) {
          this.inFlightEnsures.delete(guestKey);
        }
        // Every ensure settles here, so the session's debt is revisited
        // whenever one of the births that was holding it off ends - this tab's
        // or a sibling tab's, a cold successor's included.
        this.settleOwedIsolatedRelease(record.sessionKey);
      })
      .catch(() => undefined);
    const partition = partitionForProfile(input.profile, input.sessionId);
    if (pendingBrowserViewPartitionRelease(partition) === null) {
      this.beginGuestBirth(guestKey, windowId, input, startedAt, record);
    } else {
      log.info("[browser-view] native tab ensure awaiting partition release", {
        kind: "electron_tab_create",
        hostId: input.hostId,
        sessionId: input.sessionId,
        tabId: input.tabId,
      });
      void this.beginGuestBirthAfterRelease(
        guestKey,
        windowId,
        input,
        startedAt,
        record,
      );
    }
    return record.promise;
  }

  /**
   * Mints the guest, unless this record has stopped being the key's incarnation
   * while it waited.
   *
   * The identity check is what makes the deferred path safe: a different
   * window's ensure can supersede this one during the wait, and superseding
   * fails the lifecycle and drops the record without having anything to
   * unmount. Minting afterwards would attach a `<webview>` for a promise that
   * has already rejected - a guest nobody would ever close.
   */
  private beginGuestBirth(
    guestKey: string,
    windowId: string,
    input: BrowserViewEnsureTab,
    startedAt: number,
    record: InFlightEnsure,
  ): void {
    if (this.inFlightEnsures.get(guestKey) !== record) return;
    try {
      this.ensureAttachedGuestTab(
        windowId,
        input,
        record.lifecycle,
        startedAt,
        record,
      );
    } catch (error) {
      record.lifecycle.failProvisioning(error);
    }
  }

  /**
   * Holds a birth until this partition's jar is done being cleared.
   *
   * The hazard is Electron's, not ours: `session.fromPartition` hands back the
   * SAME in-memory partition for the same name, and an isolated partition's
   * name is derived from the session id. So a guest minted while
   * `clearStorageData()` is still running is born into the jar that clear is
   * emptying and loses its cookies and localStorage a moment after it starts -
   * which is exactly what a retry after a failed cross-window replacement
   * does, since the release that failure owed has already been started by the
   * time the host asks for the tab again.
   *
   * A LOOP, not one await, because the barrier answers for the partition as it
   * is now: a sibling tab's close can start a fresh clear of the same jar
   * between this one settling and the mint. Each iteration needs another close
   * of another registered guest, so it terminates. The barrier never rejects
   * (see `releaseBrowserViewSession`), so a clear that fails still lets the
   * birth through rather than stranding it.
   */
  private async beginGuestBirthAfterRelease(
    guestKey: string,
    windowId: string,
    input: BrowserViewEnsureTab,
    startedAt: number,
    record: InFlightEnsure,
  ): Promise<void> {
    const partition = partitionForProfile(input.profile, input.sessionId);
    let pending = pendingBrowserViewPartitionRelease(partition);
    while (pending !== null) {
      const awaited = pending;
      await awaited;
      const next = pendingBrowserViewPartitionRelease(partition);
      // Identity, not nullness, is what ends the loop. The release lifts its
      // own barrier in a `finally` that is registered before any waiter's, so
      // the map is normally clear by the time we look - but resting a loop on
      // microtask ordering is resting it on a hang, and seeing the SAME
      // settled promise twice can only mean the release has not got there yet.
      pending = next === awaited ? null : next;
    }
    this.beginGuestBirth(guestKey, windowId, input, startedAt, record);
  }

  /**
   * Runs or defers the release {@link owedIsolatedReleases} holds for this
   * SESSION.
   *
   * Deferred while any ensure for the session is still in flight - each of
   * them is a guest that will be born into this partition, and each settles
   * later and asks again. Otherwise the mark is lifted and the release runs
   * against the registry as it stands: `releaseIsolatedSessionStorage` is what
   * decides, so a sibling tab that HAS an entry by now keeps the partition and
   * its own close carries it out later.
   */
  private settleOwedIsolatedRelease(sessionKey: string): void {
    const owed = this.owedIsolatedReleases.get(sessionKey);
    if (owed === undefined) return;
    if (this.hasEnsureForSession(sessionKey)) return;
    this.owedIsolatedReleases.delete(sessionKey);
    owed.succeededByReplacement = false;
    this.releaseIsolatedSessionStorage(owed);
  }

  /**
   * Takes over a release the manager is about to run, if a guest of that
   * session is still being born.
   *
   * The mirror of the partition barrier, and the half a barrier cannot answer.
   * The barrier holds a birth that has not started against a clear already
   * running; this holds a clear that has not started against a birth already
   * minted - a guest whose `<webview>` exists and whose `onAttached` has not
   * run yet, so `releaseIsolatedSessionStorage`'s scan of REGISTERED siblings
   * cannot see it and reads the closing tab as the session's last. Electron
   * would then empty the jar the minted guest is already living in.
   *
   * Recorded rather than refused: `settleOwedIsolatedRelease` re-asks when
   * that birth ends, and re-runs the manager's own guards - so a birth that
   * SUCCEEDED keeps the partition through its new entry, and one that failed
   * releases it after all. Returns whether the caller should stand down.
   */
  deferIsolatedReleaseWhileEnsuring(
    entry: BrowserViewEntry,
    sessionKey: string,
  ): boolean {
    if (!this.hasEnsureForSession(sessionKey)) return false;
    this.owedIsolatedReleases.set(sessionKey, entry);
    return true;
  }

  /** Is any guest of this session still being born? */
  private hasEnsureForSession(sessionKey: string): boolean {
    for (const record of this.inFlightEnsures.values()) {
      if (record.sessionKey === sessionKey) return true;
    }
    return false;
  }

  private supersedeInFlightEnsure(
    guestKey: string,
    inFlight: InFlightEnsure,
  ): void {
    this.inFlightEnsures.delete(guestKey);
    const entry = inFlight.entry;
    if (entry !== null) {
      // Marked for the reason a move marks its old entry: this guest is being
      // succeeded at the same tab identity, so its close is not the isolated
      // session's last one and must not take the partition the successor is
      // about to be born into.
      //
      // Belt and braces rather than a live defect. A record's `entry` is set
      // in the same breath as `entries.register`, so an unclosed one is always
      // findable by guest key - which means `ensureTab` routed through
      // `replaceNativeGuestForWindow` and marked it already, and a closed one
      // makes this close a no-op. The mark is here so the branch is right on
      // its own terms instead of resting on that routing, and so both supersede
      // routes leave the same obligation behind.
      entry.succeededByReplacement = true;
      this.owedIsolatedReleases.set(inFlight.sessionKey, entry);
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
   *
   * The session's storage is what the tab keeps across the move, and for an
   * `isolated` session that is not automatic: its partition is released with
   * the session's last guest, and the close in step 2 IS the last guest for as
   * long as the successor has not been born. The old entry is therefore marked
   * `succeededByReplacement` before it closes, so the close leaves the
   * partition alone and the replacement is born into the same signed-in
   * session.
   *
   * Should the replacement never arrive, the mark is lifted and the release
   * the close skipped runs then, against the registry as it stands at that
   * moment. "Never arrive" includes the case a THIRD window takes the move
   * over mid-birth, and that is why the obligation is held in
   * `owedIsolatedReleases` rather than in this method's own rejection handler:
   * the third window's ensure is an ordinary cold mint with no reference to
   * the entry whose release was skipped, so if IT fails before creating an
   * entry there is no close left to carry the partition out.
   *
   * The debt is keyed by SESSION, so a move of two sibling tabs settles it
   * once, when the last of their births ends - not when the first one does,
   * while the other is still on its way into the same partition.
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
    entry.succeededByReplacement = true;
    const sessionKey = nativeSessionKey(entry.identity.key);
    this.owedIsolatedReleases.set(sessionKey, entry);
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
    const replacement = this.ensureTab(windowId, input);
    void replacement.catch(() => {
      // The obligation recorded above, answered here or deferred to whichever
      // ensure for this SESSION settles last - a third window may have taken
      // the move over while this successor was being born, and its own cold
      // ensure carries no reference to the entry whose release was skipped.
      //
      // Redundant with the in-flight `finally`, and kept deliberately. It
      // used to be the only door for a replacement that failed before it was
      // ever recorded in flight - a synchronous throw out of
      // `ensureAttachedGuestTab` - and that gap is closed now that `ensureTab`
      // registers the record before minting. What is left is a second call on
      // an obligation the first one already answered, which costs a map miss;
      // the alternative is a settlement path that exists in exactly one
      // ordering of two handlers on the same promise.
      this.settleOwedIsolatedRelease(sessionKey);
    });
    return replacement;
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
  /**
   * The session this birth belongs to. Read by the isolated-release debt,
   * which is owed per SESSION: every tab of one shares its partition, so a
   * sibling still being born is a reason not to clear it.
   */
  readonly sessionKey: string;
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
