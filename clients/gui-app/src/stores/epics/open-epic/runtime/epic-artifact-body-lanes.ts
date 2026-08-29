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
  /** Drop demand for one body and close its lane. */
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
  } = sources;

  /** Bodies someone wants open, whether or not one currently is. */
  const demand = new Set<string>();
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
      // Deliberately not routed to the control replica. A body lane's socket is
      // one of many; letting each one publish epic-wide transport status would
      // make the epic read as disconnected because a single tile's stream
      // blipped. The records and status lanes own that signal.
      reportStatus: () => {},
      requestReplacement: onReplacementRequested,
    });
  }

  return {
    ensureAttached(artifactId): void {
      if (isDisposed()) return;
      demand.add(artifactId);
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
      demand.delete(artifactId);
      closeLane(artifactId, reason);
    },

    syncToAuthorityEpoch(): void {
      if (isDisposed()) return;
      const authorityEpoch = readAuthorityEpoch();
      if (authorityEpoch === null) return;
      for (const artifactId of demand) {
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
