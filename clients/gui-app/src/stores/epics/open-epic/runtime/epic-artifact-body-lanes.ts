/**
 * One `artifact.subscribe@1.0` adapter per body the UI is actually showing.
 *
 * The `@1` arm has no equivalent: there, bodies ride the single epic stream and
 * a room arrives whether or not anything is looking at it. The body lane is
 * per-DOC and per-EPOCH, so somebody has to decide which ones are open, keep
 * them matched to the epoch the records lane is serving, and close them when
 * the demand goes away. That is this module and nothing else.
 *
 * ## Demand, not tiles
 *
 * What is tracked is DEMAND - the set of artifact ids someone has asked for -
 * rather than the set of live adapters. The two differ whenever an epoch is
 * unknown, which is the normal cold-open shape: a tile can mount and take its
 * lease before the status lane's first snapshot has named an epoch, and
 * `artifact.subscribe` refuses an open with no `authorityEpoch`. Holding the
 * demand means that tile's body opens by itself the moment the epoch lands,
 * with no second call from the UI and no polling.
 *
 * It is also what makes the epoch change cheap to express: the authority moved,
 * so every adapter built under the old one is void, and the demand set is
 * exactly the list to rebuild from.
 *
 * ## Why an adapter is never reused across epochs
 *
 * `ArtifactLaneAdapterSources.authorityEpoch` is fixed for the adapter's whole
 * life - it is baked into the open request. So "the epoch changed" cannot be a
 * mutation; it is a teardown and a rebuild. Anything else would leave a
 * subscription open against a generation the host has stopped serving, which
 * the host answers with `staleAuthorityEpoch` - a whole-epic replacement, not a
 * per-body error.
 */
