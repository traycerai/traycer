import { useEffect, useState } from "react";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  HostStatusUpdateOperation,
  HostStatusUpdateProgress,
} from "@traycer/protocol/host/status/index";
import {
  resolveOverviewMethodDegrade,
  type OverviewDegradeReason,
} from "@/components/settings/panels/host-overview-model";
import {
  hostServiceWriteLatches,
  newOverviewIncarnation,
  registerOverviewIncarnation,
  useHostServiceWriteLatchStore,
  UPDATE_DISPATCH_UNSEEN_TTL_MS,
  type HostUpdateDispatchSlot,
} from "@/components/settings/panels/host-service-write-latch-store";
import { useNowMs } from "@/components/settings/panels/host-settings-panel-hooks";
import { useLocalAttemptRecordObservation } from "@/hooks/host/use-local-attempt-record-observation";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useLocalHostForegroundUpdateLine } from "@/hooks/host/use-local-host-foreground-update-line";
import type { HostRpcRegistry } from "@/lib/host";
import {
  canonicalReadIsLive,
  observationFromCanonicalRead,
  type CanonicalReadHealth,
} from "@/lib/host/fleet-update/canonical-status-observation";
import {
  holdsLifecycleGate,
  isRecordObservation,
  type FleetUpdateObservation,
  type FleetUpdateView,
} from "@/lib/host/fleet-update/fleet-update-view";
import {
  deriveLegacyUpdateFacts,
  type LegacyUpdateFacts,
} from "@/lib/host/fleet-update/legacy-update-facts";
import {
  projectLocalUpdate,
  type LocalUpdateProjection,
} from "@/lib/host/fleet-update/local-update-projection";

/**
 * What a host's update story is derived from, read the same way wherever an
 * Update now is offered: Host Overview, and a page the computer lacks until it
 * is updated. Each surface calls the same queries; everything computed from
 * them lives here, so the two cannot drift onto different gates.
 */

/** The parts of a query result the update reads consume. */
interface HostUpdateQueryRead<Data> {
  readonly data: Data | undefined;
  readonly isError: boolean;
  readonly fetchStatus: "fetching" | "paused" | "idle";
  readonly isStale: boolean;
  readonly dataUpdatedAt: number;
}

type HostStatusResponse = ResponseOfMethod<HostRpcRegistry, "host.status">;
type HostInstallationResponse = ResponseOfMethod<
  HostRpcRegistry,
  "host.getInstallationInfo"
>;

/** How long an accepted install may hold the page before progress appears. */
const UPDATE_INSTALL_ACCEPTED_LATCH_MS = 60_000;

/**
 * How often this page re-reads the wall clock.
 *
 * One second, and it is a DEADLINE clock rather than a label clock: the
 * durable-record leg carries a holder probe whose proof lives five seconds
 * (`LOCAL_LIVENESS_PROOF_MS`), and the whole point of that bound is that it
 * expires while the host is unreachable — exactly when every query-derived
 * timestamp on this page has stopped advancing. A tick coarser than the proof
 * could not enforce it; a tick that only fired when something else re-rendered
 * would not fire at all in the state that matters.
 *
 * The visible consequence is that expiry lands on the first tick after the
 * deadline rather than at an exact five-second wall.
 */
const LOCAL_RECORD_TICK_MS = 1_000;

export interface HostUpdateCapabilities {
  readonly installInfo: OverviewDegradeReason | null;
  readonly updateCheck: OverviewDegradeReason | null;
  readonly updateInstall: OverviewDegradeReason | null;
}

/**
 * Whether the host can answer the update reads and writes, or what stands in:
 * `maintenanceFallback` is the scope's local-maintenance decorator, which
 * serves these over the desktop CLI lane on a host that negotiated them away.
 */
