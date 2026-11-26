import { onTestFinished } from "vitest";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import {
  SELECTION_AUTHORITY_CONTRACT_VERSION,
  type ActivateResult,
  type HostFleetEntry,
  type LiveSessionAnnouncement,
  type SelectionAuthoritySnapshot,
  type SelectionEvidenceReport,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  CONFIRMED_DEATH_REFUSAL_STREAK,
  FAILOVER_CANDIDATE_STABILITY_MS,
} from "@traycer-clients/shared/host-selection/selection-authority-engine";
import {
  createFakeAuthorityClock,
  createTestAuthority,
} from "@traycer-clients/shared/host-selection/__tests__/selection-authority-harness";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import {
  readTestEpicSessionHostClientResolver,
  setTestEpicSessionHostClientResolver,
} from "@/lib/registries/test-support/epic-session-controller-test-support";

interface SelectionAuthorityFixtureOptions {
  readonly hosts: ReadonlyArray<HostFleetEntry>;
  readonly localHostId?: string | null;
  readonly savedPick?: string | null;
  readonly readyComputers?: ReadonlyArray<string>;
  readonly pool?: "ready" | "offline" | "disabled";
  readonly discovery?: "answered" | "pending";
}

interface SelectionAuthorityFixture {
  readonly snapshot: () => SelectionAuthoritySnapshot;
  readonly publishFleet: (
    hosts: ReadonlyArray<HostFleetEntry>,
    localHostId: string | null,
  ) => SelectionAuthoritySnapshot;
  readonly openPool: () => SelectionAuthoritySnapshot;
  readonly connectComputer: (hostId: string) => SelectionAuthoritySnapshot;
  readonly loseSession: (hostId: string) => SelectionAuthoritySnapshot;
  readonly refuseDial: (hostId: string) => SelectionAuthoritySnapshot;
  readonly goCold: (hostId: string) => SelectionAuthoritySnapshot;
  readonly advance: (ms: number) => SelectionAuthoritySnapshot;
  readonly finishReturnDamping: () => SelectionAuthoritySnapshot;
  readonly activate: (hostId: string) => Promise<ActivateResult>;
  readonly serveTaskSessionFromPool: () => HostClient<HostRpcRegistry>;
}

