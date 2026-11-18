/**
 * Browser/dev binding for the selection authority (P1.1): the SAME engine
 * module mounted in the single window, behind an in-process transport.
 *
 * The contract's topology note is the whole design here - "Browser/dev: same
 * engine in-window behind an in-process adapter (constant reporterId, seq
 * from the same `allocateAttachSeq`, identical claim + atomic-inventory
 * rules)". So this module adds no rules of its own: it forwards to the engine
 * with a fixed reporter id and reuses
 * {@link BufferedSelectionAuthorityClient} for the attach choreography, which
 * is what keeps the two topologies from drifting. Multi-window without a main
 * process is not a supported topology, so one constant reporter id is exact
 * rather than a simplification.
 *
 * There is no wire, so no parser runs here: the values already have their
 * contract types. `refuseMalformedAttach` likewise has no caller - a typed
 * in-process caller constructs `SelectionAttachRequest` directly and cannot
 * produce a malformed envelope.
 */
import {
  type AuthorityIdentitySource,
  type HostFleetSnapshot,
  type HostFleetSource,
  type LocalHostEnsurePort,
  type LocalHostOutageSignal,
  type SelectionAuthorityClient,
  type SelectionAuthorityEngine,
  type SelectionSubscription,
} from "./selection-authority-contract";
import {
  BufferedSelectionAuthorityClient,
  RotatingSelectionAuthorityClient,
  type SelectionAuthorityClientTransport,
} from "./buffered-selection-authority-client";
import {
  SelectionAuthorityEngineImpl,
  type AuthorityLog,
  type PreferredHostSaveResult,
  type PreferredHostStore,
  type SelectionAuthorityEngineOptions,
} from "./selection-authority-engine";

/**
 * The single window's reporter id. Constant by construction: with no main
 * process there is exactly one reporter, and its attach generations are
 * ordered by the engine's own allocator.
 */
export const IN_PROCESS_SELECTION_REPORTER_ID = "in-process-window";

/** Binds a transport to `engine` under the constant reporter id. */
export function createInProcessSelectionTransport(
  engine: SelectionAuthorityEngine,
): SelectionAuthorityClientTransport {
  const reporterId = IN_PROCESS_SELECTION_REPORTER_ID;
  return {
    allocateAttachSeq: () => engine.allocateAttachSeq(reporterId),
    attach: (request) => Promise.resolve(engine.attach(reporterId, request)),
    reportEvidence: (incarnationId, report) => {
      engine.ingestEvidence(reporterId, incarnationId, report);
      return Promise.resolve();
    },
    activate: (incarnationId, hostId) =>
      engine.activate(reporterId, incarnationId, hostId),
    onSelectionChanged: (listener) => engine.onSelectionChanged(listener),
    onLeasesChanged: (listener) => engine.onLeasesChanged(listener),
    onReattachRequired: (listener) => engine.onReattachRequired(listener),
  };
}

/**
 * The consumer-facing client for the browser/dev topology: rotation on
 * `reattachRequired` included, so an identity transition behaves exactly as
 * it does on desktop.
 */
export function createInProcessSelectionAuthorityClient(
  engine: SelectionAuthorityEngine,
  log: AuthorityLog,
): RotatingSelectionAuthorityClient {
  const transport = createInProcessSelectionTransport(engine);
  return new RotatingSelectionAuthorityClient(
    () => new BufferedSelectionAuthorityClient(transport, log),
    log,
  );
}

/** An engine plus the single window's client, disposed together. */
export interface InProcessSelectionAuthority {
  readonly engine: SelectionAuthorityEngineImpl;
  readonly client: SelectionAuthorityClient;
  dispose(): void;
}

/** Composition root for a shell with no main process. */
export function createInProcessSelectionAuthority(
  options: SelectionAuthorityEngineOptions,
): InProcessSelectionAuthority {
  const engine = new SelectionAuthorityEngineImpl(options);
  const client = createInProcessSelectionAuthorityClient(engine, options.log);
  return {
    engine,
    client,
    dispose: () => {
      client.dispose();
      engine.dispose();
    },
  };
}