export function useHostUpdateCapabilities(
  hostId: string | null,
  maintenanceFallback: boolean,
): HostUpdateCapabilities {
  return {
    installInfo: resolveOverviewMethodDegrade(
      useHostMethodSupport(hostId, "host.getInstallationInfo"),
      maintenanceFallback,
    ),
    updateCheck: resolveOverviewMethodDegrade(
      useHostMethodSupport(hostId, "host.update.check"),
      maintenanceFallback,
    ),
    updateInstall: resolveOverviewMethodDegrade(
      useHostMethodSupport(hostId, "host.update.install"),
      maintenanceFallback,
    ),
  };
}

/**
 * What a surface's update controls say in place of themselves while THIS
 * machine's host runs in a terminal (`hostForegroundUpdateLine`); `null` for
 * any other host, which that run does not touch.
 */
export function useHostForegroundUpdateLine(
  isLocalMachine: boolean,
): string | null {
  const line = useLocalHostForegroundUpdateLine();
  return isLocalMachine ? line : null;
}

/**
 * The status read's HEALTH, carried beside its value to every consumer that
 * DISPATCHES on it. `hasLiveSource` is whether the scope is usable: an
 * unusable scope is a read with no live source behind it, whatever the cache
 * still holds.
 */
export function hostStatusReadHealth(
  statusQuery: HostUpdateQueryRead<HostStatusResponse>,
  hasLiveSource: boolean,
): CanonicalReadHealth {
  return {
    isError: statusQuery.isError,
    fetchStatus: statusQuery.fetchStatus,
    isStale: statusQuery.isStale,
    hasLiveSource,
  };
}

export interface HostUpdateOperation {
  readonly installationLive: boolean;
  /** The facts as READ, live or not; see `legacyFacts` for the live ones. */
  readonly legacyFactsRead: LegacyUpdateFacts | null;
  readonly legacyFacts: LegacyUpdateFacts | null;
  readonly projection: LocalUpdateProjection;
  readonly operationView: FleetUpdateView | null;
}

/**
 * ONE projection, used by both the lifecycle gate and the card that renders
 * it — deriving these separately is how a page ends up locked for a state it
 * is simultaneously describing as parked.
 *
 * ⚠ THE FRESHNESS HERE IS DERIVED, NOT ASSERTED. An earlier version built the
 * observation with `freshUntilMs: Number.POSITIVE_INFINITY` and
 * `connected: true`, and read `nowMs` from `dataUpdatedAt` — three ways of
 * saying "assume this reading is current" — on the theory that the page's own
 * live-source helpers already demoted a retained read. They demoted the BUSY
 * snapshot only. `observationFromCanonicalRead` folds the query's health into
 * the deadline instead.
 */
