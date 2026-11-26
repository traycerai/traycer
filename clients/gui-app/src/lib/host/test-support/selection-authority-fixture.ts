import { onTestFinished } from "vitest";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
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

interface SelectionAuthorityFixtureOptions {
  readonly hosts: ReadonlyArray<HostFleetEntry>;
  readonly localHostId?: string | null;
  readonly savedPick?: string | null;
  readonly readyComputers?: ReadonlyArray<string>;
  readonly pool?: "ready" | "offline" | "disabled";
  readonly discovery?: "answered" | "pending";
}

export interface SelectionAuthorityFixture {
  readonly snapshot: () => SelectionAuthoritySnapshot;
  readonly fleetComputers: () => ReadonlyArray<HostFleetEntry>;
  readonly hasLiveTransport: (hostId: string) => boolean;
  readonly publishFleet: (
    hosts: ReadonlyArray<HostFleetEntry>,
    localHostId: string | null,
  ) => SelectionAuthoritySnapshot;
  readonly openPool: () => SelectionAuthoritySnapshot;
  readonly connectComputer: (hostId: string) => SelectionAuthoritySnapshot;
  readonly loseSession: (hostId: string) => SelectionAuthoritySnapshot;
  readonly succeedDial: (hostId: string) => SelectionAuthoritySnapshot;
  readonly refuseDial: (hostId: string) => SelectionAuthoritySnapshot;
  readonly goCold: (hostId: string) => SelectionAuthoritySnapshot;
  readonly advance: (ms: number) => SelectionAuthoritySnapshot;
  readonly finishReturnDamping: () => SelectionAuthoritySnapshot;
  readonly activate: (hostId: string) => Promise<ActivateResult>;
}

function requireComputerId(hostId: string): void {
  if (hostId === POOL_HOST_ID) {
    throw new Error("The reserved pool id is a serving peer, never a computer");
  }
}

function validateFleet(
  hosts: ReadonlyArray<HostFleetEntry>,
  localHostId: string | null,
): void {
  if (localHostId !== null) requireComputerId(localHostId);
  for (const host of hosts) requireComputerId(host.hostId);
}

let activeFixture: symbol | null = null;

export function hasActiveTestSelectionAuthority(): boolean {
  return activeFixture !== null;
}

/** Publishes only the engine's own snapshots. The caller supplies evidence and time. */
export function mountTestSelectionAuthority(
  options: SelectionAuthorityFixtureOptions,
): SelectionAuthorityFixture {
  const localHostId = options.localHostId ?? null;
  const savedPick = options.savedPick ?? null;
  validateFleet(options.hosts, localHostId);
  if (
    options.discovery === "pending" &&
    (options.hosts.length > 0 || localHostId !== null)
  ) {
    throw new Error(
      "Pending discovery requires an empty fleet and no local host",
    );
  }
  if (savedPick !== null) requireComputerId(savedPick);
  for (const hostId of options.readyComputers ?? []) requireComputerId(hostId);

  const clock = createFakeAuthorityClock(0);
  const pool = options.pool ?? "ready";
  const authority = createTestAuthority({
    initialFleet: {
      identityGeneration: 0,
      localHostId,
      hosts: options.hosts,
    },
    initialIdentityKey: "selection-fixture",
    clock,
    seedPreferred: savedPick,
    poolConfigured: pool !== "disabled",
  });
  const { engine, fleet } = authority;
  if (options.discovery !== "pending") {
    fleet.publish(0, localHostId, options.hosts);
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
  const fixture = Symbol();
  activeFixture = fixture;
  onTestFinished(() => {
    authority.dispose();
    if (activeFixture === fixture) {
      activeFixture = null;
      useSelectionAuthorityStore.getState().reset();
    }
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

  function reportDial(
    hostId: string,
    outcome: "success" | "confirmed-refusal",
  ): void {
    const entry = fleet.snapshot().hosts.find((host) => host.hostId === hostId);
    if (entry === undefined)
      throw new Error(`Dial for unlisted computer ${hostId}`);
    ingest({
      kind: "dial",
      hostId,
      attemptId: `selection-dial-${++sequence}`,
      outcome,
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
    fleetComputers: () => fleet.snapshot().hosts,
    hasLiveTransport: (hostId) => sessions.has(hostId),
    publishFleet: (hosts, localHostId) => {
      validateFleet(hosts, localHostId);
      fleet.publish(0, localHostId, hosts);
      for (const hostId of sessions.keys()) {
        if (
          hostId !== POOL_HOST_ID &&
          !hosts.some((host) => host.hostId === hostId)
        ) {
          lose(hostId);
        }
      }
      return publish();
    },
    openPool: () => {
      if (pool === "disabled") throw new Error("The pool is not configured");
      return connect(POOL_HOST_ID);
    },
    connectComputer: (hostId) => {
      requireComputerId(hostId);
      return connect(hostId);
    },
    loseSession: (hostId) => {
      requireComputerId(hostId);
      lose(hostId);
      return publish();
    },
    refuseDial: (hostId) => {
      requireComputerId(hostId);
      reportDial(hostId, "confirmed-refusal");
      return publish();
    },
    succeedDial: (hostId) => {
      requireComputerId(hostId);
      reportDial(hostId, "success");
      return publish();
    },
    goCold: (hostId) => {
      requireComputerId(hostId);
      lose(hostId);
      for (
        let attempt = 0;
        attempt < CONFIRMED_DEATH_REFUSAL_STREAK;
        attempt += 1
      ) {
        reportDial(hostId, "confirmed-refusal");
      }
      return publish();
    },
    advance,
    finishReturnDamping: () => advance(FAILOVER_CANDIDATE_STABILITY_MS),
    activate: (hostId) => {
      requireComputerId(hostId);
      const result = engine.activate(reporter, incarnationId, hostId);
      publish();
      return result;
    },
  };
}

/** A local computer has just returned and the pool still serves during damping. */
export function mountTestSelectionAuthorityDuringLocalReturn(
  localHostId: string,
): SelectionAuthorityFixture {
  const previousComputer = {
    hostId: "previous-computer",
    kind: "remote",
    teamOwned: false,
  } as const;
  const authority = mountTestSelectionAuthority({
    hosts: [previousComputer],
    readyComputers: [previousComputer.hostId],
  });
  authority.goCold(previousComputer.hostId);
  authority.publishFleet(
    [
      { hostId: localHostId, kind: "local", teamOwned: false },
      previousComputer,
    ],
    localHostId,
  );
  authority.connectComputer(localHostId);
  return authority;
}
