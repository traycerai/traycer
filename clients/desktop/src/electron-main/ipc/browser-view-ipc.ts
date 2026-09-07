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
  // It is what makes the applier's clear-in-progress check an ordering fact instead of a read that a clear can invalidate before the merge it authorised runs.
  const jarSerializer = new BrowserJarSerializer();
  const primaryProfileSnapshots = new BrowserPrimaryProfileSnapshotCoordinator(
    (origins) =>
      captureBrowserPrimaryProfile(origins, {
        readSaveLogins: isBrowserSavedLoginsEnabled,
        getSession: () => ensureBrowserViewSession(PRIMARY_PROFILE_REQUEST),
      }),
    captureBrowserOriginLocalStorage,
  );
  const rememberedClearSiteOrigins = (): readonly string[] =>
    primaryProfileSnapshots.clearableOrigins();
  const primaryProfileJars = (): readonly Session[] => {
    const durableSession = ensureBrowserViewSessionForPartition(
      BROWSER_VIEW_PARTITION,
    );
    const activeSession = ensureBrowserViewSession(PRIMARY_PROFILE_REQUEST);
    return activeSession === durableSession
      ? [durableSession]
      : [durableSession, activeSession];
  };
  /** The first failure is re-thrown once the loop is done, so the IPC caller still learns the site was not fully cleared. */
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
   * The order is the rest of the correctness argument: the localStorage coordinator is reset before the tiles come back, so a recreated tile cannot be re-seeded from an origin.
   * Throws if any jar refused, so the caller does not record a clear that did not happen.
   */
  const forgetEveryBrowserLogin = async (): Promise<void> => {
    // Opened here, outside the suppression: the durable jar must be cleared
    // even with saved logins off or no tile opened this run, and opening it is
    // what installs the observer the suppression mutes.
    const jars = primaryProfileJars();
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
  const applyHostContributedCookies = async (
    observed: BrowserObservedProfile,
    getTargetJar: () => BrowserObservedProfileTarget,
  ): Promise<BrowserObservedProfileResult> => {
    const result = await applyBrowserObservedProfile(observed, {
      now: () => Date.now(),
      isForgottenPendingAck: isBrowserForgetLedgerPendingAck,
      isHeadlessOriginKey: isHeadlessOriginCookieKey,
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
      sessions.closeWindow(windowId);
    },
    send: (windowId, channel, payload) =>
      bridge.safeSendToWindow(windowId, channel, payload),
    seedStorageState: async (input, webContents) => {
      if (input.seedStorageState === null) return null;
      // A tab with no registrable site (`about:blank`, a bare IP form the list cannot place) has no scope to seed into.
      const scope = registrableDomainForUrl(input.requestedUrl);
      if (scope === null) return null;
      const origins = input.seedStorageState.origins.filter(
        (origin) => registrableDomainForUrl(origin.origin) === scope,
      );
      const result = await applyHostContributedCookies(
        {
          source: "seed",
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
      if (result.outcome !== "applied") return null;
      // The cost is a localStorage-only login on a cookie-less site never carrying over, which is the fail-closed half of a channel that is add-only by construction (universal-sign-in.
      if (result.ownedByDesktopCookies > 0 || result.appliedCookies === 0) {
        return null;
      }
      // Retained only for a seed that LANDED, and after the verdict rather than before it.
      // These origins are what a quit capture reads localStorage from and ships to the host, so retaining them for a refused seed hands the forgotten site straight back by the capture.
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
   * Forgets this machine recorded but never finished clearing, re-run at startup.
   * The ledger is written BEFORE the jar is touched, deliberately - that is what refuses an in-flight observation for a site the user just deleted.
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
      // Marking the ledger's top instead added a number no completion could ever produce, and the contiguous drain then never advanced past the gap.
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
   * The boot reconciliation above closes the gap a crash leaves.
   * The behind-barrier lane holds the serializer's read lease for as long as its callback runs, and the reconciliation drives its own clears through that serializer: a lease parked on.
   */
  const captureLedgeredPrimaryProfile =
    async (): Promise<BrowserPrimaryProfileCaptureResult> => {
      const bracket = bracketUnclearedForgets();
      try {
        const captured = await primaryProfileSnapshots.capture();
        return withoutUnclearedForgets(captured, bracket.close());
      } finally {
        // A read that threw still ends its bracket (`close` is idempotent).
        bracket.close();
      }
    };

  /** A signed-in session whose bearer main VERIFIED itself, never one a renderer merely declared. */
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
      // The same hole exists at runtime for a forget recorded while its clear is still queued (behind a login import's barrier, typically), and the reconciliation cannot close that one.
      capturePrimaryProfile: async () => {
        await forgetLedgerReconciled;
        return await captureLedgeredPrimaryProfile();
      },
      // The reconciliation is awaited BEFORE the lease, never under it: it re-runs unfinished forgets through this same serializer, and a lease held across it is a cycle with any barrier.
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
      // The hostname is the pending record's, not the caller's - the caller named an error id.
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

  /**
   * The LEDGER first, before the jar is touched and before the clear is even queued: the revision it bumps is what refuses observations for this site from every host that has not yet.
   * Then the local jar, queued on the site like every other write to it, so an observed sign-in for the same domain cannot land in the middle of the clear and put back what it is.
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

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewSaveLoginsSet,
    async (_event, payload): Promise<boolean> => {
      const enabled = browserViewIpcPayload.saveLogins.parse(payload);
      // The pref only - the tab recreation below runs outside, as it must not queue jar work behind a gate it is itself holding.
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

  // Then the localStorage coordinator is reset before the tiles come back, so a recreated tile cannot be re-seeded from an origin remembered pre-forget, and the tiles are recreated.
  bridge.handleInvoke(
    RunnerHostInvoke.browserViewForgetLogins,
    async (): Promise<boolean> => {
      // The renderer may ASK; a native dialog the renderer cannot draw over or dismiss is what turns the ask into a decision.
      // Before the ledger write, because that is the first irreversible step - it tells every host to prune.
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
      // A cancelled dialog therefore cannot reach a host at all, rather than relying on a renderer to honour the verdict it was told.
      const hosts = sessions.forgetLoginsOnEveryHost();
      log.info("[browser-view] told the connected hosts to forget", { hosts });
      return true;
    },
  );

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
  // Every handler answers a result value and never rejects: a rejected invoke's message is logged at WARN and forwarded to Sentry, and nothing on this path.
  // The import's jar write takes the same barrier forget-all does: it touches many sites at once, and a forget confirmed while it runs must wait for it rather than be marked complete.
  const loginImport = createLoginImportService({
    serializeJarWrite: (action) =>
      jarSerializer.runOnEveryDomain(
        action,
        LOGIN_IMPORT_JAR_BARRIER_TIMEOUT_MS,
      ),
    clearSiteLocalStorage: async (site, signal) => {
      await clearBrowserSiteLocalStorage(
        site,
        ensureBrowserViewSessionForPartition(BROWSER_VIEW_PARTITION),
        rememberedClearSiteOrigins,
        signal,
      );
      primaryProfileSnapshots.forgetOriginsUnder(site);
    },
    // It is needed at all because the import writes with the delta observer muted.
    // Made by the import INSIDE its barrier, so a saved-logins toggle queued behind the import cannot move the capture's jar first.
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

  // The native file dialog runs in main so the renderer never names a path; the picked file is registered under an opaque id like every other source.
  // A dialog that cannot be shown answers like a cancelled one: there is no file, and the OS's reason is not for the renderer or the log.
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

function createBrowserPopupWindowOptions(): BrowserWindowConstructorOptions {
  return {
    show: true,
    width: 900,
    height: 700,
    backgroundColor: "#0b0b0d",
    // Closing that child can leave the owning window's compositor black, so arbitrary web popups must remain top-level native windows.
    fullscreen: false,
    fullscreenable: false,
    modal: false,
    kiosk: false,
  };
}

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