export function useHostUpdateOperation(input: {
  readonly hostId: string | null;
  readonly isLocalMachine: boolean;
  readonly usable: boolean;
  readonly statusQuery: HostUpdateQueryRead<HostStatusResponse>;
  readonly statusHealth: CanonicalReadHealth;
  readonly installationQuery: HostUpdateQueryRead<HostInstallationResponse>;
  readonly installInfoDegrade: OverviewDegradeReason | null;
}): HostUpdateOperation {
  const { statusQuery, installationQuery } = input;
  // THE RECORD LEG'S LIVENESS. A failed or aged install-record read withdraws
  // only the two record-derived rows. The source here is the support flip
  // alone (`installInfoDegrade`), deliberately NOT `usable`: an unusable scope
  // is demoted through the status leg already, and that demotion KEEPS the
  // record-derived park as a qualified "Last seen: …" sentence with its
  // controls withdrawn. The support flip still has to be here, because it
  // disables the query over a cached payload, and a disabled query never ages
  // (`isStale` is false while `enabled` is) - so without it that payload would
  // read as live forever.
  const installationLive = canonicalReadIsLive({
    isError: installationQuery.isError,
    fetchStatus: installationQuery.fetchStatus,
    isStale: installationQuery.isStale,
    hasLiveSource: input.installInfoDegrade === null,
  });
  // The facts as READ - from the last successful record response, live or
  // not. Liveness is applied where each consumer needs it rather than by
  // erasing the facts: every OFFER and the projector's park take the live
  // facts below, while the catalog's comparison baseline keeps the read
  // debt (`activationDebt.live`). Erasing the facts on one failed poll
  // dropped the baseline, and the region then re-offered the version that
  // is already installed as "available" with a live Update now - for bytes
  // on disk that a failed poll did not change.
  const legacyFactsRead =
    statusQuery.data === undefined || installationQuery.data === undefined
      ? null
      : deriveLegacyUpdateFacts({
          installation: installationQuery.data,
          runningVersion: statusQuery.data.hostVersion,
          // The RAW read, not the live-source-demoted snapshot: the facts must
          // describe one instant of one response, and staleness is already
          // the observation deadline's job below.
          busy: statusQuery.data.busy,
          busySessionCount: statusQuery.data.busySessionCount,
        });
  const legacyFacts = installationLive ? legacyFactsRead : null;
  // Built whenever there IS a status read - including for a pre-@1.3 peer
  // whose `updateOperation` is `null`: the projector has an arm for exactly
  // that observation (coarse first, then the record-derived parks, then
  // `unknown`), and routing the old peer through it is what lets its parks
  // reach the card too.
  const operationObservation =
    statusQuery.data === undefined
      ? null
      : observationFromCanonicalRead({
          hostId: input.hostId ?? "",
          status: statusQuery.data,
          dataUpdatedAt: statusQuery.dataUpdatedAt,
          health: input.statusHealth,
          source: "selected",
          legacyFacts,
        });
  // THE DURABLE-RECORD LEG, for the window in which the wire leg above cannot
  // answer at all: this machine's host is down, so `host.status` has nothing to
  // say, and `update-attempt.json` on this disk is the only evidence there is.
  //
  // LOCAL ONLY, and the gate is the point rather than an optimisation: the
  // record on this machine describes this machine's host. Handing it to a
  // remote scoped host would render one machine's update on another machine's
  // page. A remote host keeps the status-only observation and renders its
  // last polled phase as last-seen.
  const localAttemptObservation = useLocalAttemptRecordObservation(
    input.isLocalMachine ? input.hostId : null,
  );
  // ⚠ A TICKING CLOCK, and it belongs to the RECORD leg ALONE.
  //
  // The record leg's evidence expires on its own: a holder probe's positive
  // verdict is proof for five seconds (`LOCAL_LIVENESS_PROOF_MS`), and both
  // query timestamps this could have aged it against stop advancing exactly
  // when the host is down. The WIRE leg keeps `statusQuery.dataUpdatedAt`:
  // `observationFromCanonicalRead` folds the query's health into the
  // deadline, so freshness there is a HEALTH verdict, not a race against how
  // long the round trip took. Feeding the tick to both demoted a slow
  // `host.status` to "Last seen" once per cycle.
  const nowMs = useNowMs(LOCAL_RECORD_TICK_MS);
  // ONE precedence-plus-projection, shared with the landing banner's hook
  // (`projectLocalUpdate`), so the two surfaces hold one opinion about the
  // same host in the window the record leg exists for.
  const projection = projectLocalUpdate({
    wire: operationObservation,
    record: localAttemptObservation,
    clock: { wireNowMs: statusQuery.dataUpdatedAt, recordNowMs: nowMs },
    connected: input.usable,
  });
  return {
    installationLive,
    legacyFactsRead,
    legacyFacts,
    projection,
    operationView: projection.observation === null ? null : projection.view,
  };
}

/**
 * The catalog's comparison baseline under activation debt, from the facts as
 * READ, qualified by BOTH legs' liveness: the debt is the record's installed
 * version read against the status read's running version, so a status read
 * that failed or aged (the host may already have restarted onto the installed
 * version) makes the sentence "last known" exactly as a failed record read
 * does. `statusLive` carries `usable` too.
 */
