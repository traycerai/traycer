/**
 * Desktop IPC binding for the selection authority (P1.1), following the
 * ownership-claim pattern (`ownership-ipc.ts` + `electron-preload/
 * ownership-bridge.ts`). The settled binding rules live in
 * `ipc-contracts/selection-authority-ipc.ts`; this module is their
 * implementation plus the main-process composition of the engine's ports.
 *
 * Three properties of this file are load-bearing:
 *
 *  - REPORTER IDENTITY comes from the IPC sender (`resolveSenderWindowId`),
 *    never from a payload, so no renderer can report as another window.
 *  - The ATTACH HANDLER is the contract's exact choreography: pure parses
 *    first, then EXACTLY ONE state-testing engine call per seq-parseable
 *    request - and ZERO engine calls when the seq itself does not parse. Main
 *    is single-threaded across the parse and the call, which is what makes
 *    the claim race-free without a lock.
 *  - EVENT FAN-OUT is unconditional. A window that has not attached yet is
 *    either buffering or disposed, so a blind broadcast is harmless and
 *    avoids a per-window registry that could drift from the engine's.
 */
import { app } from "electron";
import {
  parseSelectionAttachRequest,
  parseSelectionAttachSeq,
  parseSelectionEvidenceReport,
  type ActivateResult,
  type SelectionAttachResult,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  createIncrementingIncarnationIds,
  SelectionAuthorityEngineImpl,
  systemAuthorityClock,
  type AuthorityLog,
} from "@traycer-clients/shared/host-selection/selection-authority-engine";
import { fetchRegisteredHostsViaHttp } from "@traycer-clients/shared/host-client/remote-fetcher";
import { log } from "../app/logger";
import {
  RunnerHostSync,
  SelectionAuthorityChannels,
} from "../../ipc-contracts/ipc-channels";
import {
  createDesktopLocalHostEnsurePort,
  DesktopAuthorityIdentitySource,
  DesktopHostFleetSource,
  DesktopLocalHostOutageSignal,
} from "../selection/desktop-selection-ports";
import {
  DesktopPreferredHostStore,
  resolvePreferredHostFilePath,
} from "../selection/preferred-host-store";
import {
  createRegisteredHostsPublisher,
  registerRegisteredHostsBroadcast,
} from "./registered-hosts-broadcast";
import { onHostControllerStatusBroadcast } from "./host-controller-status-broadcast";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

const authorityLog: AuthorityLog = {
  debug: (message, detail) => {
    log.debug(message, detail);
  },
  warn: (message, detail) => {
    log.warn(message, detail);
  },
};

/**
 * A crashed renderer whose window survives. The attach fence already retires
 * the dead generation the moment the reloaded preload allocates its seq, but
 * a renderer that never comes back would otherwise leave its announced
 * sessions counted as LIVE forever - and a live session suppresses the death
 * counter for that host (invariant 5). So the crash is reported as a detach
 * in its own right, exactly as the binding rules require.
 */
function subscribeRenderProcessGone(
  listener: (webContentsId: number) => void,
): () => void {
  const handler = (_event: unknown, contents: { id: number }): void => {
    listener(contents.id);
  };
  app.on("render-process-gone", handler);
  return () => {
    app.off("render-process-gone", handler);
  };
}

