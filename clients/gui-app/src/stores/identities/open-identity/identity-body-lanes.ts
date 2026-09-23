/**
 * One `agentIdentity.file.subscribe@1.0` adapter per body the surface is showing.
 *
 * A copy of `open-epic/runtime/epic-artifact-body-lanes.ts` keyed by PATH and
 * built on the identity body adapter. Every rule that module states holds
 * here unchanged - demand is tracked rather than adapters, an adapter is never
 * reused across epochs, a terminal refusal is honored only for the world it
 * was issued in - and the comments that justify each one live there. What
 * differs is only the address (a path under one identity, not an artifact id
 * under one epic) and the consumer: decoded events go straight to the body
 * tier rather than through a room-event translation.
 */
import type {
  AdapterDetachReason,
  DocReplicaEvent,
  ReplicaReplacementReason,
  ReplicaTransitionToken,
  RuntimeEnvironment,
  SendOutcome,
} from "@traycer-clients/shared/replica-runtime";
import { authorityEpochTransition } from "@traycer-clients/shared/replica-runtime";
import type {
  IdentityFileLaneAdapter,
  IdentityFileStreamClientFactory,
} from "@traycer-clients/shared/identity-lanes";
import { createIdentityFileLaneAdapter } from "@traycer-clients/shared/identity-lanes";
import type { AgentIdentityFileSeedOffer } from "@traycer/protocol/host/agent-identity/file-subscribe";
import { isMethodIncompatibleClose } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";

export interface IdentityBodyLanesSources {
  readonly identityId: string;
  readonly environment: RuntimeEnvironment;
  readonly streamClientFactory: IdentityFileStreamClientFactory;
  /** The epoch bodies attach under, read LIVE off the index replica. */
  readonly readAuthorityEpoch: () => string | null;
  /** What this client holds for one body - wired to the tier. */
  readonly readDocSeed: (path: string) => AgentIdentityFileSeedOffer | null;
  readonly isDisposed: () => boolean;
  /** One decoded body frame. */
  readonly onBodyEvent: (event: DocReplicaEvent) => void;
  /** The authority is not serving the epoch a body attached under. */
  readonly onReplacementRequested: (
    reason: ReplicaReplacementReason,
    transition: ReplicaTransitionToken,
  ) => void;
  /** The host refuses `agentIdentity.file.subscribe` outright. */
  readonly onLaneUnsupported: () => void;
}

export interface IdentityBodyLanes {
  ensureAttached(path: string): void;
  release(path: string, reason: AdapterDetachReason): void;
  syncToAuthorityEpoch(): void;
  noteTransportStatus(status: StreamConnectionStatus): void;
  attachedPaths(): readonly string[];
  sendUpdate(path: string, update: Uint8Array): SendOutcome;
  sendAwareness(path: string, frame: Uint8Array): SendOutcome;
  detachAll(reason: AdapterDetachReason): void;
  closeTransport(): void;
  openTransport(): void;
}

interface OpenBodyLane {
  readonly adapter: IdentityFileLaneAdapter;
  readonly authorityEpoch: string;
  docGuid: string | null;
}