/** Publishes only the engine's own snapshots. The caller supplies evidence and time. */
export function mountTestSelectionAuthority(
  options: SelectionAuthorityFixtureOptions,
): SelectionAuthorityFixture {
  const clock = createFakeAuthorityClock(0);
  const pool = options.pool ?? "ready";
  const authority = createTestAuthority({
    initialFleet: {
      identityGeneration: 0,
      localHostId: options.localHostId ?? null,
      hosts: options.hosts,
    },
    initialIdentityKey: "selection-fixture",
    clock,
    seedPreferred: options.savedPick ?? null,
    poolConfigured: pool !== "disabled",
  });
  const { engine, fleet } = authority;
  if (options.discovery !== "pending") {
    fleet.publish(0, options.localHostId ?? null, options.hosts);
  }
  const sessions = new Map<string, LiveSessionAnnouncement>();
  let sequence = 0;
  function newSession(hostId: string): LiveSessionAnnouncement {
    const entry = fleet.snapshot().hosts.find((host) => host.hostId === hostId);
    if (hostId !== POOL_HOST_ID && entry === undefined) {
      throw new Error(`Session for unlisted computer ${hostId}`);
    }
    const computerTransport =
      entry?.kind === "local" ? "local-ws" : "remote-relay";
    const session: LiveSessionAnnouncement = {
      hostId,
      sessionId: `selection-session-${++sequence}`,
      transportKind:
        hostId === POOL_HOST_ID ? "pool-direct" : computerTransport,
    };
    sessions.set(hostId, session);
    return session;
  }
  const initialSessions = (options.readyComputers ?? []).map(newSession);
  if (pool === "ready") initialSessions.push(newSession(POOL_HOST_ID));
  const reporter = "selection-fixture-window";
  const attach = engine.attach(reporter, {
    attachSeq: engine.allocateAttachSeq(reporter),
    callerContractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
    liveSessions: initialSessions,
  });
  if (!attach.ok)
    throw new Error("Selection authority fixture failed to attach");
  const { incarnationId } = attach;
  onTestFinished(() => {
    authority.dispose();
    useSelectionAuthorityStore.getState().reset();
  });

  function publish(): SelectionAuthoritySnapshot {
    const snapshot = engine.snapshot();
    useSelectionAuthorityStore.getState().applyKernelSnapshot({
      attached: true,
      preferredHostId: snapshot.preferredHostId,
      targetHostId: snapshot.targetHostId,
      effectiveHostId: snapshot.effectiveHostId,
      servingPeer: snapshot.servingPeer,
      noPeerPresentation: snapshot.noPeerPresentation,
      leases: snapshot.leases,
      selectionRevision: snapshot.revision,
    });
    return snapshot;
  }

  function ingest(report: SelectionEvidenceReport): void {
    engine.ingestEvidence(reporter, incarnationId, report);
  }

  function connect(hostId: string): SelectionAuthoritySnapshot {
    if (!sessions.has(hostId)) {
      ingest({
        ...newSession(hostId),
        kind: "session",
        transition: "established",
        at: clock.now(),
      });
    }
    return publish();
  }

  function lose(hostId: string): void {
    const session = sessions.get(hostId);
    if (session === undefined) return;
    sessions.delete(hostId);
    ingest({
      ...session,
      kind: "session",
      transition: "lost",
      at: clock.now(),
    });
  }

  function refuse(hostId: string): void {
    const entry = fleet.snapshot().hosts.find((host) => host.hostId === hostId);
    if (entry === undefined)
      throw new Error(`Dial for unlisted computer ${hostId}`);
    ingest({
      kind: "dial",
      hostId,
      attemptId: `selection-refusal-${++sequence}`,
      outcome: "confirmed-refusal",
      transportKind: entry.kind === "local" ? "local-ws" : "remote-relay",
      at: clock.now(),
    });
  }

  function advance(ms: number): SelectionAuthoritySnapshot {
    clock.advance(ms);
    return publish();
  }

  publish();
  return {
    snapshot: () => engine.snapshot(),
    publishFleet: (hosts, localHostId) => {
      fleet.publish(0, localHostId, hosts);
      return publish();
    },
    openPool: () => connect(POOL_HOST_ID),
    connectComputer: connect,
    loseSession: (hostId) => {
      lose(hostId);
      return publish();
    },
    refuseDial: (hostId) => {
      refuse(hostId);
      return publish();
    },
    goCold: (hostId) => {
      lose(hostId);
      for (
        let attempt = 0;
        attempt < CONFIRMED_DEATH_REFUSAL_STREAK;
        attempt += 1
      ) {
        refuse(hostId);
      }
      return publish();
    },
    advance,
    finishReturnDamping: () => advance(FAILOVER_CANDIDATE_STABILITY_MS),
    activate: (hostId) => {
      const result = engine.activate(reporter, incarnationId, hostId);
      publish();
      return result;
    },
    // Stands for T8's pool task-session endpoint in surface tests. The
    // resolver answers for that endpoint without selecting a task host.
    serveTaskSessionFromPool: () => {
      if (engine.snapshot().servingPeer?.kind !== "pool") {
        throw new Error("The test authority is not serving from the pool");
      }
      const spine = new HostClient<HostRpcRegistry>({
        registry: hostRpcRegistry,
        messenger: new MockHostMessenger({
          registry: hostRpcRegistry,
          requestId: () => "pool-task-session",
          handlers: {},
        }),
        invalidator: { invalidateHostScope: () => undefined },
        findHostById: (hostId) => (hostId === POOL_HOST_ID ? poolEntry : null),
      });
      const client = spine.createRequesterForHostId(POOL_HOST_ID);
      const previousResolver = readTestEpicSessionHostClientResolver();
      setTestEpicSessionHostClientResolver((hostId) =>
        hostId === POOL_HOST_ID ? client : (previousResolver?.(hostId) ?? null),
      );
      onTestFinished(() => spine.dispose());
      return client;
    },
  };
}