export function registerSelectionAuthorityIpc(bridge: RunnerIpcBridge): void {
  const identity = new DesktopAuthorityIdentitySource(bridge.authSession);
  const fleet = new DesktopHostFleetSource({
    authnBaseUrl: bridge.options.authnBaseUrl,
    identity,
    authSession: bridge.authSession,
    host: bridge.options.host,
    listRegisteredHosts: fetchRegisteredHostsViaHttp,
    // Every window hears the rows this port just fetched, so the app makes ONE
    // registry request per tick instead of one per window (P4.1/F22).
    publishRegistryResponse: createRegisteredHostsPublisher(bridge),
    log: authorityLog,
  });
  const localOutage = new DesktopLocalHostOutageSignal({
    subscribe: (listener) => onHostControllerStatusBroadcast(bridge, listener),
    readStatus: () => bridge.options.hostController.getStatus(),
    log: authorityLog,
  });
  const engine = new SelectionAuthorityEngineImpl({
    fleet,
    identity,
    localHostEnsure: createDesktopLocalHostEnsurePort(
      bridge.options.hostController,
    ),
    localOutage,
    preferredStore: new DesktopPreferredHostStore(
      resolvePreferredHostFilePath(),
      authorityLog,
    ),
    clock: systemAuthorityClock,
    newIncarnationId: createIncrementingIncarnationIds(),
    log: authorityLog,
  });

  registerAttachSeqSync(bridge, engine);
  registerInvokes(bridge, engine);
  registerFleetRefresh(bridge, fleet);
  registerFanOut(bridge, engine);
  registerDetachSignals(bridge, engine);
  // The app's one registry cadence. Registered here, beside the fleet source
  // it drives, because that source is what owns the fetch's race rules.
  registerRegisteredHostsBroadcast(bridge, fleet);

  // Seed real membership. The engine already read the (empty) startup
  // snapshot; this publishes the account's fleet at a higher revision.
  void fleet.refresh();

  bridge.disposeFns.push(() => {
    engine.dispose();
    fleet.dispose();
    localOutage.dispose();
    identity.dispose();
  });
}

function registerAttachSeqSync(
  bridge: RunnerIpcBridge,
  engine: SelectionAuthorityEngineImpl,
): void {
  bridge.handleSync(RunnerHostSync.selectionAttachSeq, (event) => {
    const reporterId = bridge.resolveSenderWindowId(event);
    if (reporterId === null) {
      log.warn("[selection-ipc] attachSeq from unknown window", {});
      // A non-number tells the preload it holds no issued generation; its
      // client then answers `superseded` locally instead of presenting a seq
      // the engine never issued.
      return null;
    }
    return engine.allocateAttachSeq(reporterId);
  });
}

/**
 * The membership edge (P1.2 cold review F6). Deliberately takes no argument
 * and returns nothing: the renderer is not telling main WHAT changed - it has
 * no authority over membership - only that main's copy is now stale. Main goes
 * and reads the registry itself, publishing one atomic snapshot through the
 * ordinary fleet path, so every existing race rule (generation stamping,
 * revision monotonicity, one-snapshot-one-transaction) applies unchanged.
 *
 * Failures never reach the caller, and the containment lives in
 * `DesktopHostFleetSource.refresh()`, which is TOTAL by contract - deliberately
 * NOT duplicated here.
 *
 * The first fix put a try/catch at this handler, which was correct for this
 * path and wrong as a design: `refresh()` has THREE owners (startup's
 * fire-and-forget call, the identity-change subscription, and this invoke), and
 * wrapping one of them left the other two able to leak an unhandled rejection
 * in main. Containment belongs to whoever owns the promise, once, so the
 * guarantee cannot depend on each caller remembering. A second catch here would
 * now be unreachable, and unreachable defence reads as a live guard to the next
 * person who moves the first one.
 */
function registerFleetRefresh(
  bridge: RunnerIpcBridge,
  fleet: DesktopHostFleetSource,
): void {
  bridge.handleInvoke(
    SelectionAuthorityChannels.invoke.refreshFleet,
    (): Promise<void> => fleet.refresh(),
  );
}