import type {
  AdapterDetachReason,
  ReplicaReplacementReason,
  RuntimeEnvironment,
  SendOutcome,
} from "@traycer-clients/shared/replica-runtime";
import type {
  ArtifactLaneAdapter,
  ArtifactStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import { createArtifactLaneAdapter } from "@traycer-clients/shared/epic-lanes";
import type { ArtifactSubscribeSeedOffer } from "@traycer/protocol/host/epic/artifact-subscribe";
import type { EpicRoomEvent } from "./epic-runtime-events";
import { isMethodIncompatibleClose } from "@traycer-clients/shared/host-transport/i-stream-session";
import { laneBodyTranslationOf } from "./lane-body-translation";

export interface EpicArtifactBodyLanesSources {
  readonly epicId: string;
  readonly environment: RuntimeEnvironment;
  readonly streamClientFactory: ArtifactStreamClientFactory;
  /**
   * The epoch bodies attach under, read LIVE off the status lane. `null` before
   * the first status snapshot, which is a wait rather than a failure.
   */
  readonly readAuthorityEpoch: () => string | null;
  /**
   * What this client holds for one body. Wired to the tier, so "the tier holds
   * a replica" and "the host may answer with a delta" are one fact rather than
   * two that have to be kept in step.
   */
  readonly readDocSeed: (
    artifactId: string,
  ) => ArtifactSubscribeSeedOffer | null;
  readonly isDisposed: () => boolean;
  /** One decoded body frame, already in the rooms plane's vocabulary. */
  readonly onRoomEvent: (event: EpicRoomEvent) => void;
  /** The authority is not serving the epoch a body attached under. */
  readonly onReplacementRequested: (reason: ReplicaReplacementReason) => void;
  /**
   * The host refuses `artifact.subscribe` outright.
   *
   * Not a per-body state and not a retry: it says the installed arm cannot
   * render bodies at all, which is the one thing `@1` can always do. The
   * consumer's answer is to fall back to legacy, so this is reported to the
   * ARM rather than folded into an availability value - a body greying out
   * would leave the epic on an arm that can never show a body again.
   *
   * Called once per refusing lane; the arm coalesces across tiles.
   */
  readonly onLaneUnsupported: () => void;
}

export interface EpicArtifactBodyLanes {
  /**
   * Record demand for one body and open it if it can be opened now.
   *
   * Idempotent per artifact: repeated calls under the same epoch keep the one
   * subscription. Safe to call before any epoch is known - the demand is held
   * and {@link syncToAuthorityEpoch} opens it later.
   */
  ensureAttached(artifactId: string): void;
  /**
   * Drop ONE demand for a body, closing its lane when the last one goes.
   *
   * Ref-counted, because demand is per LEASE and several tiles legitimately
   * show the same artifact at once (a canvas tile and the mobile switcher's
   * preview, a split view). Closing on the first release would take the body
   * out from under every other holder; never closing leaks a subscription per
   * tile ever opened, and rebuilds all of them on every epoch change.
   */
  release(artifactId: string, reason: AdapterDetachReason): void;
  /**
   * Reconcile every lane against the epoch the status lane now reports.
   *
   * Opens the bodies that were waiting for an epoch, and rebuilds any built
   * under a superseded one. Cheap and idempotent when nothing moved, which is
   * what lets the arm call it on every control event rather than having to
   * detect the change itself.
   */
  syncToAuthorityEpoch(): void;
  /** Ids with a live subscription right now - for assertions and diagnostics. */
  attachedArtifactIds(): readonly string[];
  /**
   * Push local body bytes for one artifact.
   *
   * Returns the adapter's own {@link SendOutcome} rather than a boolean,
   * because the caller's three responses are genuinely different: `sent` is
   * done, `queued` means keep holding these bytes, and `dropped` means stop.
   * Collapsing them to a boolean is what turns "not yet" into "never".
   */
  sendUpdate(artifactId: string, update: Uint8Array): SendOutcome;
  sendAwareness(artifactId: string, frame: Uint8Array): SendOutcome;
  detachAll(reason: AdapterDetachReason): void;
  closeTransport(): void;
  openTransport(): void;
}

interface OpenBodyLane {
  readonly adapter: ArtifactLaneAdapter;
  /** The epoch this adapter was built under. Fixed for its life. */
  readonly authorityEpoch: string;
  /**
   * The guid the outbound path stamps on updates, learned from the snapshot
   * that seeded this body.
   *
   * `null` until then, and an update pushed before it is known cannot be sent:
   * `applyUpdate` names the document the bytes belong to, and inventing that
   * name is how one body's edit gets applied to another's history.
   */
  docGuid: string | null;
}

export function createEpicArtifactBodyLanes(
  sources: EpicArtifactBodyLanesSources,
): EpicArtifactBodyLanes {
  const {
    epicId,
    environment,
    streamClientFactory,
    readAuthorityEpoch,
    readDocSeed,
    isDisposed,
    onRoomEvent,
    onReplacementRequested,
    onLaneUnsupported,
  } = sources;

  /**
   * How many live leases want each body open, whether or not one currently is.
   *
   * A COUNT rather than a set: `ensureAttached` is called once per lease and
   * `release` once per release, and those pair up only if the second is as
   * granular as the first.
   */
  const demand = new Map<string, number>();
  const open = new Map<string, OpenBodyLane>();

  function closeLane(artifactId: string, reason: AdapterDetachReason): void {
    const lane = open.get(artifactId);
    if (lane === undefined) return;
    open.delete(artifactId);
    lane.adapter.detach(reason);
  }

  function openLane(artifactId: string, authorityEpoch: string): void {
    const adapter = createArtifactLaneAdapter({
      epicId,
      artifactId,
      authorityEpoch,
      streamClientFactory,
      readDocSeed: () => readDocSeed(artifactId),
      isDisposed,
    });
    const lane: OpenBodyLane = { adapter, authorityEpoch, docGuid: null };
    open.set(artifactId, lane);
    adapter.attach({
      environment,
      emit: (event) => {
        // Learn the guid from the seed, before translating: the outbound path
        // needs it to name the document it is writing to, and the snapshot is
        // the only frame that carries it.
        if (event.kind === "doc-snapshot") lane.docGuid = event.docGuid;
        const translated = laneBodyTranslationOf(event);
        if (translated.kind === "replace-replica") {
          // Not a per-body state: this client's whole epic view is void. The
          // runtime rebuilds and the records lane reports the epoch to attach
          // under next, at which point `syncToAuthorityEpoch` reopens every
          // body still in demand.
          onReplacementRequested("authority-epoch-changed");
          return;
        }
        onRoomEvent(translated.event);
      },
      // A body has no cursor - its resume state is "which document, and how
      // much of it do I hold", which rides `readDocSeed` on the open request
      // rather than a lane position.
      reportResume: () => {},
      // Transport status is deliberately NOT routed to the control replica: a
      // body lane's socket is one of many, and letting each publish epic-wide
      // status would make the epic read as disconnected because a single
      // tile's stream blipped. The records and status lanes own that signal.
      //
      // A method-incompatible close is different in kind. It is not this
      // body's connection failing, it is the host saying it does not serve
      // this METHOD - a statement about the arm, not the tile - and on a
      // forever-unknown remote connection nothing else will ever say it.
      reportStatus: (status) => {
        if (isMethodIncompatibleClose(status.closeReason)) {
          onLaneUnsupported();
        }
      },
      requestReplacement: onReplacementRequested,
    });
  }

  return {
    ensureAttached(artifactId): void {
      if (isDisposed()) return;
      demand.set(artifactId, (demand.get(artifactId) ?? 0) + 1);
      const authorityEpoch = readAuthorityEpoch();
      // No epoch yet: the demand is recorded and `syncToAuthorityEpoch` opens
      // this body when the first status snapshot names one.
      if (authorityEpoch === null) return;
      const existing = open.get(artifactId);
      if (existing !== undefined) {
        if (existing.authorityEpoch === authorityEpoch) return;
        closeLane(artifactId, "superseded");
      }
      openLane(artifactId, authorityEpoch);
    },

    release(artifactId, reason): void {
      const held = demand.get(artifactId);
      // A release with nothing held is a no-op, not an error: a lease taken
      // before the arm was replaced is released after it, and the replacement
      // already tore every lane down. Throwing there would turn an ordinary
      // unmount into a crash.
      if (held === undefined) return;
      if (held > 1) {
        demand.set(artifactId, held - 1);
        return;
      }
      demand.delete(artifactId);
      closeLane(artifactId, reason);
    },

    syncToAuthorityEpoch(): void {
      if (isDisposed()) return;
      const authorityEpoch = readAuthorityEpoch();
      if (authorityEpoch === null) return;
      for (const artifactId of demand.keys()) {
        const existing = open.get(artifactId);
        if (existing !== undefined) {
          if (existing.authorityEpoch === authorityEpoch) continue;
          closeLane(artifactId, "superseded");
        }
        openLane(artifactId, authorityEpoch);
      }
    },

    attachedArtifactIds: () => Array.from(open.keys()),

    sendUpdate(artifactId, update): SendOutcome {
      const lane = open.get(artifactId);
      if (lane === undefined) {
        return { kind: "queued", reason: "no-body-lane-for-artifact" };
      }
      // No guid means no snapshot has seeded this body yet. `queued`, not
      // `dropped`: the bytes are a user's edit and the seed is coming, so the
      // caller must keep them. Sending them under a guessed name is the one
      // outcome that is worse than waiting - `docGuid` is the host's write-path
      // generation guard, and a wrong one either drops the edit silently or
      // applies it to a document it did not come from.
      if (lane.docGuid === null) {
        return { kind: "queued", reason: "body-not-seeded" };
      }
      return lane.adapter.send({
        kind: "apply-update",
        docGuid: lane.docGuid,
        update,
      });
    },

    sendAwareness(artifactId, frame): SendOutcome {
      const lane = open.get(artifactId);
      // Presence is fire-and-forget by class: a replayed caret asserts someone
      // is somewhere they left, so a frame with nowhere to go is DROPPED rather
      // than queued. The doc-update path above queues for the opposite reason.
      if (lane === undefined) {
        return { kind: "dropped", reason: "no-body-lane-for-artifact" };
      }
      return lane.adapter.send({ kind: "awareness", frame });
    },

    detachAll(reason): void {
      for (const artifactId of Array.from(open.keys())) {
        closeLane(artifactId, reason);
      }
      // Demand deliberately SURVIVES: `detachAll` is how a transport-only
      // detach and a replacement both tear the sockets down, and both are
      // followed by a reopen that must restore the same bodies. Only
      // `release` - the lease actually going away - forgets one.
    },

    closeTransport(): void {
      for (const lane of open.values()) lane.adapter.closeTransport();
    },

    openTransport(): void {
      for (const lane of open.values()) lane.adapter.openTransport();
    },
  };
}