export function hostUpdateActivationDebt(
  operation: HostUpdateOperation,
  statusLive: boolean,
): { readonly installedVersion: string; readonly live: boolean } | null {
  const debt = operation.legacyFactsRead?.activationDebt ?? null;
  return debt === null
    ? null
    : {
        installedVersion: debt.installedVersion,
        live: operation.installationLive && statusLive,
      };
}

/**
 * The check and install degrades the update region reads. Whatever deployed
 * this host owns its version (`host.status@1.10`): the region retires to its
 * one-line reason before a catalog is fetched, the same retirement the first
 * refused install used to be the only way to discover. A host that predates
 * the field keeps that discovery path.
 */
export function hostUpdateDegrades(
  status: HostStatusResponse | undefined,
  capabilities: {
    readonly updateCheck: OverviewDegradeReason | null;
    readonly updateInstall: OverviewDegradeReason | null;
  },
): {
  readonly check: OverviewDegradeReason | null;
  readonly install: OverviewDegradeReason | null;
} {
  if (status?.updatesExternallyManaged === true) {
    return { check: "externally-managed", install: "externally-managed" };
  }
  return {
    check: capabilities.updateCheck,
    install: capabilities.updateInstall,
  };
}

/**
 * Whether an update holds the lifecycle gate: a mutation in flight, so
 * Restart, the service verbs and a second install wait.
 *
 * ATTEMPT-AWARE, with the coarse field as the fallback. The coarse derivation
 * maps a PARKED attempt (`waiting-for-work`/`waiting-to-activate`) to
 * `{state:"updating"}`, and a park can sit for days waiting for the restart it
 * would then block. `holdsLifecycleGate` answers the narrower question
 * (`execution === "active"`). For a pre-@1.3 peer `updateOperation` is `null`
 * and the gate falls back to the PROJECTED coarse kind, which a retained,
 * failed or aged read demotes to `unknown` rather than holding Restart on a
 * marker an updater crash left behind.
 *
 * The coarse arm is keyed on the observation that WON, not on the peer field
 * alone: a durable-record observation reaches the gate too — a probed-live
 * `restarting` holds it, exactly as a live wire `restarting` does — and it has
 * no marker behind it, so the pre-@1.3 test would find `restarting` where it
 * looks for `updating` and drop a gate the record leg is entitled to hold.
 */
export function updateHoldsLifecycleGate(input: {
  readonly view: FleetUpdateView | null;
  readonly observation: FleetUpdateObservation | null;
  readonly peerReportedOperation: HostStatusUpdateOperation | null;
}): boolean {
  const { view, observation } = input;
  if (view === null || observation === null) return false;
  if (isRecordObservation(observation)) return holdsLifecycleGate(view);
  if (input.peerReportedOperation === null) return view.kind === "updating";
  return holdsLifecycleGate(view);
}

/**
 * The accepted-install latch for `hostId`, and its release. An accepted
 * `host.update.install` returns the moment the CLI takes the job, and the
 * detached updater publishes progress only later: the latch bridges that gap,
 * and releases the moment progress appears, on a scope flip, or by its bounded
 * timer (the host-keyed store survives remounts).
 */
export function useUpdateInstallAcceptedLatch(
  hostId: string | null,
  updateProgress: HostStatusUpdateProgress | null,
): number | null {
  const acceptedAt = useHostServiceWriteLatchStore(
    (state) =>
      hostServiceWriteLatches(state.byHost, hostId).updateInstallAcceptedAt,
  );
  useEffect(() => {
    if (hostId === null || acceptedAt === null) return;
    // ONLY an `updating` frame releases: it is the one progress state that
    // proves the NEW detached updater is publishing. A `failed` frame can be
    // the terminal state of the PREVIOUS attempt, still on `host.status` when
    // a retry arms the latch - releasing on it reopened exactly the gap the
    // latch closes. A retry that itself fails fast without an `updating`
    // frame is covered by the bounded timer, in the safe direction.
    if (updateProgress?.state === "updating") {
      useHostServiceWriteLatchStore
        .getState()
        .releaseUpdateInstallAccepted(hostId);
      return;
    }
    const remaining = Math.max(
      0,
      acceptedAt + UPDATE_INSTALL_ACCEPTED_LATCH_MS - Date.now(),
    );
    const timer = setTimeout(() => {
      useHostServiceWriteLatchStore
        .getState()
        .releaseUpdateInstallAccepted(hostId);
    }, remaining);
    return () => clearTimeout(timer);
  }, [hostId, acceptedAt, updateProgress]);
  return acceptedAt;
}