function registerInvokes(
  bridge: RunnerIpcBridge,
  engine: SelectionAuthorityEngineImpl,
): void {
  bridge.handleInvoke(
    SelectionAuthorityChannels.invoke.attach,
    (event, rawRequest: unknown): SelectionAttachResult => {
      const reporterId = bridge.resolveSenderWindowId(event);
      if (reporterId === null) {
        log.warn("[selection-ipc] attach from unknown window", {});
        return { ok: false, kind: "superseded" };
      }
      // Stage 1 is a pure routing parse. A seq that does not parse cannot be
      // attributed to a generation at all, so the engine is NEVER called and
      // the attempt is state-neutral by construction.
      const attachSeq = parseSelectionAttachSeq(rawRequest);
      if (attachSeq === null) {
        return { ok: false, kind: "malformed-request", claimed: false };
      }
      const request = parseSelectionAttachRequest(rawRequest);
      if (request === null) {
        // Exactly one guarded call: for the latest unconsumed seq this
        // consumes it and retires the previous attachment, terminating the
        // generation - the same seq can never be replayed with a corrected
        // envelope.
        const claimed = engine.refuseMalformedAttach(reporterId, attachSeq);
        return { ok: false, kind: "malformed-request", claimed };
      }
      return engine.attach(reporterId, request);
    },
  );

  bridge.handleInvoke(
    SelectionAuthorityChannels.invoke.reportEvidence,
    (event, incarnationId: unknown, rawReport: unknown): void => {
      const reporterId = bridge.resolveSenderWindowId(event);
      if (reporterId === null || typeof incarnationId !== "string") return;
      const report = parseSelectionEvidenceReport(rawReport);
      if (report === null) {
        // Dropped with a debug log, never an error: a report from a
        // same-major peer that added a member must not fail the invoke.
        log.debug("[selection-ipc] unparseable evidence dropped", {
          reporterId,
        });
        return;
      }
      engine.ingestEvidence(reporterId, incarnationId, report);
    },
  );

  bridge.handleInvoke(
    SelectionAuthorityChannels.invoke.activate,
    (
      event,
      incarnationId: unknown,
      hostId: unknown,
    ): Promise<ActivateResult> => {
      const reporterId = bridge.resolveSenderWindowId(event);
      if (
        reporterId === null ||
        typeof incarnationId !== "string" ||
        typeof hostId !== "string"
      ) {
        return Promise.resolve({ ok: false, reason: "not-attached" });
      }
      return engine.activate(reporterId, incarnationId, hostId);
    },
  );
}

function registerFanOut(
  bridge: RunnerIpcBridge,
  engine: SelectionAuthorityEngineImpl,
): void {
  const subscriptions = [
    engine.onSelectionChanged((event) => {
      bridge.fanOut(SelectionAuthorityChannels.event.selectionChanged, event);
    }),
    engine.onLeasesChanged((event) => {
      bridge.fanOut(SelectionAuthorityChannels.event.leasesChanged, event);
    }),
    engine.onReattachRequired((event) => {
      bridge.fanOut(SelectionAuthorityChannels.event.reattachRequired, event);
    }),
  ];
  bridge.disposeFns.push(() => {
    for (const subscription of subscriptions) {
      subscription.dispose();
    }
  });
}

/**
 * Hard-teardown detach. Soft replacement (reload, navigation, HMR re-mount)
 * is covered by the attach claim itself, so only destruction and crashes are
 * reported here.
 */
function registerDetachSignals(
  bridge: RunnerIpcBridge,
  engine: SelectionAuthorityEngineImpl,
): void {
  let liveWindowIds = new Set(
    bridge.windowRegistry.records().map((record) => record.windowId),
  );
  const onRegistryChange = (): void => {
    const nextLiveWindowIds = new Set(
      bridge.windowRegistry.records().map((record) => record.windowId),
    );
    for (const windowId of liveWindowIds) {
      if (!nextLiveWindowIds.has(windowId)) {
        engine.reporterDetached(windowId);
      }
    }
    liveWindowIds = nextLiveWindowIds;
  };
  bridge.windowRegistry.on("change", onRegistryChange);

  const unsubscribeRenderProcessGone = subscribeRenderProcessGone(
    (webContentsId) => {
      const record =
        bridge.windowRegistry.getRecordByWebContentsId(webContentsId);
      if (record === null) return;
      engine.reporterDetached(record.windowId);
    },
  );

  bridge.disposeFns.push(() => {
    bridge.windowRegistry.off("change", onRegistryChange);
    unsubscribeRenderProcessGone();
  });
}
