/**
 * Desktop composition of the selection authority's engine ports (P1.1).
 *
 * The engine is transport-agnostic; these four adapters are what main already
 * owns, expressed as the contract's ports:
 *
 *  - {@link DesktopAuthorityIdentitySource} - the auth-session state.
 *  - {@link DesktopHostFleetSource} - the registry list fetch main already
 *    runs for CORS reasons, plus this machine's durable local-host identity.
 *  - {@link DesktopLocalHostOutageSignal} - the `HostController` mutation
 *    lane (D5's expected-outage signal).
 *  - {@link createDesktopLocalHostEnsurePort} - the provisioning controller,
 *    wired but NOT invoked until P1.3.
 *
 * None of them is wire surface: they are constructor inputs to the engine.
 */
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

/**
 * The identity the persisted preference is scoped to, and the generation the
 * engine keys membership on.
 *
 * The generation increments ONLY when the signed-in USER changes - never on a
 * token rotation. That distinction is the whole safety property: the auth
 * session emits a change on every credential refresh, and bumping the
 * generation there would wipe every scrap of evidence (sessions, streaks,
 * compat, tombstones) and force every window to re-attach on a routine token
 * refresh. `signing-in` and `signed-out` both collapse to a null key, so
 * signing back in as the same user is one transition out and one back.
 */
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
  /**
   * Hands the FULL registry rows to whoever needs them for display, once per
   * successful fetch.
   *
   * This is what makes main's cadence serve both consumers from ONE request.
   * The authority needs ids; every window needs the rows (names, connectivity,
   * update state) it used to fetch for itself. Rather than stand up a second
   * poll - the exact duplication connection registry §6 says to collapse -
   * this port publishes what it has already read, and the two projections
   * diverge AFTER the single fetch.
   *
   * The snapshot half below is deliberately NOT widened to carry these rows:
   * `HostFleetSnapshot` has no channel for a status DTO, which is invariant 5
   * enforced by construction, and that stays true.
   *
   * Required rather than optional: a composition that forgets it produces an
   * app whose windows silently stop learning about registry changes, which is
   * not a failure anything reports.
   */
  readonly publishRegistryResponse: (push: RegisteredHostsPush) => void;
  readonly log: AuthorityLog;
}

/**
 * The authority's fleet port on desktop: WHICH hosts exist and which one is
 * this machine's - and deliberately nothing else.
 *
 * The registry response carries a full status DTO per row (connectivity,
 * viewer reachability, update state). NONE of it is projected here. The
 * snapshot type has no channel for it, so a DTO flip cannot reach a lease
 * verdict by any path - which is invariant 5 ("cloud verdicts are
 * display/bootstrap only") enforced by construction rather than by care.
 *
 * Race rules the contract requires of this port:
 *
 *  - `{localHostId, hosts}` is ONE atomic tuple per snapshot: both are
 *    resolved before anything is published, never composed from two reads.
 *  - `onChanged` delivers the snapshot itself, so subscribe-before-read
 *    cannot lose a change.
 *  - `revision` is process-lifetime monotonic and never resets, including
 *    across sign-out.
 *  - Every snapshot is stamped with the identity generation captured when its
 *    FETCH STARTED, so a late account-A completion is rejected by the engine
 *    however high its revision is.
 *
 * The 60 s cadence that drives {@link DesktopHostFleetSource.refresh} lives in
 * `ipc/registered-hosts-broadcast.ts` rather than here, and that split is the
 * point: this port owns HOW a registry read becomes a fleet snapshot, and the
 * broadcast module owns WHEN one happens and who else hears it. The earlier
 * interim ("there is no poller here") is discharged - the consolidated timer
 * this port was waiting for is that module, not a competitor to it, and every
 * race rule above applies to its ticks unchanged because they arrive through
 * `refresh()` like every other caller.
 */