/**
 * DISPATCH OWNERSHIP. One token per mount, registered while the surface is on
 * screen, captured by every update dispatch at arm time.
 *
 * It answers one question and gates one thing: may THIS surface open a dialog
 * about the attempt it is looking at? An install's settle deliberately
 * outlives the mount — that is how the latch settles and the reads are
 * invalidated for a swap the user navigated away from — and the ownership
 * write is the one part of it that must not, because its only consumer is a
 * modal that a mount opens. See `settleUpdateDispatch`.
 */
export function useOverviewIncarnation(): string {
  const [incarnation] = useState(newOverviewIncarnation);
  useEffect(() => registerOverviewIncarnation(incarnation), [incarnation]);
  return incarnation;
}

/**
 * The update-dispatch slot for `hostId`, kept by the frames the host reports:
 * `seen`, the frame-driven clears, and the unseen-TTL clear.
 */
export function useUpdateDispatchUpkeep(
  hostId: string | null,
  reportedOperation: HostStatusUpdateOperation | null,
): HostUpdateDispatchSlot | null {
  const updateDispatch = useHostServiceWriteLatchStore(
    (state) => hostServiceWriteLatches(state.byHost, hostId).updateDispatch,
  );
  // `seen` and two of the slot's three frame-driven clears. Reads the RAW peer
  // frame rather than the projection: this is bookkeeping about which attempt
  // the host has REPORTED, which a retained response answers as truthfully as
  // a fresh one — the frame did arrive, and it did name that id. Demoting it
  // for staleness would leave `seen` false through the exact window the ACK
  // races the poll, which is the window the flag exists to describe.
  useEffect(() => {
    if (hostId === null) return;
    useHostServiceWriteLatchStore.getState().observeUpdateDispatchFrame(
      hostId,
      reportedOperation === null || reportedOperation.kind !== "attempt"
        ? null
        : {
            attemptId: reportedOperation.attemptId,
            terminal: reportedOperation.execution === "terminal",
          },
    );
  }, [hostId, reportedOperation]);
  // THE DISPATCH SLOT'S UNSEEN-TTL CLEAR - the first of the two the
  // status stream cannot express, beside the deregister clear in
  // `host-overview-rpc.ts`, and the third of the slot's four in total. An
  // acknowledged attempt that no frame ever named.
  // The host answered `accepted {id}` and then either never published it or
  // published it while nothing was observing — either way this surface is
  // waiting for an ACK it will not recognise, and an owned dispatch nothing
  // can spend would arm the auto-open against whatever park drifts past next.
  const dispatchedAt = updateDispatch?.dispatchedAt ?? null;
  const dispatchSeen = updateDispatch?.seen ?? false;
  useEffect(() => {
    if (hostId === null || dispatchedAt === null || dispatchSeen) return;
    const remaining = Math.max(
      0,
      dispatchedAt + UPDATE_DISPATCH_UNSEEN_TTL_MS - Date.now(),
    );
    const timer = setTimeout(() => {
      useHostServiceWriteLatchStore.getState().clearUpdateDispatch(hostId);
    }, remaining);
    return () => clearTimeout(timer);
  }, [hostId, dispatchedAt, dispatchSeen]);
  return updateDispatch;
}