export function createIdentityBodyLanes(
  sources: IdentityBodyLanesSources,
): IdentityBodyLanes {
  const {
    identityId,
    environment,
    streamClientFactory,
    readAuthorityEpoch,
    readDocSeed,
    isDisposed,
    onBodyEvent,
    onReplacementRequested,
    onLaneUnsupported,
  } = sources;

  const demand = new Map<string, number>();
  const open = new Map<string, OpenBodyLane>();
  const refused = new Set<string>();
  let lastSyncedEpoch: string | null = null;
  let lastTransportStatus: StreamConnectionStatus | null = null;

  function closeLane(path: string, reason: AdapterDetachReason): void {
    const lane = open.get(path);
    if (lane === undefined) return;
    open.delete(path);
    lane.adapter.detach(reason);
  }

  function openLane(path: string, authorityEpoch: string): void {
    const adapter = createIdentityFileLaneAdapter({
      identityId,
      path,
      authorityEpoch,
      streamClientFactory,
      readDocSeed: () => readDocSeed(path),
      isDisposed,
    });
    const lane: OpenBodyLane = { adapter, authorityEpoch, docGuid: null };
    open.set(path, lane);
    adapter.attach({
      environment,
      emit: (event) => {
        if (event.kind === "doc-snapshot") lane.docGuid = event.docGuid;
        if (
          event.kind === "doc-unavailable" &&
          event.code === "stale-authority-epoch"
        ) {
          onReplacementRequested(
            "authority-epoch-changed",
            authorityEpochTransition(lane.authorityEpoch),
          );
          return;
        }
        onBodyEvent(event);
        // THE EAGER FORGET, after the event on purpose - the epic module
        // explains why a finished adapter left in `open` blocks every later
        // reattach at an unchanged epoch.
        if (event.kind === "doc-unavailable" && event.terminal) {
          refused.add(path);
          closeLane(path, "superseded");
        }
      },
      reportResume: () => {},
      reportStatus: (status) => {
        if (isMethodIncompatibleClose(status.closeReason)) onLaneUnsupported();
      },
      requestReplacement: onReplacementRequested,
    });
  }

  function reopenDemandedBodies(authorityEpoch: string): void {
    for (const path of demand.keys()) {
      if (refused.has(path)) continue;
      const existing = open.get(path);
      if (existing !== undefined) {
        if (existing.authorityEpoch === authorityEpoch) continue;
        closeLane(path, "superseded");
      }
      openLane(path, authorityEpoch);
    }
  }

  return {
    ensureAttached(path): void {
      if (isDisposed()) return;
      demand.set(path, (demand.get(path) ?? 0) + 1);
      refused.delete(path);
      const authorityEpoch = readAuthorityEpoch();
      if (authorityEpoch === null) return;
      const existing = open.get(path);
      if (existing !== undefined) {
        if (existing.authorityEpoch === authorityEpoch) return;
        closeLane(path, "superseded");
      }
      openLane(path, authorityEpoch);
    },

    release(path, reason): void {
      const held = demand.get(path);
      if (held === undefined) return;
      if (held > 1) {
        demand.set(path, held - 1);
        return;
      }
      demand.delete(path);
      closeLane(path, reason);
    },

    syncToAuthorityEpoch(): void {
      if (isDisposed()) return;
      const authorityEpoch = readAuthorityEpoch();
      if (authorityEpoch === null) return;
      if (authorityEpoch !== lastSyncedEpoch) {
        lastSyncedEpoch = authorityEpoch;
        refused.clear();
      }
      reopenDemandedBodies(authorityEpoch);
    },

    noteTransportStatus(status): void {
      const previous = lastTransportStatus;
      lastTransportStatus = status;
      if (status !== "open") return;
      if (previous === null || previous === "open") return;
      refused.clear();
      if (isDisposed()) return;
      const authorityEpoch = readAuthorityEpoch();
      if (authorityEpoch === null) return;
      reopenDemandedBodies(authorityEpoch);
    },

    attachedPaths: () => Array.from(open.keys()),

    sendUpdate(path, update): SendOutcome {
      const lane = open.get(path);
      if (lane === undefined) {
        return { kind: "queued", reason: "no-body-lane-for-path" };
      }
      if (lane.docGuid === null) {
        return { kind: "queued", reason: "body-not-seeded" };
      }
      return lane.adapter.send({
        kind: "apply-update",
        docGuid: lane.docGuid,
        update,
      });
    },

    sendAwareness(path, frame): SendOutcome {
      const lane = open.get(path);
      if (lane === undefined) {
        return { kind: "dropped", reason: "no-body-lane-for-path" };
      }
      return lane.adapter.send({ kind: "awareness", frame });
    },

    detachAll(reason): void {
      for (const path of Array.from(open.keys())) closeLane(path, reason);
      refused.clear();
      lastTransportStatus = null;
    },

    closeTransport(): void {
      for (const lane of open.values()) lane.adapter.closeTransport();
    },

    openTransport(): void {
      for (const lane of open.values()) lane.adapter.openTransport();
    },
  };
}