export class DesktopHostFleetSource implements HostFleetSource {
  private readonly options: DesktopHostFleetSourceOptions;
  private currentSnapshot: HostFleetSnapshot;
  private revisionCounter = 0;
  private rows: readonly string[] = [];
  private localHostId: string | null = null;
  /**
   * Monotonic refresh sequence (same-identity ordering). The generation stamp
   * orders completions ACROSS identities; within one identity, two overlapping
   * refreshes (the 60s poll racing a registration's fire-and-forget refresh)
   * complete in network order, and adopting the older completion last would
   * resurrect rows the newer one removed - a deregistered host reappearing in
   * the authority for up to a full poll interval. Stamped at fetch START,
   * adopted only if no newer same-generation completion beat it.
   *
   * ⚠ ORDERING WITHOUT IN-FLIGHT DEDUPE IS THE DESIGN, NOT A MISSING
   * OPTIMIZATION. A perf audit (2026-08-17) filed the absent dedupe as a
   * finding: overlapping refreshes each issue a fetch and the older completion
   * is declined, so one of the two round trips is "wasted". The measurement is
   * right and the conclusion is not, and this note is here because the risk is
   * not someone breaking it by accident - it is someone FIXING it, correctly
   * following a number.
   *
   * What is actually paid, and what is not: the cost of no dedupe is a
   * duplicate FETCH. It is never a duplicate ADOPTION - `adoptedSeq` below
   * already guarantees at most one completion wins, in request order. So the
   * bug the dedupe would prevent does not exist; only the network call does,
   * bounded to roughly two in practice (the 60s poll racing a deregister).
   *
   * What coalescing would cost is a correctness property, and it is one this
   * port has already been bitten by. Callers refresh BECAUSE something
   * changed - a registration, a deregistration, an identity change. Serving
   * such a caller from a fetch that started BEFORE the change it is reacting
   * to returns pre-change data, and the request that would have observed the
   * change never happens. `adoptedSeq` cannot catch that: the stale completion
   * genuinely IS the newest completion of the only in-flight fetch, so the
   * guard agrees with it rather than declining it.
   *
   * The proof that this is not hypothetical is the SECOND counter below.
   * `localIdentitySeq` exists because a local-identity change that landed
   * during a refresh's fetch was published and then overwritten by the id that
   * refresh had read before its request - a shipped bug, from exactly the
   * class dedupe re-introduces, and one that left the authority calling the
   * stale host local and this machine remote until the next host event.
   * Coalescing would recreate that shape for the ROWS, where there is no
   * third counter to rescue it.
   */
  private refreshSeq = 0;
  private adoptedSeq = 0;
  /**
   * Monotonic LOCAL-IDENTITY sequence, and deliberately not the same counter
   * as `refreshSeq`.
   *
   * `this.localHostId` has TWO writers - a full `refresh()`, which reads the
   * id before its registry fetch and adopts it after, and
   * `refreshLocalIdentity()`, which reads and adopts with no fetch in between.
   * `refreshSeq` orders refreshes against each other only, so a local-identity
   * change that landed DURING a refresh's fetch was published first and then
   * overwritten by the id that refresh had read before the request: the
   * authority classified the stale host as local and this machine as remote
   * until the next host event or the 60s poll.
   *
   * Stamped at the moment each read STARTS, so the most recently OBSERVED disk
   * state wins regardless of completion order, and adopted independently of
   * the row projection - a refresh whose rows are current may still carry a
   * superseded id, and only the id is declined.
   */
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
      // Publish the empty fleet for the INCOMING generation immediately: the
      // outgoing account's membership must not be re-published under the new
      // identity, and the engine's own transition has already swapped to
      // empty. The local id is cleared too - this machine's host belongs to
      // the machine, but its MEMBERSHIP belongs to an account, and the new
      // one has not been read yet. The refresh that follows lands as an
      // ordinary fleet shift.
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
   * Re-reads this machine's identity and the account's registry rows, then
   * publishes ONE tuple. Safe to call at any time; a failed fetch publishes
   * nothing rather than clobbering known membership with a network error.
   *
   * TOTAL BY CONTRACT: this never rejects, whatever its inputs do. It has
   * THREE owners - startup's fire-and-forget `void fleet.refresh()`, the
   * identity-change subscription, and the renderer's `refreshFleet` invoke -
   * and only the last of those had a caller wrapping it. `listRegisteredHosts`
   * returning a non-`ok` RESULT was already handled; `listRegisteredHosts` (or
   * the local-host read) THROWING was not, so a genuine network exception
   * escaped into an unhandled rejection on two of the three paths and, on the
   * third, surfaced to the renderer as a failed invoke on an operation that had
   * already succeeded. Containing it at the source rather than at each caller
   * is what makes the guarantee independent of who remembers to wrap.
   *
   * Failing to refresh costs one stale cycle, which the next identity change,
   * local-host change or explicit call re-reads anyway - strictly cheaper than
   * any way of surfacing it.
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
    // Stamped at fetch START (contract: "the generation this snapshot was
    // FETCHED under"), so a completion that lands after an account switch is
    // recognisably stale. The identity KEY is captured in the same read for
    // the same reason: it is the account stamp the renderer push is fenced on,
    // and reading it again after the await would name whoever is signed in
    // when the response happens to land.
    const identity = this.options.identity.current();
    const generation = identity.generation;
    this.refreshSeq += 1;
    const seq = this.refreshSeq;
    const bearerToken = this.options.authSession.get().token;
    if (bearerToken === null) {
      // Signed out: the account fleet is empty, and the local host is not
      // addressable without a credential context either. Stamped like any
      // other observation so it supersedes an identity read still in flight,
      // rather than being overwritten by one that started before the sign-out.
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
      // The cloud read failing must not cost the LOCAL host: its identity was
      // already read from disk, and it is real and dialable whatever the
      // registry says. Adopt-and-publish it before letting the error reach
      // `refresh`'s containment, or a machine with a flaky network boots into
      // "No host is available" for up to a full poll interval (60s) - the
      // membership rows can wait for the next successful fetch, local
      // usability cannot.
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
    // Published BEFORE the id projection is adopted, and published even when
    // `applyFetched` declines to adopt (a late completion for a retired
    // identity). Both are deliberate: the push carries the identity it was
    // FETCHED under, so a renderer on another account drops it by the same
    // rule the engine rejects the snapshot by - one stamp, two readers, no
    // second staleness policy.
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

  /**
   * pid.json moved: re-resolve local identity, keep the known rows.
   *
   * The generation is captured BEFORE the disk read for the same reason
   * `refresh` captures it before the fetch. Without it, a read that started
   * under account A and completed after a sign-out wrote A's local host into
   * the cache and published it stamped with the CURRENT generation - so the
   * engine's identity guard, which only inspects the stamp, admitted account
   * A's machine into account B's fleet. That also contradicted the signed-out
   * branch of `refresh`, which publishes `localHostId: null`.
   */
  private async refreshLocalIdentity(): Promise<void> {
    if (this.disposed) return;
    const generation = this.options.identity.current().generation;
    // ELIGIBILITY is captured with the generation, not just the generation.
    // The generation capture closes the RACE; it does not carry the rule.
    // After a sign-out has fully committed there is no race left, and a
    // later local-host change would still publish this machine's durable id
    // under the CURRENT (signed-out) generation - which the engine accepts,
    // repopulating a fleet that `refresh` has just declared empty. One
    // predicate for one rule: the same bearer check `refresh` uses for its
    // signed-out branch decides here too, so the two can never disagree
    // about what a signed-out fleet contains.
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

  /**
   * Adopts a local-identity read that has no registry rows to travel with -
   * the failure arms of `refreshOrThrow`. Same fences as
   * `refreshLocalIdentity`, in the same order: the generation guard drops a
   * read that straddled an account switch, the seq guard drops one a newer
   * writer has superseded, and the value guard keeps an unchanged id from
   * publishing a no-op revision.
   */
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
      // A late completion for a RETIRED identity. It is still published -
      // stamped with the generation it was fetched under, which is exactly
      // what lets the engine reject it - but it is NOT adopted as this port's
      // membership. Adopting it would be the subtle half of the bug: a later
      // local-host republish would carry the old account's rows under the
      // CURRENT generation and sail straight past the engine's guard.
      this.publishSnapshot(generation, localHostId, rows);
      return;
    }
    if (seq < this.adoptedSeq) {
      // Same-identity ordering (see `refreshSeq`): a newer completion was
      // adopted while this one awaited. Declining keeps request order - an
      // older response landing last must not resurrect rows the newer one
      // removed. Ordered AFTER the generation branch above on purpose: a
      // retired identity's stale-stamped publish is a contract of its own.
      this.options.log.debug("[selection-fleet] dropped a superseded refresh", {
        seq,
        adopted: this.adoptedSeq,
      });
      return;
    }
    this.adoptedSeq = seq;
    this.rows = rows;
    // The ID is fenced SEPARATELY from the rows: this refresh's row projection
    // can be the current one while the id it read before the fetch has since
    // been superseded by a local-identity change. Adopting the tuple wholesale
    // is what let the stale id win.
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

/**
 * The atomic membership tuple. The local host is SYNTHESIZED when this machine
 * has a durable identity the registry response does not list: it is real and
 * dialable over the local socket whatever the cloud says, and omitting it
 * would hide the one candidate D8 wants first. Sorted so a server-side
 * reordering is not mistaken for a membership change.
 *
 * Takes its inputs as arguments rather than reading the port's cache, so a
 * stale-generation completion can be published verbatim without touching it.
 */
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
  /**
   * Subscribes to the canonical two-lane status broadcast main already
   * computes (`onHostControllerStatusBroadcast`), returning an unsubscribe.
   * Reusing that tick source is deliberate: a second poll loop against
   * `getStatus()` would re-create the main-thread starvation the broadcast's
   * serialization exists to prevent.
   */
  readonly subscribe: (
    listener: (status: HostControllerStatus) => void,
  ) => () => void;
  readonly readStatus: () => Promise<HostControllerStatus>;
  readonly log: AuthorityLog;
}

/**
 * D5's LOCAL expected-outage signal: true while the `HostController` mutation
 * lane has an operation in flight.
 *
 * Every mutation kind counts, not just restarts. The lane is busy exactly
 * when the desktop shell itself took the host down (ensure, apply, activate,
 * install, respawn, recovery, free-port-and-restart, uninstall), and in every
 * one of those the outage is deliberate - which is the whole predicate. The
 * engine caps how long it will hold a lease on this signal, so a lane that
 * never reports completion cannot pin a host in `restarting-expected`.
 */
export class DesktopLocalHostOutageSignal implements LocalHostOutageSignal {
  private readonly options: DesktopLocalHostOutageSignalOptions;
  private busy = false;
  /**
   * Whether a live broadcast tick has landed. The initial `readStatus()` is a
   * READ racing a SUBSCRIPTION: a mutation that starts while that read is in
   * flight arrives on the broadcast first, and letting the older read answer
   * afterwards would clear the exemption for an outage that is genuinely
   * under way - a false negative at exactly the wrong moment (P1.3 would fail
   * over off a host the shell itself is restarting).
   */
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

/**
 * The engine's one sanctioned process action (D14/C5), wired to the real
 * provisioning controller.
 *
 * P1.1 composes it and NEVER calls it: the caller is P1.3's derivation, which
 * requests `ensure` when it wants the local host and that host is down, and
 * surfaces the outcome as the local lease's own status. Wiring it now means
 * P1.3 adds a call site, not a port.
 */
export function createDesktopLocalHostEnsurePort(
  hostController: IpcHostController,
): LocalHostEnsurePort {
  return {
    ensureReady: async () => {
      const outcome = await hostController.convergeReady(false);
      if (outcome.kind === "ok") return { ok: true };
      // Two non-ok outcomes say nothing dead-worthy about the host, and the
      // engine must not turn either into a dead lease: `deferred` is the
      // controller's word for "the lane or its CLI lock was busy, nothing
      // ran", and `busy` is a HOST that is up with active work - the converge
      // declined to disrupt it, which is proof of life, not death.
      return {
        ok: false,
        reason: outcome.kind,
        deferred: outcome.kind === "deferred" || outcome.kind === "busy",
      };
    },
  };
}
