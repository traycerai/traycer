import {
  BrowserWindow,
  app,
  dialog,
  type BrowserWindowConstructorOptions,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents,
} from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import {
  browserViewIpcPayload,
  parseReservedChords,
} from "./browser-view-ipc-payload";
import type { IpcManagedWindow } from "./runner-ipc-bridge";
import { BrowserViewManager } from "../browser-view/browser-view-manager";
import type {
  BrowserViewGuestAttachResult,
  BrowserViewPopupCreateWindowOptions,
  BrowserViewPopupWindow,
  BrowserViewWindow,
} from "../browser-view/browser-view-port";
import { hostPlatformFromProcessPlatform } from "../browser-view/manager/browser-view-chords";
import {
  BROWSER_VIEW_PARTITION,
  createBrowserViewWebPreferences,
  cancelBrowserViewDownload,
  clearBrowserViewPendingCertificateError,
  ensureBrowserViewSession,
  ensureBrowserViewSessionForPartition,
  forgetBrowserPrimaryProfileAppliedKeys,
  noteBrowserPrimaryProfileAppliedKeys,
  onBrowserPrimaryProfileDelta,
  onBrowserViewCertificateError,
  onBrowserViewDownloadChange,
  partitionForProfile,
  readBrowserViewPendingCertificateError,
  registerBrowserViewWebContents,
  releaseBrowserViewSession,
  suppressAllBrowserPrimaryProfileDeltas,
  type BrowserSessionProfileRequest,
} from "../browser-view/browser-session";
import { describeLogError, log } from "../app/logger";
import {
  confirmDestructiveInMain,
  type MainConfirmation,
} from "../app/confirm-destructive";
import {
  isBrowserSavedLoginsEnabled,
  setBrowserSavedLoginsEnabled,
  unwrapStoreKey,
  wrapStoreKey,
} from "../browser-view/storage/browser-saved-logins";
import { attestDesktopIdentity } from "../browser-view/storage/browser-desktop-identity";
import {
  BrowserPrimaryProfileSnapshotCoordinator,
  captureBrowserOriginLocalStorage,
  captureBrowserPrimaryProfile,
  clearBrowserSite,
  clearBrowserSiteLocalStorage,
  type BrowserPrimaryProfileCaptureResult,
} from "../browser-view/storage/browser-storage-state";
import {
  applyBrowserObservedProfile,
  BrowserObservedConnectionGovernor,
  traceBrowserObservedProfile,
  type BrowserObservedProfile,
  type BrowserObservedProfileResult,
  type BrowserObservedProfileTarget,
} from "../browser-view/storage/browser-observed-profile";
import { registrableDomainForUrl } from "@traycer/protocol/host/browser/registrable-domain";
import {
  BARRIER_ACTION_TIMEOUT_MS,
  BrowserJarSerializer,
} from "../browser-view/storage/browser-jar-serializer";
import {
  browserForgetLedgerDigestForHost,
  browserForgetLedgerPendingClears,
  isBrowserForgetLedgerPendingAck,
  isHeadlessOriginCookieKey,
  bracketUnclearedForgets,
  markBrowserForgetLedgerCleared,
  onBrowserForgetLedgerChanged,
  recordForgetAllBrowserLogins,
  recordForgetLedgerAck,
  recordForgottenBrowserSite,
  recordHeadlessOriginCookieKeys,
  releaseBrowserForgetLedgerConnection,
  releaseHeadlessOriginCookieKeys,
  withoutUnclearedForgets,
} from "../browser-view/storage/browser-forget-ledger";
import { trustBrowserCertificate } from "../app/cert-trust";
import {
  LOGIN_IMPORT_JAR_BARRIER_TIMEOUT_MS,
  createLoginImportService,
} from "../browser-view/storage/login-import/login-import-runtime";
import { normalizePickedFilePath } from "../browser-view/storage/login-import/sources";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";
import { fetchRegisteredHostsViaHttp } from "@traycer-clients/shared/host-client/remote-fetcher";
import { config } from "../../config";
import { BrowserSessionsRegistry } from "../browser-sessions/browser-sessions-owner";
import {
  createBrowserSessionsHostDirectory,
  openBrowserSessionsTransport,
} from "../browser-sessions/browser-sessions-transport";
import type {
  LoginImportResult,
  LoginImportScan,
  LoginImportSource,
} from "@traycer-clients/shared/platform/browser-view";
import {
  clearAllAttachmentGrants,
  mintAttachmentGrant,
  releaseAttachmentGrant,
} from "../browser-view/webview-guest-birth";

/**
 * The whole-jar capture reads the one shared `primary` identity, so its
 * session lookup carries no per-tab session id.
 */
const PRIMARY_PROFILE_REQUEST: BrowserSessionProfileRequest = {
  profile: "primary",
  sessionId: "primary",
};

export interface BrowserViewIpcRegistration {
  readonly manager: BrowserViewManager;
  readonly sessions: BrowserSessionsRegistry;
}