/**
 * A {@link HostFleetSource} backed by an in-memory snapshot - the browser/dev
 * and test composition of the port. It keeps the contract's race rules
 * honest: `publish` hands the new snapshot to every listener itself (so
 * subscribe-before-read cannot lose a change), the tuple is replaced whole,
 * and the revision it stamps is process-lifetime monotonic.
 */
export class InMemoryHostFleetSource implements HostFleetSource {
  private current: HostFleetSnapshot;
  private revisionCounter: number;
  private readonly listeners = new Set<(snapshot: HostFleetSnapshot) => void>();

  constructor(initial: HostFleetSnapshot) {
    this.current = initial;
    this.revisionCounter = initial.revision;
  }

  snapshot(): HostFleetSnapshot {
    return this.current;
  }

  onChanged(
    listener: (snapshot: HostFleetSnapshot) => void,
  ): SelectionSubscription {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** Publishes a new membership tuple at the next revision. */
  publish(
    identityGeneration: number,
    localHostId: string | null,
    hosts: HostFleetSnapshot["hosts"],
  ): void {
    this.revisionCounter += 1;
    this.current = {
      revision: this.revisionCounter,
      identityGeneration,
      localHostId,
      hosts,
    };
    for (const listener of Array.from(this.listeners)) {
      listener(this.current);
    }
  }
}

/** An {@link AuthorityIdentitySource} over an in-memory identity. */
export class InMemoryAuthorityIdentitySource implements AuthorityIdentitySource {
  private identity: { identityKey: string | null; generation: number };
  private readonly listeners = new Set<
    (identity: { identityKey: string | null; generation: number }) => void
  >();

  constructor(identityKey: string | null) {
    this.identity = { identityKey, generation: 0 };
  }

  current(): { identityKey: string | null; generation: number } {
    return this.identity;
  }

  onChanged(
    listener: (identity: {
      identityKey: string | null;
      generation: number;
    }) => void,
  ): SelectionSubscription {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** Advances to a new identity; the generation increments monotonically. */
  set(identityKey: string | null): void {
    this.identity = {
      identityKey,
      generation: this.identity.generation + 1,
    };
    for (const listener of Array.from(this.listeners)) {
      listener(this.identity);
    }
  }
}

/**
 * A {@link PreferredHostStore} kept in memory - browser/dev and tests. It is
 * identity-bucketed like the durable one, so the "another account inherits
 * nothing" property is exercised here too rather than only on desktop.
 */
export class InMemoryPreferredHostStore implements PreferredHostStore {
  private readonly byIdentity = new Map<string, string>();

  load(identityKey: string | null): string | null {
    if (identityKey === null) return null;
    return this.byIdentity.get(identityKey) ?? null;
  }

  save(
    identityKey: string | null,
    hostId: string | null,
  ): PreferredHostSaveResult {
    if (identityKey === null) return { ok: true };
    if (hostId === null) {
      this.byIdentity.delete(identityKey);
      return { ok: true };
    }
    this.byIdentity.set(identityKey, hostId);
    return { ok: true };
  }
}

/**
 * The local expected-outage signal for shells that own no host process. Always
 * false - and honestly so: without a HostController mutation lane there is no
 * deliberate local outage to exempt.
 */
export const inertLocalHostOutageSignal: LocalHostOutageSignal = {
  inExpectedOutage: () => false,
  onChanged: () => ({ dispose: () => undefined }),
};

/**
 * The local-provisioning port for shells that cannot provision (browser/dev,
 * tests). Refusing here is what makes the ∅ definition come out right in
 * P1.3: no usable lease AND no ensure available.
 */
export const unavailableLocalHostEnsurePort: LocalHostEnsurePort = {
  ensureReady: () =>
    Promise.resolve({
      ok: false,
      reason: "local-provisioning-unavailable",
      // Not a deferral: nothing will ever run here, so pacing a retry would
      // just delay the honest failure the ∅ definition depends on.
      deferred: false,
    }),
};
