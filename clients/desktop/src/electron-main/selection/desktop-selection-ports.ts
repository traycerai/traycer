import type { HostListFetchResult } from "@traycer-clients/shared/host-client/remote-fetcher";
import type {
  AuthorityIdentitySource,
  HostFleetEntry,
  HostFleetSnapshot,
  HostFleetSource,
  LocalHostEnsurePort,
  LocalHostOutageSignal,
  SelectionSubscription,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { AuthorityLog } from "@traycer-clients/shared/host-selection/selection-authority-engine";
import type { RegisteredHostsPush } from "../../ipc-contracts/host-types";
import type { DesktopAuthSessionSnapshot } from "../../ipc-contracts/window-types";
import type { HostControllerStatus } from "../host/host-controller-types";
import { readLastKnownLocalHostId } from "../host/local-host-identity";
import type {
  IpcDesktopAuthSession,
  IpcHostController,
  IpcHostLifecycle,
} from "../ipc/runner-ipc-bridge";

/** The generation increments ONLY when the signed-in USER changes - never on a token rotation. */
export class DesktopAuthorityIdentitySource implements AuthorityIdentitySource {
  private readonly authSession: IpcDesktopAuthSession;
  private identityKey: string | null;
  private generation = 0;
  private readonly listeners = new Set<
    (identity: { identityKey: string | null; generation: number }) => void
  >();
  private readonly onAuthSessionChange: (
    snapshot: DesktopAuthSessionSnapshot,
  ) => void;

  constructor(authSession: IpcDesktopAuthSession) {
    this.authSession = authSession;
    this.identityKey = signedInUserId(authSession.get());
    this.onAuthSessionChange = (snapshot: DesktopAuthSessionSnapshot) => {
      const nextKey = signedInUserId(snapshot);
      if (nextKey === this.identityKey) return;
      this.identityKey = nextKey;
      this.generation += 1;
      const identity = this.current();
      for (const listener of Array.from(this.listeners)) {
        listener(identity);
      }
    };
    this.authSession.on("change", this.onAuthSessionChange);
  }

  current(): { identityKey: string | null; generation: number } {
    return { identityKey: this.identityKey, generation: this.generation };
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

  dispose(): void {
    this.authSession.off("change", this.onAuthSessionChange);
    this.listeners.clear();
  }
}

/** Only a fully signed-in session names an identity (`auth-ipc.ts` parity). */
function signedInUserId(snapshot: DesktopAuthSessionSnapshot): string | null {
  return snapshot.status === "signed-in"
    ? (snapshot.profile?.userId ?? null)
    : null;
}

export interface DesktopHostFleetSourceOptions {
  readonly authnBaseUrl: string;
  readonly identity: AuthorityIdentitySource;
  readonly authSession: IpcDesktopAuthSession;
  readonly host: IpcHostLifecycle;
  /** `fetchRegisteredHostsViaHttp` in production; a double in tests. */
  readonly listRegisteredHosts: (
    authnBaseUrl: string,
    bearerToken: string,
  ) => Promise<HostListFetchResult>;
  readonly publishRegistryResponse: (push: RegisteredHostsPush) => void;
  readonly log: AuthorityLog;
}

/**
 * The snapshot type has no channel for it, so a DTO flip cannot reach a lease verdict by any path.
 * Race rules the contract requires of this port.
 */
export class DesktopHostFleetSource implements HostFleetSource {
  private readonly options: DesktopHostFleetSourceOptions;
  private currentSnapshot: HostFleetSnapshot;
  private revisionCounter = 0;
  private rows: readonly string[] = [];
  private localHostId: string | null = null;
  /**
   * It is never a duplicate ADOPTION - `adoptedSeq` below already guarantees at most one completion wins, in request order.
   * Serving such a caller from a fetch that started BEFORE the change it is reacting to returns pre-change data, and the request that would have observed the change never happens.
   */
  private refreshSeq = 0;
  private adoptedSeq = 0;
  private localIdentitySeq = 0;
  private adoptedLocalIdentitySeq = 0;
  private readonly listeners = new Set<(snapshot: HostFleetSnapshot) => void>();
  private readonly identitySubscription: SelectionSubscription;
  private readonly onHostChange: () => void;
  private disposed = false;

  constructor(options: DesktopHostFleetSourceOptions) {
    this.options = options;
    this.currentSnapshot = {
      revision: this.revisionCounter,
      identityGeneration: options.identity.current().generation,
      localHostId: null,
      hosts: [],
    };
    this.identitySubscription = options.identity.onChanged(() => {
      // Publish the empty fleet for the INCOMING generation immediately: the outgoing account's membership must not be re-published under the new identity, and the engine's own transition.
      this.rows = [];
      this.localHostId = null;
      this.publish();
      void this.refresh();
    });
    this.onHostChange = () => {
      void this.refreshLocalIdentity();
    };
    options.host.on("change", this.onHostChange);
  }

  snapshot(): HostFleetSnapshot {
    return this.currentSnapshot;
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

  /**
   * TOTAL BY CONTRACT: this never rejects, whatever its inputs do.
   * It has THREE owners - startup's fire-and-forget `void fleet.refresh()`, the identity-change subscription, and the renderer's `refreshFleet` invoke.
   */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.refreshOrThrow();
    } catch (error: unknown) {
      // WARN, not debug: this is now the single place a thrown refresh is
      // reported anywhere in the process, so it must not be the quiet level.
      // Contained must never decay into invisible.
      this.options.log.warn("[selection-fleet] registry refresh threw", {
        error: String(error),
      });
    }
  }

  private async refreshOrThrow(): Promise<void> {
    // The identity KEY is captured in the same read for the same reason: it is the account stamp the renderer push is fenced on, and reading it again after the await would name whoever.
    const identity = this.options.identity.current();
    const generation = identity.generation;
    this.refreshSeq += 1;
    const seq = this.refreshSeq;
    const bearerToken = this.options.authSession.get().token;
    if (bearerToken === null) {
      // Stamped like any other observation so it supersedes an identity read still in flight, rather than being overwritten by one that started before the sign-out.
      this.localIdentitySeq += 1;
      this.applyFetched(generation, seq, this.localIdentitySeq, null, []);
      return;
    }
    // Stamped BEFORE the read, so ordering follows what each read OBSERVED.
    this.localIdentitySeq += 1;
    const identitySeq = this.localIdentitySeq;
    const localHostId = await this.readLocalHostId();
    let result: HostListFetchResult;
    try {
      result = await this.options.listRegisteredHosts(
        this.options.authnBaseUrl,
        bearerToken,
      );
    } catch (error: unknown) {
      // The cloud read failing must not cost the LOCAL host: its identity was already read from disk, and it is real and dialable whatever the registry says.
      this.adoptLocalIdentityRead(generation, identitySeq, localHostId);
      throw error;
    }
    if (result.kind !== "ok") {
      this.options.log.debug("[selection-fleet] registry fetch failed", {
        kind: result.kind,
      });
      // Same rule as the thrown arm above: a refused registry read keeps the
      // known rows AND still adopts this machine's own identity.
      this.adoptLocalIdentityRead(generation, identitySeq, localHostId);
      return;
    }
    // Published BEFORE the id projection is adopted, and published even when `applyFetched` declines to adopt (a late completion for a retired identity).
    this.options.publishRegistryResponse({
      identityKey: identity.identityKey,
      response: result.response,
    });
    this.applyFetched(
      generation,
      seq,
      identitySeq,
      localHostId,
      result.response.hosts.map((row) => row.hostId),
    );
  }

  dispose(): void {
    this.disposed = true;
    this.identitySubscription.dispose();
    this.options.host.off("change", this.onHostChange);
    this.listeners.clear();
  }

  /** The generation is captured BEFORE the disk read for the same reason `refresh` captures it before the fetch. */
  private async refreshLocalIdentity(): Promise<void> {
    if (this.disposed) return;
    const generation = this.options.identity.current().generation;
    // One predicate for one rule: the same bearer check `refresh` uses for its signed-out branch decides here too, so the two can never disagree about what a signed-out fleet contains.
    const eligible = this.options.authSession.get().token !== null;
    // Stamped BEFORE the read, on the SAME counter a full refresh uses, so the
    // two writers of `localHostId` order by what each one observed.
    this.localIdentitySeq += 1;
    const identitySeq = this.localIdentitySeq;
    const localHostId = eligible ? await this.readLocalHostId() : null;
    if (this.disposed) return;
    if (generation !== this.options.identity.current().generation) {
      this.options.log.debug("[selection-fleet] stale local identity read", {
        generation,
      });
      return;
    }
    if (identitySeq < this.adoptedLocalIdentitySeq) {
      this.options.log.debug(
        "[selection-fleet] dropped a superseded identity",
        {
          identitySeq,
          adopted: this.adoptedLocalIdentitySeq,
        },
      );
      return;
    }
    // Recorded even when the value is unchanged: this read is still the newest
    // observation, and saying so is what stops an older in-flight refresh from
    // adopting the id it read before this one.
    this.adoptedLocalIdentitySeq = identitySeq;
    if (localHostId === this.localHostId) return;
    this.localHostId = localHostId;
    this.publishAt(generation);
  }

  private adoptLocalIdentityRead(
    generation: number,
    identitySeq: number,
    localHostId: string | null,
  ): void {
    if (this.disposed) return;
    if (generation !== this.options.identity.current().generation) return;
    if (identitySeq < this.adoptedLocalIdentitySeq) return;
    this.adoptedLocalIdentitySeq = identitySeq;
    if (localHostId === this.localHostId) return;
    this.localHostId = localHostId;
    this.publishAt(generation);
  }

  private readLocalHostId(): Promise<string | null> {
    return readLastKnownLocalHostId({
      identityEnrollmentFile: this.options.host.identityEnrollmentFile,
      pidMetadataFile: this.options.host.pidMetadataFile,
    }).catch((error: unknown) => {
      this.options.log.debug("[selection-fleet] local identity read failed", {
        error: String(error),
      });
      return null;
    });
  }

  private applyFetched(
    generation: number,
    seq: number,
    identitySeq: number,
    localHostId: string | null,
    rows: readonly string[],
  ): void {
    if (this.disposed) return;
    if (generation !== this.options.identity.current().generation) {
      this.publishSnapshot(generation, localHostId, rows);
      return;
    }
    if (seq < this.adoptedSeq) {
      // Declining keeps request order - an older response landing last must not resurrect rows the newer one removed.
      // Ordered AFTER the generation branch above on purpose: a retired identity's stale-stamped publish is a contract of its own.
      this.options.log.debug("[selection-fleet] dropped a superseded refresh", {
        seq,
        adopted: this.adoptedSeq,
      });
      return;
    }
    this.adoptedSeq = seq;
    this.rows = rows;
    // The ID is fenced SEPARATELY from the rows: this refresh's row projection can be the current one while the id it read before the fetch has since been superseded by a local-identity.
    if (identitySeq >= this.adoptedLocalIdentitySeq) {
      this.adoptedLocalIdentitySeq = identitySeq;
      this.localHostId = localHostId;
    } else {
      this.options.log.debug("[selection-fleet] kept a newer local identity", {
        identitySeq,
        adopted: this.adoptedLocalIdentitySeq,
      });
    }
    this.publishAt(generation);
  }

  /** Publishes under the generation that is current right now. */
  private publish(): void {
    this.publishAt(this.options.identity.current().generation);
  }

  private publishAt(generation: number): void {
    this.publishSnapshot(generation, this.localHostId, this.rows);
  }

  private publishSnapshot(
    generation: number,
    localHostId: string | null,
    rows: readonly string[],
  ): void {
    this.revisionCounter += 1;
    this.currentSnapshot = {
      revision: this.revisionCounter,
      identityGeneration: generation,
      localHostId,
      hosts: composeFleetEntries(localHostId, rows),
    };
    for (const listener of Array.from(this.listeners)) {
      listener(this.currentSnapshot);
    }
  }
}

function composeFleetEntries(
  localHostId: string | null,
  rows: readonly string[],
): readonly HostFleetEntry[] {
  const entries: HostFleetEntry[] = rows.map((hostId) => ({
    hostId,
    kind: hostId === localHostId ? "local" : "remote",
  }));
  if (localHostId !== null && !rows.includes(localHostId)) {
    entries.push({ hostId: localHostId, kind: "local" });
  }
  return entries.sort((left, right) =>
    left.hostId < right.hostId ? -1 : left.hostId > right.hostId ? 1 : 0,
  );
}

export interface DesktopLocalHostOutageSignalOptions {
  readonly subscribe: (
    listener: (status: HostControllerStatus) => void,
  ) => () => void;
  readonly readStatus: () => Promise<HostControllerStatus>;
  readonly log: AuthorityLog;
}

/** The engine caps how long it will hold a lease on this signal, so a lane that never reports completion cannot pin a host in `restarting-expected`. */
export class DesktopLocalHostOutageSignal implements LocalHostOutageSignal {
  private readonly options: DesktopLocalHostOutageSignalOptions;
  private busy = false;
  private observedBroadcast = false;
  private readonly listeners = new Set<(inExpectedOutage: boolean) => void>();
  private readonly unsubscribe: () => void;

  constructor(options: DesktopLocalHostOutageSignalOptions) {
    this.options = options;
    this.unsubscribe = options.subscribe((status) => {
      this.observedBroadcast = true;
      this.apply(status.mutation !== null);
    });
    void options
      .readStatus()
      .then((status) => {
        if (this.observedBroadcast) return;
        this.apply(status.mutation !== null);
      })
      .catch((error: unknown) => {
        // A failed read is not evidence of an outage; stay false and let the
        // next broadcast tick correct it.
        options.log.debug("[selection-outage] initial status read failed", {
          error: String(error),
        });
      });
  }

  inExpectedOutage(): boolean {
    return this.busy;
  }

  onChanged(
    listener: (inExpectedOutage: boolean) => void,
  ): SelectionSubscription {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  private apply(busy: boolean): void {
    if (busy === this.busy) return;
    this.busy = busy;
    for (const listener of Array.from(this.listeners)) {
      listener(busy);
    }
  }
}

export function createDesktopLocalHostEnsurePort(
  hostController: IpcHostController,
): LocalHostEnsurePort {
  return {
    ensureReady: async () => {
      const outcome = await hostController.convergeReady(false, {
        kind: "background",
      });
      if (outcome.kind === "ok") {
        if (outcome.value.running) return { ok: true };
        return { ok: false, reason: "removed-by-user", deferred: false };
      }
      // `assertHostNotBusy` raises it when a live PID's idle state CANNOT BE DETERMINED.
      // A WEDGED host is exactly the first case, so crediting it handed `onHostProvedAlive` a host that cannot serve: refusal evidence cleared, the lease usable, failover free to pick it.
      return {
        ok: false,
        reason: outcome.kind,
        deferred: outcome.kind === "deferred" || outcome.kind === "busy",
      };
    },
  };
}