export function registerBrowserViewIpc(
  bridge: RunnerIpcBridge,
): BrowserViewIpcRegistration {
  // One governor for the process, keyed inside by the host connection each
  // frame arrived on - so every stream's paced attach replay meets the budget
  // it was paced against, and no host can borrow another's.
  const observedConnections = new BrowserObservedConnectionGovernor(() =>
    Date.now(),
  );
  // Everything that writes or empties the `primary` jar queues here, keyed by
  // registrable domain. It is what makes the applier's clear-in-progress check
  // an ordering fact instead of a read that a clear can invalidate before the
  // merge it authorised runs.
  const jarSerializer = new BrowserJarSerializer();
  const primaryProfileSnapshots = new BrowserPrimaryProfileSnapshotCoordinator(
    (origins) =>
      captureBrowserPrimaryProfile(origins, {
        readSaveLogins: isBrowserSavedLoginsEnabled,
        getSession: () => ensureBrowserViewSession(PRIMARY_PROFILE_REQUEST),
      }),
    captureBrowserOriginLocalStorage,
  );
  // The origins a clear can name are the coordinator's: localStorage is not
  // enumerable from the session, so the origins this process has actually
  // visited are the only ones a site clear can reach - including one whose
  // read is still in flight, since the tile that read is from is live there.
  const rememberedClearSiteOrigins = (): readonly string[] =>
    primaryProfileSnapshots.clearableOrigins();
  /**
   * Every jar a `primary` login can be sitting in right now, durable one first.
   *
   * The durable `persist:` jar is always in the list, for the same reason
   * "forget all" used to open it explicitly: it survives the saved-logins pref,
   * so a clear taken while saving is OFF would leave the login on disk and
   * turning the pref back on would restore what the user deleted. When saving
   * is off the live guests are on the EPHEMERAL jar instead, which is not
   * `persist:` but does outlive the toggle for the whole process run - so
   * leaving it out signs nobody out until the app restarts.
   *
   * Sessions are memoised per partition, so the two entries are the very same
   * object whenever the pref leaves `primary` guests on the durable jar, and
   * identity is what collapses the list back to one.
   */
  const primaryProfileJars = (): readonly Session[] => {
    const durableSession = ensureBrowserViewSessionForPartition(
      BROWSER_VIEW_PARTITION,
    );
    const activeSession = ensureBrowserViewSession(PRIMARY_PROFILE_REQUEST);
    return activeSession === durableSession
      ? [durableSession]
      : [durableSession, activeSession];
  };
  /**
   * One site gone from every one of those jars, and from the localStorage this
   * process remembers for it.
   *
   * EVERY jar is attempted, whatever the ones before it did: they hold
   * independent copies of the same login, so abandoning the loop on the durable
   * jar's failure would leave the open tile still signed in. The first failure
   * is re-thrown once the loop is done, so the IPC caller still learns the site
   * was not fully cleared.
   *
   * The prune runs last, and ONLY when every jar succeeded. Last, because each
   * clear reads the same remembered origins and pruning first would starve the
   * ones after it. All-or-nothing, because those remembered origins are the
   * only record of which localStorage a clear can name - dropping them while a
   * jar still holds the site would make that site's localStorage unreachable
   * for the rest of the run, retry included.
   */
  const clearBrowserSiteEverywhere = async (domain: string): Promise<void> => {
    // Boxed, so a falsy thrown value still counts as a failure.
    let failure: { readonly error: unknown } | null = null;
    for (const browserSession of primaryProfileJars()) {
      try {
        await clearBrowserSite(
          domain,
          browserSession,
          rememberedClearSiteOrigins,
        );
      } catch (error) {
        failure ??= { error };
        log.warn("[browser-view] clearing one site failed on a jar", {
          domain,
          error: describeLogError(error),
        });
      }
    }
    if (failure !== null) throw failure.error;
    primaryProfileSnapshots.forgetOriginsUnder(domain);
  };
  /**
   * "Forget all browser logins", the jar half only - the ledger write is the
   * caller's, because a boot reconciliation re-runs this without recording
   * anything new.
   *
   * Everything runs with the cookie-delta observer muted for every domain:
   * `clearStorageData` fires a removal for each cookie, and those deltas would
   * re-create the entries just deleted.
   *
   * The order is the rest of the correctness argument: the localStorage
   * coordinator is reset before the tiles come back, so a recreated tile
   * cannot be re-seeded from an origin remembered pre-forget, and the tiles
   * are recreated last, at their current URLs. Throws if any jar refused, so
   * the caller does not record a clear that did not happen.
   */
  const forgetEveryBrowserLogin = async (): Promise<void> => {
    // Opened here, outside the suppression: the durable jar must be cleared
    // even with saved logins off or no tile opened this run, and opening it is
    // what installs the observer the suppression mutes.
    const jars = primaryProfileJars();
    // A forget names no site, so it takes the serializer's barrier over every
    // one of them: an observed merge for ANY domain that is mid-flight
    // finishes first, and one that arrives during the forget waits until the
    // jar is empty rather than writing into a clear.
    await jarSerializer.runOnEveryDomain(
      async () =>
        suppressAllBrowserPrimaryProfileDeltas(async () => {
          let failure: { readonly error: unknown } | null = null;
          for (const primarySession of jars) {
            try {
              await primarySession.clearStorageData();
            } catch (error) {
              // The tiles still have to be recreated: they are sitting on a jar
              // the host no longer holds a key for, and leaving them there is
              // worse. The other jar still gets its turn for the same reason.
              failure ??= { error };
              log.warn("[browser-view] primary session clear failed", {
                error: describeLogError(error),
              });
            }
          }
          // Unconditional, unlike `clearBrowserSiteEverywhere`'s prune, and for
          // the reason that prune is conditional: a whole-jar clear names no
          // origins, so dropping this memory starves no retry - while KEEPING it
          // after a failed clear would let the next capture upload to the host
          // the very localStorage it just shredded its slice for.
          primaryProfileSnapshots.reset();
          await manager.recreateNativeTabsOnCurrentPartition();
          // Surfaced only once the tiles are back, and surfaced at all so the
          // caller is not told the logins are gone when a jar still holds them.
          if (failure !== null) throw failure.error;
        }),
      BARRIER_ACTION_TIMEOUT_MS,
    );
    log.info("[browser-view] forgot the saved browser logins");
  };
  /**
   * The ONE validated write path a host reaches this jar through.
   *
   * Both doors - the `primaryProfileObserved` frame and the
   * `createElectronTab` storage seed - land here with the same dependencies,
   * so there is exactly one place that decides what a host may write and one
   * set of traces to read afterwards. Only the jar the write targets differs,
   * which is why it is the argument: the observed frame always means the
   * shared `primary` jar, while a seed means the guest's own.
   */
  const applyHostContributedCookies = async (
    observed: BrowserObservedProfile,
    getTargetJar: () => BrowserObservedProfileTarget,
  ): Promise<BrowserObservedProfileResult> => {
    const result = await applyBrowserObservedProfile(observed, {
      now: () => Date.now(),
      isForgottenPendingAck: isBrowserForgetLedgerPendingAck,
      isHeadlessOriginKey: isHeadlessOriginCookieKey,
      // The observer first, then the durable record: the observer is what
      // stops this applier's own inserts from handing the keys straight back
      // to the desktop, and the record is what lets the sending host update
      // them again later.
      //
      // The applier calls neither for a write bound for the ephemeral jar,
      // which is why both may write the durable ledger unconditionally.
      claimHeadlessOriginKeys: async (keys) => {
        noteBrowserPrimaryProfileAppliedKeys(keys);
        await recordHeadlessOriginCookieKeys(keys);
      },
      // The mirror image, for the keys Chromium refused: the observer mark
      // first (no insert is coming to spend it), then the durable claim.
      releaseHeadlessOriginKeys: async (keys) => {
        forgetBrowserPrimaryProfileAppliedKeys(keys);
        await releaseHeadlessOriginCookieKeys(keys);
      },
      getTargetJar,
      serializeOnDomain: (domain, action) =>
        jarSerializer.runOnDomain(domain, action),
      governor: observedConnections,
    });
    traceBrowserObservedProfile(result, {
      source: observed.source,
      hostId: observed.hostId,
      connectionId: observed.connectionId,
      governor: observedConnections,
    });
    return result;
  };
  /** The shared `primary` jar an observed frame always merges into. */
  const primaryProfileTarget = (): BrowserObservedProfileTarget => {
    const partition = partitionForProfile(
      PRIMARY_PROFILE_REQUEST.profile,
      PRIMARY_PROFILE_REQUEST.sessionId,
    );
    return {
      session: ensureBrowserViewSessionForPartition(partition),
      durableJar: partition === BROWSER_VIEW_PARTITION,
    };
  };
  const manager = new BrowserViewManager({
    attachRendererGuest: (windowId, request) =>
      requestRendererGuestMount(bridge, windowId, request),
    releaseRendererGuest: (registrationId, windowId) => {
      requestRendererGuestRelease(bridge, registrationId, windowId);
    },
    getWindow: (windowId) =>
      toBrowserViewWindow(
        bridge.windowRegistry.getRecordById(windowId)?.window,
      ),
    localHostId: () => bridge.options.host.getSnapshot()?.hostId ?? null,
    createPopupWindowOptions: () => createBrowserPopupWindowOptions(),
    createPopupWindow: (input) => createBrowserPopupWindow(input),
    createDevToolsWindow: (windowId) =>
      createBrowserDevToolsWindow(bridge, windowId),
    registerPopupWebContents: (webContents) => {
      registerBrowserViewWebContents(webContents);
    },
    onDownloadChange: onBrowserViewDownloadChange,
    onCertificateError: onBrowserViewCertificateError,
    onWindowChange: (listener) => {
      bridge.windowRegistry.on("change", listener);
      return () => {
        bridge.windowRegistry.off("change", listener);
      };
    },
    notifyHostWindowRendererReset: (windowId) => {
      bridge.markRendererUnavailable(windowId);
      // The renderer's tab bindings die with it, so the host-side rebind is
      // inevitable; keeping the streams warm would need a snapshot replay into
      // the fresh renderer and new state every forget path must keep in step.
      // This reproduces what a renderer-owned socket did.
      sessions.closeWindow(windowId);
    },
    send: (windowId, channel, payload) =>
      bridge.safeSendToWindow(windowId, channel, payload),
    seedStorageState: async (input, webContents) => {
      if (input.seedStorageState === null) return null;
      // The seed's CLAIM. An observed frame names the domain it speaks for and
      // is checked against it; a seed names nothing, so the tab it is being
      // handed to is the claim - the one fact about this write that no sender
      // chose. A tab with no registrable site (`about:blank`, a bare IP form
      // the list cannot place) has no scope to seed into.
      const scope = registrableDomainForUrl(input.requestedUrl);
      if (scope === null) return null;
      // The localStorage half takes the SAME scope, and needs it more than the
      // cookies do: the seed script does `localStorage.clear()` on any origin
      // it matches, so an unfiltered seed hands one tab the authority to wipe
      // and rewrite local state for every site in the host's snapshot.
      const origins = input.seedStorageState.origins.filter(
        (origin) => registrableDomainForUrl(origin.origin) === scope,
      );
      const result = await applyHostContributedCookies(
        {
          source: "seed",
          // The STREAM's connection, same provenance an observed frame
          // carries, because both watermarks the applier reads are keyed by
          // it: the forget ledger's per-connection ack (a synthetic id has
          // acked nothing, so one forget would refuse every later seed
          // forever) and the observed replay budget. Off-connection there is
          // no ack to find, and the gate refusing is the safe direction.
          connectionId:
            input.connectionId ?? `seed:${input.hostId}:${input.sessionId}`,
          hostId: input.hostId,
          domain: scope,
          cookies: input.seedStorageState.cookies,
        },
        // The guest's OWN jar, not the resolved `primary` one: an isolated
        // guest is on a throwaway partition, and the custody marks the applier
        // records are only meaningful for the durable jar.
        () => ({
          session: webContents.session,
          durableJar:
            webContents.session ===
            ensureBrowserViewSessionForPartition(BROWSER_VIEW_PARTITION),
        }),
      );
      // One verdict for the whole seed. The frame-level refusals are the ones
      // that mean "this write may not land at all" - above all `ledger-unacked`,
      // where the user forgot this site and the sending connection has not
      // acked pruning it. Seeding the localStorage of a site whose cookies were
      // just refused would restore by another door exactly what the forget
      // removed.
      if (result.outcome !== "applied") return null;
      // The localStorage half has no per-key merge: installing it runs
      // `clear()` and rewrites the whole origin, which is a DESTRUCTIVE write
      // however add-only the cookie half was. Two shapes therefore refuse it,
      // and both are about what the desktop already owns rather than about
      // what happened to land:
      //
      //  - Any cookie of this seed was refused as `owned-by-desktop`. That
      //    names a site the user's own browsing signed into on this machine,
      //    so its localStorage is the desktop's too - and one unrelated cookie
      //    landing beside the refusal does not buy the right to clear it.
      //  - Nothing landed at all, a seed carrying no cookies included. Then
      //    nothing establishes that this host has anything to say about the
      //    origin, and a clear-and-rewrite would be an arbitrary overwrite of
      //    whatever the desktop holds - the same resurrection by another door
      //    the ledger gate exists to stop.
      //
      // The cost is a localStorage-only login on a cookie-less site never
      // carrying over, which is the fail-closed half of a channel that is
      // add-only by construction (universal-sign-in decision 8).
      if (result.ownedByDesktopCookies > 0 || result.appliedCookies === 0) {
        return null;
      }
      // Retained only for a seed that LANDED, and after the verdict rather
      // than before it. These origins are what a quit capture reads
      // localStorage from and ships to the host, so retaining them for a
      // refused seed hands the forgotten site straight back by the capture
      // door - the one door the ledger gate cannot see. What it costs is
      // nothing: a refused seed wrote no localStorage for the capture to find.
      //
      // Isolated guests are never seeded (the host forces `seedStorageState`
      // to null at the placement seam), so nothing throwaway enters here.
      primaryProfileSnapshots.retainSeededOrigins({ cookies: [], origins });
      return { cookies: [], origins };
    },
    observePrimaryProfileOrigin: (url, webContents, profile) => {
      // The primary capture reads the shared jar only. An isolated partition's
      // origins must never enter it - the cookie-change observer takes the
      // same early return before it attaches to a partition.
      if (profile !== "primary") return;
      primaryProfileSnapshots.observe(url, webContents);
    },
    releaseSessionStorage: (request) => {
      void releaseBrowserViewSession(
        partitionForProfile(request.profile, request.sessionId),
      ).catch((error: unknown) => {
        log.warn("[browser-view] isolated session release failed", {
          sessionId: request.sessionId,
          error: describeLogError(error),
        });
      });
    },
    hostPlatform: hostPlatformFromProcessPlatform(process.platform),
  });

  /**
   * Forgets this machine recorded but never finished clearing, re-run at
   * startup.
   *
   * The ledger is written BEFORE the jar is touched, deliberately - that is
   * what refuses an in-flight observation for a site the user just deleted -
   * so a crash in between leaves the ledger claiming a login is gone while the
   * jar still serves it. The jar is the master, so the next whole-jar capture
   * would teach every host the login back, and no host-side prune undoes that.
   *
   * Idempotent by construction: emptying a site twice is emptying it. It runs
   * through the same jar serializer as every other clear, so nothing this
   * process does later can slip underneath it, and the whole-jar capture waits
   * on it explicitly - that is the one jar read that does not queue here.
   */
  const forgetLedgerReconciled = (async (): Promise<void> => {
    const pending = browserForgetLedgerPendingClears();
    const forgetAll = pending.forgetAll;
    if (forgetAll === null && pending.domains.length === 0) return;
    log.warn("[browser-view] re-running forgets that did not finish clearing", {
      forgetAll: forgetAll !== null,
      domains: pending.domains.length,
    });
    try {
      if (forgetAll !== null) {
        await forgetEveryBrowserLogin();
        await markBrowserForgetLedgerCleared(forgetAll.revision);
      }
      // Each entry marked with ITS OWN revision, as it completes. Marking the
      // ledger's top instead added a number no completion could ever produce,
      // and the contiguous drain then never advanced past the gap - so every
      // launch re-ran the same forget, forever.
      for (const entry of pending.domains) {
        await jarSerializer.runOnDomain(entry.domain, () =>
          clearBrowserSiteEverywhere(entry.domain),
        );
        await markBrowserForgetLedgerCleared(entry.revision);
      }
    } catch (error) {
      // Left pending on purpose: the next launch tries again, and until it
      // succeeds the ledger keeps telling every host to prune these sites.
      log.warn("[browser-view] re-running an unfinished forget failed", {
        error: describeLogError(error),
      });
    }
  })();

  /**
   * Every whole-jar capture, read as the ledger says the jar WILL be: a site
   * whose forget is recorded but whose clear has not run yet is left out,
   * and an uncleared forget-all empties it. The boot reconciliation above
   * closes the gap a crash leaves; this closes the one a queue leaves, which
   * the reconciliation cannot reach: the clear a forget queued behind a
   * login import's barrier runs after the import's own push, and that push
   * reads from inside the barrier. See `withoutUnclearedForgets`.
   *
   * The reconciliation itself is NOT awaited in here, and the two lanes
   * below await it before calling this. The behind-barrier lane holds the
   * serializer's read lease for as long as its callback runs, and the
   * reconciliation drives its own clears through that serializer: a lease
   * parked on the reconciliation would have a forget-all requested
   * meanwhile wait on the read, the read wait on the reconciliation, and
   * the reconciliation's `runOnDomain` wait on the forget-all's gate - a
   * cycle only the barrier timer would break.
   */
  const captureLedgeredPrimaryProfile =
    async (): Promise<BrowserPrimaryProfileCaptureResult> => {
      // Bracketing the read, which does not queue on the serializer: a site
      // clear that records, clears and marks itself while the cookies are
      // being read would be in neither a mask taken before (not recorded
      // yet) nor one taken after (already cleared), while the read still
      // holds the cookie it removed. The bracket accumulates every forget
      // recorded while it is open, apart from the ledger's trimmed rows.
      const bracket = bracketUnclearedForgets();
      try {
        const captured = await primaryProfileSnapshots.capture();
        return withoutUnclearedForgets(captured, bracket.close());
      } finally {
        // A read that threw still ends its bracket (`close` is idempotent).
        bracket.close();
      }
    };

  /**
   * The jar plane's own streams. Everything cookie-bearing on
   * `browser.sessions` is produced and consumed right here, beside the jar it
   * is about; the renderer says which streams should exist and sees a
   * cookie-free projection of them.
   */
  /**
   * The jar plane's principal, and the ONE reading of it.
   *
   * A signed-in session whose bearer main VERIFIED itself, never one a renderer
   * merely declared. `authSessionSet` is shape-checked and reachable from any
   * code running in a renderer, so an XSS could push an attacker's token and
   * profile and this process would dial the attacker's host and answer a
   * capture with the user's whole jar. Everything the plane speaks for - the
   * dial, the relay attach grant, the store-key wrap, the forget ledger's
   * per-user match - reads from here, so an unverified session is not a
   * degraded principal but no principal at all.
   */
  const jarPlanePrincipal = (): {
    readonly token: string;
    readonly userId: string;
  } | null => {
    const snapshot = bridge.authSession.get();
    const token = snapshot.token;
    const profile = snapshot.profile;
    if (!snapshot.verified || token === null || profile === null) return null;
    return { token, userId: profile.userId };
  };

  const browserSessionsDirectory = createBrowserSessionsHostDirectory({
    authnBaseUrl: () => bridge.options.authnBaseUrl,
    relayBaseUrl: config.relayBaseUrl,
    localHost: () => {
      const snapshot = bridge.options.host.getSnapshot();
      if (snapshot === null) return null;
      return {
        hostId: snapshot.hostId,
        websocketUrl: snapshot.websocketUrl,
        version: snapshot.version,
      };
    },
    bearerToken: () => jarPlanePrincipal()?.token ?? null,
    listRegisteredHosts: fetchRegisteredHostsViaHttp,
    now: () => Date.now(),
  });
  const sessions = new BrowserSessionsRegistry({
    directory: browserSessionsDirectory,
    openTransport: (target, userId) =>
      openBrowserSessionsTransport(target, userId, {
        authnBaseUrl: () => bridge.options.authnBaseUrl,
        endpoint: () => browserSessionsDirectory.endpoint(target.hostId),
        bearer: () => {
          const principal = jarPlanePrincipal();
          if (principal === null) return null;
          return {
            getBearerToken: () => principal.token,
            identity: { userId: principal.userId },
          };
        },
        appVersion: app.getVersion(),
      }),
    jar: {
      // Behind the boot reconciliation, and it is the ONE jar read that has
      // to be: every write queues on the jar serializer, but a whole-jar
      // capture does not, and a capture taken before an unfinished forget
      // was re-run would upload to the host exactly the logins the user
      // deleted. The same hole exists at runtime for a forget recorded
      // while its clear is still queued (behind a login import's barrier,
      // typically), and the reconciliation cannot close that one - the
      // import's own push reads from inside the barrier the clear waits
      // on - so the capture is read as the ledger says the jar will be:
      // `captureLedgeredPrimaryProfile`.
      capturePrimaryProfile: async () => {
        await forgetLedgerReconciled;
        return await captureLedgeredPrimaryProfile();
      },
      // A HOST-issued whole-jar read - and the final capture at a window's
      // close or quit - runs behind any whole-jar barrier, holding the
      // serializer's read lease through the read so no barrier can open
      // under it: taken while the login import writes site by site, it
      // would carry some sites imported and some not, and the host would
      // hold that hybrid until the next capture. The import's own push,
      // inside its barrier, goes straight to the jar.
      //
      // The reconciliation is awaited BEFORE the lease, never under it: it
      // re-runs unfinished forgets through this same serializer, and a
      // lease held across it is a cycle with any barrier requested
      // meanwhile (see `captureLedgeredPrimaryProfile`). `waitMs` bounds
      // the barrier wait alone; the reconciliation is boot work that is
      // over long before a close or a host's ask, and a quit that lands
      // during it waits for it, which is the shell's own budget's to bound.
      capturePrimaryProfileBehindBarrier: async (waitMs) => {
        await forgetLedgerReconciled;
        const read = await jarSerializer.readBehindBarrier(
          captureLedgeredPrimaryProfile,
          waitMs,
        );
        return read.ok ? read.value : null;
      },
      applyObservedProfile: async (observed) => {
        await applyHostContributedCookies(
          { source: "observed", ...observed },
          primaryProfileTarget,
        );
      },
      wrapStoreKey,
      unwrapStoreKey,
      attestDesktopIdentity,
      readForgetLedger: browserForgetLedgerDigestForHost,
      recordForgetLedgerAck,
      releaseForgetLedgerConnection: releaseBrowserForgetLedgerConnection,
      onForgetLedgerChanged: onBrowserForgetLedgerChanged,
      onPrimaryProfileDelta: (listener) => {
        const stop = onBrowserPrimaryProfileDelta(listener);
        return { dispose: stop };
      },
    },
    tabs: manager,
    // Main's own answer to "who is signed in", never the renderer's - and
    // only once main has verified the bearer that says so.
    userId: () => jarPlanePrincipal()?.userId ?? null,
    localHostId: () => bridge.options.host.getSnapshot()?.hostId ?? null,
    subscribeLocalHostChange: (listener) => {
      bridge.options.host.on("change", listener);
      return () => {
        bridge.options.host.off("change", listener);
      };
    },
    // Every bearer this process is handed. The renderer refreshes the
    // credential and pushes the result here (`authSessionSet`), which is the
    // only rotation signal main gets - and the only thing that reopens a jar
    // stream the host closed at the old token's expiry.
    //
    // It fires on a change to an UNVERIFIED session too, which is what makes
    // one read as a sign-out here: `userId()` answers null, so the streams
    // tear down rather than carrying on under a principal main cannot vouch
    // for.
    subscribeBearerRotation: (listener) => {
      const onChange = (): void => {
        listener();
      };
      bridge.authSession.on("change", onChange);
      return () => {
        bridge.authSession.off("change", onChange);
      };
    },
    emit: (windowId, envelope) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.browserViewSessionsEvent,
        envelope,
      );
    },
  });

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewSessionsOpen,
    (event, payload) => {
      sessions.open(
        readSenderWindowId(bridge, event),
        browserViewIpcPayload.sessionsStreamKey.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewSessionsClose,
    (event, payload) => {
      sessions.close(
        readSenderWindowId(bridge, event),
        browserViewIpcPayload.sessionsStreamKey.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewSessionsSend,
    (event, payload) => {
      const input = browserViewIpcPayload.sessionsStreamSend.parse(payload);
      sessions.send(readSenderWindowId(bridge, event), input.key, input.frame);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewAttachSurface,
    (event, payload) => {
      const attached = manager.attachSurface(
        readSenderWindowId(bridge, event),
        browserViewIpcPayload.attachSurface.parse(payload),
      );
      if (!attached) throw new Error("Electron browser tab is not available.");
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewDetachSurface,
    (event, payload) => {
      manager.detachSurface(
        readSenderWindowId(bridge, event),
        browserViewIpcPayload.detachSurface.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewControlElectronTab,
    async (event, payload) => {
      const controlled = await manager.controlElectronTab(
        readSenderWindowId(bridge, event),
        browserViewIpcPayload.electronTabControl.parse(payload),
      );
      if (!controlled)
        throw new Error("Electron browser tab is not available.");
    },
  );

  // BT-302/BT-303: the renderer is the source of truth for the guest-focused
  // input policy - which chords outrank guest keystrokes and what each one
  // means. It pushes the whole table at startup.
  bridge.handleInvoke(
    RunnerHostInvoke.browserViewSetReservedChords,
    (_event, payload) => {
      manager.chords.setReservedChords(parseReservedChords(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewFindInPage,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.find.find(
        windowId,
        browserViewIpcPayload.findRequest.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewStopFindInPage,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.find.stop(
        windowId,
        browserViewIpcPayload.findStop.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewCancelDownload,
    (_event, payload) => {
      cancelBrowserViewDownload(
        browserViewIpcPayload.downloadCancel.parse(payload).downloadId,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewTrustCertificate,
    async (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      const input = browserViewIpcPayload.certificateTrust.parse(payload);
      if (!manager.canTrustCertificateError(windowId, input)) {
        throw new Error(
          "Browser certificate error is not active for this tile",
        );
      }
      const pending = readBrowserViewPendingCertificateError(
        input.certificateErrorId,
      );
      if (pending === null) {
        throw new Error("Browser certificate error is no longer pending");
      }
      // Trusting a certificate durably widens what this machine accepts as
      // that hostname, so main asks rather than taking the renderer's word for
      // it. The hostname is the pending record's, not the caller's - the
      // caller named an error id.
      if (
        !(await confirmDestructiveInMain({
          title: "Trust this certificate?",
          message: `Always trust the certificate for ${pending.hostname}?`,
          detail:
            "This machine will accept it for that site from now on, including in other apps that read the system trust store.",
          confirmLabel: "Trust",
        }))
      ) {
        log.info("[browser-view] certificate trust was not confirmed");
        return;
      }
      await trustBrowserCertificate(pending.hostname, pending.certificate);
      clearBrowserViewPendingCertificateError(input.certificateErrorId);
      manager.clearCertificateError(windowId, input);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewCapturePage,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.capturePage(
        windowId,
        browserViewIpcPayload.tileKey.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewGetDebugSnapshot,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.getDebugSnapshot(
        windowId,
        browserViewIpcPayload.tileKey.parse(payload),
      );
    },
  );

  // "Clear cookies for this site" (spec §6.5). The manager derives the site
  // from the tile's own current URL; the jars are the shared `primary` ones,
  // which are the only jars a tile menu may reach. A tile with no site to name
  // - a private session, or a non-http(s) page - has nothing to clear.
  //
  // No suppression here: the removals fire the durable jar's own change events,
  // which coalesce into the single delta that tells the host the slice is empty.
  /**
   * "Sign me out of this site", whichever door asked for it: the tile menu and
   * one row of Settings > Browser. THREE steps, in this order, and the order is
   * the correctness argument.
   *
   * The LEDGER first, before the jar is touched and before the clear is even
   * queued: the revision it bumps is what refuses observations for this site
   * from every host that has not yet acked pruning it, so bumping after the
   * clear would leave exactly the window a stale in-flight observation walks
   * through. Then the local jar, queued on the site like every other write to
   * it, so an observed sign-in for the same domain cannot land in the middle of
   * the clear and put back what it is removing. Only then is the clear marked
   * complete.
   *
   * No host frame goes out from here, and none is needed: the ledger write
   * fires the change that pushes a fresh digest onto every live stream, which
   * reaches the hosts that are attached AND the ones that come back later. The
   * Settings row used to send `clearSite` to the attached hosts and do none of
   * these three, so it cleared other machines while this one's jar kept the
   * cookies and the next capture taught them all back.
   */
  const clearOneSavedLoginSite = async (domain: string): Promise<void> => {
    const revision = await recordForgottenBrowserSite(domain);
    await jarSerializer.runOnDomain(domain, () =>
      clearBrowserSiteEverywhere(domain),
    );
    await markBrowserForgetLedgerCleared(revision);
    log.info("[browser-view] cleared cookies for one site", { domain });
  };

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewClearSite,
    async (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      const domain = manager.readClearSiteTarget(
        windowId,
        browserViewIpcPayload.tileKey.parse(payload),
      );
      if (domain === null) return;
      // Confirmed for the same reason its two siblings are, and it was the one
      // that was not: a compromised renderer could navigate a tile it owns to
      // any site and then call this, signing the user out of it on every
      // machine with nothing on screen. The tile names the tile; MAIN names the
      // domain in the copy, from the tile's own current URL.
      if (!(await confirmDestructiveInMain(clearSiteConfirmation(domain)))) {
        log.info("[browser-view] clearing one site was not confirmed");
        return;
      }
      await clearOneSavedLoginSite(domain);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewStartAnnotation,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.annotations.start(
        windowId,
        browserViewIpcPayload.annotationStart.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewCancelAnnotation,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.annotations.cancel(
        windowId,
        browserViewIpcPayload.tileKey.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewSetAnnotationTargetChatLabel,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.annotations.setTargetChatLabel(
        windowId,
        browserViewIpcPayload.annotationTargetChatLabel.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewAnnotationAttachResult,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.annotations.reportAttachResult(
        windowId,
        browserViewIpcPayload.annotationAttachResult.parse(payload),
      );
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.browserViewSaveLoginsGet, () =>
    isBrowserSavedLoginsEnabled(),
  );

  // Toggling just switches which jar `primary` guests are born into and brings
  // the live tiles back on it at the same URL. Nothing is copied either way:
  // turning saving off leaves the `persist:` jar on disk untouched (that is
  // what "Forget all" is for), and turning it back on drops the in-memory one.
  bridge.handleInvoke(
    RunnerHostInvoke.browserViewSaveLoginsSet,
    async (_event, payload): Promise<boolean> => {
      const enabled = browserViewIpcPayload.saveLogins.parse(payload);
      // The pref flip takes the whole-jar barrier: the login import writes
      // the durable jar only while saving is ON and re-reads the pref inside
      // its own barrier, so a toggle can no longer slip between that read and
      // the write. The pref only - the tab recreation below runs outside, as
      // it must not queue jar work behind a gate it is itself holding. A
      // toggle confirmed while an import holds the barrier waits its budget
      // and then fails, and is retried after.
      const settled = await jarSerializer.runOnEveryDomain(
        () => setBrowserSavedLoginsEnabled(enabled),
        BARRIER_ACTION_TIMEOUT_MS,
      );
      // Open the target jar first, so the recreated guests attach to an
      // already-hardened session.
      ensureBrowserViewSession(PRIMARY_PROFILE_REQUEST);
      await manager.recreateNativeTabsOnCurrentPartition();
      return settled;
    },
  );

  // The desktop half of "forget all browser logins" (spec §6.5). Driven by
  // Settings, alongside the `forgetLogins` frame each connected host answers by
  // shredding its own slice - and no longer by a fan-out from the host, which
  // was retired because it could only ever reach the hosts that happened to be
  // attached. See {@link forgetEveryBrowserLogin} for the delta-observer
  // suppression this runs under.
  //
  // The order is the whole correctness argument. The LEDGER is written first,
  // before a single cookie goes: its revision is what refuses in-flight
  // observations for every site at once, and it is what a host that was
  // disconnected here prunes from when it comes back. Then the localStorage
  // coordinator is reset before the tiles come back, so a recreated tile cannot
  // be re-seeded from an origin remembered pre-forget, and the tiles are
  // recreated last, at their current URLs.
  bridge.handleInvoke(
    RunnerHostInvoke.browserViewForgetLogins,
    async (): Promise<boolean> => {
      // Main decides, not the renderer: this is the single most destructive
      // action the browser surface has, and it was reachable from any code
      // running in a renderer. The
      // renderer may ASK; a native dialog the renderer cannot draw over or
      // dismiss is what turns the ask into a decision. Before the ledger
      // write, because that is the first irreversible step - it tells every
      // host to prune.
      if (!(await confirmDestructiveInMain(FORGET_ALL_LOGINS_CONFIRMATION))) {
        log.info("[browser-view] forget-all was not confirmed");
        return false;
      }
      const revision = await recordForgetAllBrowserLogins();
      await forgetEveryBrowserLogin();
      // Only once the jars are actually empty. Recorded after rather than with
      // the forget, so a crash in between leaves the clear pending and the
      // next launch re-runs it.
      await markBrowserForgetLedgerCleared(revision);
      // The host frames go out from HERE, not from a renderer: the
      // stream is main's, and a `forgetLogins` frame shreds the sending
      // account's whole slice on that host. A cancelled dialog therefore
      // cannot reach a host at all, rather than relying on a renderer to
      // honour the verdict it was told.
      const hosts = sessions.forgetLoginsOnEveryHost();
      log.info("[browser-view] told the connected hosts to forget", { hosts });
      return true;
    },
  );

  // "Clear" on one row of Settings > Browser. Confirmed here for the same
  // reason forget-all is: a renderer looping the saved-sites list used to
  // reproduce forget-all one domain at a time with no dialog at all. The
  // frame is main's now, so the loop has nothing to send.
  bridge.handleInvoke(
    RunnerHostInvoke.browserViewClearSavedLoginSite,
    async (_event, payload): Promise<boolean> => {
      const domain = browserViewIpcPayload.savedLoginSite.parse(payload).domain;
      if (!(await confirmDestructiveInMain(clearSiteConfirmation(domain)))) {
        log.info("[browser-view] clearing one saved login was not confirmed");
        return false;
      }
      await clearOneSavedLoginSite(domain);
      return true;
    },
  );
  // Import logins from another browser. Every handler answers a result value
  // and never rejects: a rejected invoke's message is logged at WARN and
  // forwarded to Sentry, and nothing on this path - a profile path, a
  // keychain's answer, a cookie - may travel that way. The service holds the
  // paths; the renderer sees opaque ids and registrable domains only.
  // The import's jar write takes the same barrier forget-all does: it
  // touches many sites at once, and a forget confirmed while it runs must
  // wait for it rather than be marked complete under a write that then puts
  // the logins back.
  const loginImport = createLoginImportService({
    serializeJarWrite: (action) =>
      jarSerializer.runOnEveryDomain(
        action,
        LOGIN_IMPORT_JAR_BARRIER_TIMEOUT_MS,
      ),
    // The localStorage half of a site clear, on the durable jar the import
    // writes, followed by the same coordinator prune the site clear does -
    // without it the next capture ships the origins just emptied back to
    // the host. The durable jar only: the import refuses when saving is
    // off, and with it on the durable jar IS the jar the tiles are on.
    clearSiteLocalStorage: async (site, signal) => {
      await clearBrowserSiteLocalStorage(
        site,
        ensureBrowserViewSessionForPartition(BROWSER_VIEW_PARTITION),
        rememberedClearSiteOrigins,
        signal,
      );
      primaryProfileSnapshots.forgetOriginsUnder(site);
    },
    // The push is main's, exactly like forget-all's frames: a renderer may
    // not mint a jar frame at all. It is needed at all because the import
    // writes with the delta observer muted - the coalesced deltas that carry
    // an ordinary sign-in never fire for it, so without this capture the
    // hosts would not see the imported logins until something else asked
    // for one. Made by the import INSIDE its barrier, so a saved-logins
    // toggle queued behind the import cannot move the capture's jar first.
    // Never rejects: a stream whose capture threw must not turn a committed
    // import into a rejected invoke that the user retries and Sentry
    // records. Zero hosts is an honest answer here - the next capture
    // carries the logins.
    pushJarToHosts: async () => {
      try {
        return await sessions.capturePrimaryProfileOnEveryHost();
      } catch (error) {
        log.warn("[browser-view] pushing the imported logins failed", {
          error: describeLogError(error),
        });
        return 0;
      }
    },
  });

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewLoginImportListSources,
    (): Promise<readonly LoginImportSource[]> => loginImport.listSources(),
  );

  // The native file dialog runs in main so the renderer never names a path;
  // the picked file is registered under an opaque id like every other source.
  // A dialog that cannot be shown answers like a cancelled one: there is no
  // file, and the OS's reason is not for the renderer or the log.
  bridge.handleInvoke(
    RunnerHostInvoke.browserViewLoginImportPickFile,
    async (event): Promise<LoginImportSource | null> => {
      try {
        const windowId = bridge.resolveSenderWindowId(event);
        const parentWindow =
          windowId === null
            ? undefined
            : bridge.windowRegistry.getRecordById(windowId)?.window;
        const options = {
          title: "Import logins from a cookie file",
          properties: ["openFile" as const],
          filters: [
            { name: "Cookie exports", extensions: ["txt", "json"] },
            { name: "All files", extensions: ["*"] },
          ],
        };
        const result = isElectronBrowserWindow(parentWindow)
          ? await dialog.showOpenDialog(parentWindow, options)
          : await dialog.showOpenDialog(options);
        const picked = result.canceled ? undefined : result.filePaths[0];
        if (picked === undefined) return null;
        const path = normalizePickedFilePath(picked);
        if (path === null) return null;
        return await loginImport.registerFile(path);
      } catch {
        return null;
      }
    },
  );

  // Payloads are validated with `safeParse`, unlike the neighbours above: a
  // malformed payload here must come back as a blocked result too, because
  // the bridge promises these calls never reject.
  bridge.handleInvoke(
    RunnerHostInvoke.browserViewLoginImportScan,
    (_event, payload): Promise<LoginImportScan> => {
      const parsed = browserViewIpcPayload.loginImportScan.safeParse(payload);
      return loginImport.scan(parsed.success ? parsed.data.sourceId : "");
    },
  );

  // The service's answer is the whole answer, the push to the hosts included:
  // it is made inside the import's barrier (see `pushJarToHosts` above).
  bridge.handleInvoke(
    RunnerHostInvoke.browserViewLoginImportRun,
    (_event, payload): Promise<LoginImportResult> => {
      const parsed = browserViewIpcPayload.loginImportRun.safeParse(payload);
      return loginImport.import(
        parsed.success
          ? parsed.data
          : {
              sourceId: "",
              scanId: "",
              domains: [],
              includeDeviceBound: false,
            },
      );
    },
  );

  bridge.disposeFns.push(() => {
    sessions.dispose();
    manager.dispose();
    clearAllAttachmentGrants();
  });
  return { manager, sessions };
}

export function requestRendererGuestMount(
  bridge: RunnerIpcBridge,
  windowId: string,
  input: {
    readonly partition: string;
    readonly onAttached: (guest: WebContents) => Promise<void>;
  },
): BrowserViewGuestAttachResult {
  const granted = mintAttachmentGrant({
    windowId,
    partition: input.partition,
    onAttached: input.onAttached,
    onExpired: (release) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.browserViewGuestReleaseRequested,
        release,
      );
    },
  });
  bridge.safeSendToWindow(
    windowId,
    RunnerHostEvent.browserViewGuestMountRequested,
    granted.mount,
  );
  return {
    registrationId: granted.mount.registrationId,
    ready: granted.ready,
  };
}

export function requestRendererGuestRelease(
  bridge: RunnerIpcBridge,
  registrationId: string,
  windowId: string,
): void {
  // The grant may already be gone (the guest's own `destroyed` listener drops
  // it first), so the release IPC is sent unconditionally - the renderer's
  // handler is idempotent, and without it the `<webview>` wrapper leaks.
  releaseAttachmentGrant(registrationId);
  bridge.safeSendToWindow(
    windowId,
    RunnerHostEvent.browserViewGuestReleaseRequested,
    { registrationId },
  );
}

// Chrome-only: the popup ADOPTS the contents Chromium pre-created (see
// createBrowserPopupWindow), and passing `webPreferences` alongside an adopted
// `webContents` is rejected by Electron - the adopted contents already carry
// the opener's hardened prefs, partition and session. That inheritance is the
// fix: it is what preserves `window.opener` and the login the popup's OAuth/SSO
// flow relays through.
function createBrowserPopupWindowOptions(): BrowserWindowConstructorOptions {
  return {
    show: true,
    width: 900,
    height: 700,
    backgroundColor: "#0b0b0d",
    // A native child of a fullscreen BrowserWindow inherits macOS's
    // fullscreen space. Closing that child can leave the owning window's
    // compositor black, so arbitrary web popups must remain top-level native
    // windows. Chromium still retains the original window.opener relationship.
    fullscreen: false,
    fullscreenable: false,
    modal: false,
    kiosk: false,
  };
}

// Adopts `createWindowOptions.webContents` - the popup contents Chromium
// already created - instead of letting `new BrowserWindow` mint fresh ones.
// Adopting is what carries `window.opener` and the inherited session into the
// popup, so a nested OAuth "add account" popup still has the channel it relays
// its params through.
function createBrowserPopupWindow(input: {
  readonly windowOptions: BrowserWindowConstructorOptions;
  readonly createWindowOptions: BrowserViewPopupCreateWindowOptions;
}): BrowserViewPopupWindow {
  const adopted = input.createWindowOptions.webContents;
  const options: BrowserViewPopupCreateWindowOptions =
    adopted === undefined
      ? input.windowOptions
      : { ...input.windowOptions, webContents: adopted };
  return new BrowserWindow(options);
}

function createBrowserDevToolsWindow(
  bridge: RunnerIpcBridge,
  windowId: string,
): BrowserWindow {
  const parentWindow = bridge.windowRegistry.getRecordById(windowId)?.window;
  return new BrowserWindow({
    parent: isElectronBrowserWindow(parentWindow) ? parentWindow : undefined,
    show: true,
    width: 1200,
    height: 800,
    backgroundColor: "#0b0b0d",
    fullscreenable: false,
  });
}

function isElectronBrowserWindow(
  value: IpcManagedWindow | undefined,
): value is BrowserWindow {
  return value instanceof BrowserWindow;
}

function toBrowserViewWindow(
  value: IpcManagedWindow | undefined,
): BrowserViewWindow | null {
  if (!isElectronBrowserWindow(value)) return null;
  return {
    webContents: value.webContents,
    isDestroyed: () => value.isDestroyed(),
  };
}

const FORGET_ALL_LOGINS_CONFIRMATION: MainConfirmation = {
  title: "Remove all website sessions?",
  message: "Remove every saved website session?",
  detail:
    "Open Traycer browser tabs reload signed out, and agent sessions using them may be interrupted. This cannot be undone.",
  confirmLabel: "Remove all",
};

function clearSiteConfirmation(domain: string): MainConfirmation {
  return {
    title: "Remove this website session?",
    message: `Remove the saved session for ${domain}?`,
    detail:
      "Traycer removes its session data from the shared collection. You may be signed out on connected Traycer hosts. Other sites are untouched.",
    confirmLabel: "Remove",
  };
}

function readSenderWindowId(
  bridge: RunnerIpcBridge,
  event: IpcMainInvokeEvent,
): string {
  const windowId = bridge.resolveSenderWindowId(event);
  if (windowId === null) {
    throw new Error("Browser view IPC sender window is not registered");
  }
  return windowId;
}
