import type { AuthEra } from "@traycer-clients/shared/auth/request-context-provider";
import {
  isHostReachable,
  type HostDirectoryEntry,
} from "@traycer-clients/shared/host-client/host-directory";
import type { IHostDirectoryService } from "@traycer-clients/shared/host-client/host-runtime";
import {
  fetchRemoteHosts,
  hostUnavailability,
  isRelayFuseRecoveryCandidate,
  isRemoteHostDirectoryEntry,
  type RemoteHostFetchOutcome,
  type RemoteHostFetcher,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import type {
  IRunnerHost,
  LocalHostSnapshot,
} from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import { appLogger, describeLogError } from "@/lib/logger";
import { requestFleetRefresh } from "@/lib/host/fleet-refresh";
import { lastLocalHostIdKey } from "@/lib/persist";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

/**
 * The app's ONE background cadence for `GET /api/v3/hosts`.
 *
 * This service is mounted globally, so its interval — not the Settings query's
 * — is what sets the app's steady-state load against that endpoint. It ran at
 * 15s, which meant the Settings poll's move to 60s changed nothing about the
 * real shape: an open GUI still issued ~5.8k liveness reads a day from here.
 *
 * 60s matches the Settings observer deliberately. Liveness is relay attachment
 * now: a clean detach is pushed to the cloud in seconds and a dirty one is
 * bounded by the lease TTL regardless of how often anyone asks, so polling
 * faster than the lease buys a fresher answer to nothing. What actually keeps
 * the directory current is the event set around this interval — a picker
 * opening, the request context changing, the local host publishing, a
 * deregister — all of which refresh immediately.
 *
 * Keep this in step with `REGISTERED_HOSTS_POLL_MS`. Two independent 60s
 * timers against one endpoint is not the goal either; they are separate only
 * because this one predates TanStack and lives outside its cache.
 */
const HOST_DIRECTORY_REFRESH_POLL_MS = 60_000;
const LAST_LOCAL_HOST_ID_STORAGE_KEY = lastLocalHostIdKey();

export interface HostDirectoryServiceOptions {
  readonly runnerHost: IRunnerHost;
  /**
   * Fetcher for remote hosts. Defaults to the shared stubbed
   * `fetchRemoteHosts` (returns an empty hosts result) so the composition is
   * the same in production and tests; tests can pass a custom fetcher to
   * assert merged directory behavior.
   */
  readonly remoteFetcher: RemoteHostFetcher | null;
  /**
   * Fired on each poll tick so the app's other registry readers can refresh
   * off this ONE timer (redesign P4.1 / F22). `null` for shells and tests
   * with no query cache to invalidate.
   *
   * Required rather than optional for the same reason `connectionRegistry`
   * is on `HostRuntimeOptions`: a construction site that forgets it produces
   * a window whose Settings liveness silently stops refreshing, which is not
   * a failure anything reports. A required field makes forgetting a compile
   * error.
   */
  readonly onRegistryPollTick: (() => void) | null;
  /**
   * Identity of the auth context a refresh is being made ON BEHALF OF, read at
   * the moment it is needed. `null` disables identity scoping — correct only
   * for tests with a single implicit account.
   *
   * Injected rather than read off `AuthService` inside the service for the same
   * reason `remoteFetcher` is: this class is constructed outside React and the
   * composition root stays the one place that decides how a shell request is
   * made. It must NOT be the bearer — that deliberately never leaves
   * `AuthService`; a user id is enough to tell two accounts apart.
   */
  readonly authContextId: (() => string | null) | null;
  /**
   * Monotonic counter that advances on every credential change, INCLUDING a
   * same-user rotation. `null` disables the credential fence — tests only.
   *
   * Separate from `authContextId` on purpose: a rotation is invisible to a
   * user-id fence, and only DESTRUCTIVE commits need to see it.
   *
   * Must be a real credential counter. Wiring an identity-transition counter
   * here type-checks and reads plausibly, and leaves the fence permanently
   * open on exactly the case it was built for — a same-user rotation, the only
   * way a still-matching user id can produce a stale 401.
   */
  readonly credentialGeneration: (() => number) | null;
  /**
   * Resolves this machine's durable local host id (see
   * `lastKnownLocalHostId`). Injected like `remoteFetcher` rather than read off
   * `runnerHost` inside the service: this class is constructed outside React
   * and cannot use hooks, so the composition root stays the one place that
   * decides HOW a shell request is made. `null` uses the runner-host bridge,
   * which is what every production shell wants; tests pass their own.
   */
  readonly localHostIdSeeder: (() => Promise<string | null>) | null;
}

export type HostDirectoryListener = (
  entries: readonly HostDirectoryEntry[],
  localEntry: HostDirectoryEntry | null,
) => void;

/**
 * GUI-owned host directory implementing the shared
 * `IHostDirectoryService` port consumed by `HostRuntime`.
 *
 * Composes the event-only `IRunnerHost.onLocalHostChange(...)` stream with
 * the shared stubbed `fetchRemoteHosts` so the merged directory has a
 * stable shape regardless of remote discovery progress (D3).
 *
 * Selection is not decided here, and since redesign P4.2 it is not HELD here
 * either. The per-app selection authority owns `preferredHostId` and derives
 * `effectiveHostId`; the renderer bridge parks that verdict in the authority
 * store, and every consumer resolves it into a client through a pinned
 * requester at read time. This class used to mirror that verdict - a bound
 * row, a pointer to re-resolve it from, and a listener fan-out into
 * `HostClient.bind()` - and all three died with the active slot. What it owns
 * is RESOLUTION and nothing else: which directory row an id currently names. There is no default promotion, no
 * persisted restore, and no auto-failover here any more - the fields and
 * machinery for all three are deleted, not shadowed.
 *
 * `refresh()` only ever replaces `remoteEntries` on a genuine `hosts` or
 * `signed-out` fetcher outcome; a `failed` outcome retains the last-known
 * entries instead of unbinding an active remote selection (T20 / audit P4).
 *
 * The service never calls any `getLocalHost()` accessor; the current
 * snapshot is the most recent value delivered through the subscription.
 * Subscribing to `onLocalHostChange` fires synchronously with the current
 * snapshot, so `start()` does not need a separate seeding fetch.
 */
export class HostDirectoryService implements IHostDirectoryService {
  private readonly runnerHost: IRunnerHost;
  private readonly remoteFetcher: RemoteHostFetcher;
  private readonly onRegistryPollTick: (() => void) | null;
  private readonly authContextId: () => string | null;
  private readonly credentialGeneration: () => number;
  private readonly localHostIdSeeder: () => Promise<string | null>;
  private localEntry: HostDirectoryEntry | null = null;
  /**
   * The hostId this MACHINE's local host last published.
   *
   * The registry also lists this machine, so during a local restart
   * (reinstall, update, crash recovery) the merged directory's only entry for
   * that id is the registry's remote-kind twin: "available" by presence lease,
   * dialable on paper, but reached through the relay - the one transport that
   * must never carry this machine's own host. Binding it also flips
   * `localTarget` off, which DISABLES the local provisioning lifecycle exactly
   * when it is needed, leaving the dead-end "unavailable" card with no Retry.
   *
   * `snapshot()` therefore rewrites that twin into a NON-DIALABLE LOCAL entry
   * rather than dropping it. Dropping it looked simpler but silently broke
   * selection: the id then resolved to nothing, so the authority's verdict
   * for this machine bound nothing while the local host was booting - the
   * window sat unbound with a row for it sitting right there. Keeping the id
   * resolvable preserves the binding while still refusing the relay.
   *
   * Seeded widest-first: the persisted value, the shell's durable pid metadata
   * (which still answers while the host is DOWN - the case the persisted value
   * cannot cover on the first launch after the upgrade that introduced it),
   * and every live local snapshot. Never cleared, only replaced: the id is a
   * durable machine fact, and a stale value can only neutralise the twin of a
   * host this machine no longer runs - which nothing should relay-dial anyway.
   */
  private lastKnownLocalHostId: string | null = loadPersistedLocalHostId();
  private remoteEntries: readonly HostDirectoryEntry[] = [];
  /**
   * The snapshot most recently fanned out through `emit()`, kept so the poll
   * path (`emitIfSnapshotChanged`) can suppress no-change re-emits. `null`
   * only before the first emit.
   */
  private lastEmittedSnapshot: readonly HostDirectoryEntry[] | null = null;
  private readonly listeners = new Set<HostDirectoryListener>();
  private localSubscription: Disposable | null = null;
  private started = false;
  private refreshIntervalId: number | null = null;
  private visibilityDocument: Document | null = null;
  /**
   * The shell's own registry cadence, when it has one (desktop's main process
   * — redesign P4.1/F22). Non-null means this window arms NO interval of its
   * own: the push IS the tick.
   */
  private registrySubscription: Disposable | null = null;
  /**
   * Coalesces concurrent `refresh()` callers onto a single in-flight fetch
   * (T20 / audit P4) - a foundation for T21's interval + open-time triggers,
   * which would otherwise stack requests.
   */
  /**
   * The in-flight refresh, WITH the credential era it was started for. Joining
   * is only legal for a caller in that same era — see `refreshForEra`.
   */
  private refreshInFlight: {
    readonly era: AuthEra;
    readonly request: Promise<readonly HostDirectoryEntry[]>;
  } | null = null;
  /**
   * The credential generation of the most recent COMMITTED outcome - the
   * ordering half of the commit guard. The era fences answer "may this
   * credential's observation be believed at all"; this watermark answers "has
   * a NEWER credential's observation already landed". Without it, commits are
   * last-write-wins across generations: a `hosts` read issued before a
   * same-user rotation, resolving after the post-rotation refresh has already
   * committed, would overwrite the newer list with the older one (the
   * generation counter only ever grows, which is what makes this a total
   * order worth fencing on).
   */
  private lastCommitCredentialGeneration: number | null = null;
  /**
   * The identity the committed `remoteEntries` belong to - the OWNERSHIP half
   * of the retention rule. The `failed` branch keeps the last-known list on
   * the grounds that a network blip should not blank a directory, but that
   * grounds only holds when the list describes the SAME account: after a
   * direct A -> B account switch whose first read under B fails, retaining
   * would keep A's machines visible - and A's selection bindable - under B's
   * signed-in session until a later read succeeds.
   */
  private lastCommitIdentity: string | null = null;
  private readonly handleVisibilityChange = (): void => {
    if (this.isDocumentHidden()) {
      return;
    }
    // Resume from hidden: refresh now AND rearm the poll clock from this
    // point, so the already-scheduled tick (whatever was left of its
    // pre-hidden schedule) doesn't also fire moments later.
    this.armPollInterval();
    void this.refresh();
  };

  /**
   * The push-riding twin of {@link handleVisibilityChange}: no poll clock to
   * rearm, so a resume acts only on a push that arrived while hidden.
   */
  private readonly handleVisibilityChangeWhileRidingPushes = (): void => {
    if (this.isDocumentHidden() || !this.pushMissedWhileHidden) {
      return;
    }
    this.pushMissedWhileHidden = false;
    this.applyRegistryPush();
  };
  private pushMissedWhileHidden = false;

  constructor(options: HostDirectoryServiceOptions) {
    this.runnerHost = options.runnerHost;
    this.onRegistryPollTick = options.onRegistryPollTick;
    this.remoteFetcher =
      options.remoteFetcher === null ? fetchRemoteHosts : options.remoteFetcher;
    this.localHostIdSeeder =
      options.localHostIdSeeder === null
        ? () => options.runnerHost.getLastKnownLocalHostId()
        : options.localHostIdSeeder;
    this.authContextId =
      options.authContextId === null ? () => null : options.authContextId;
    this.credentialGeneration =
      options.credentialGeneration === null
        ? () => 0
        : options.credentialGeneration;
  }

  /**
   * Initializes the service. Subscribes to local host changes via
   * `IRunnerHost.onLocalHostChange` and performs an initial remote fetch.
   * Safe to call multiple times - subsequent calls are no-ops.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    // BEFORE the first refresh: the very first launch after the upgrade that
    // introduced the persisted key has nothing stored, and that launch is
    // exactly the reinstall this guard exists for - the host is down, so no
    // snapshot will seed it either. The shell's pid metadata is the one source
    // that still answers in that window. A shell without a local host (web,
    // mobile) answers `null` and nothing is neutralised.
    await this.seedLocalHostIdFromShell();
    // The seed introduced an await BEFORE the subscription exists, so a
    // provider that unmounts or swaps its runner mid-flight can call
    // `dispose()` while nothing is registered yet. Without this recheck
    // `start()` would resume onto a disposed service and install a local-host
    // listener that no `dispose()` will ever remove - an orphan dispatching
    // stale callbacks for the life of the page. The later stopped-state guard
    // sits after the remote refresh, too far in to prevent that.
    if (!this.isStarted()) {
      return;
    }
    this.localSubscription = this.runnerHost.onLocalHostChange((snapshot) => {
      this.localEntry = toLocalEntry(snapshot);
      if (snapshot !== null && snapshot.hostId !== this.lastKnownLocalHostId) {
        this.adoptLocalHostId(snapshot.hostId);
      }
      appLogger.debug("[host-directory] local host snapshot changed", {
        hostId: snapshot?.hostId ?? null,
        hasWebsocketUrl: snapshot !== null,
        status: snapshot === null ? "missing" : "available",
        version: snapshot?.version ?? null,
      });
      this.emit();
    });
    await this.refresh();
    // Read through a method, not the bare field: `dispose()` can flip
    // `this.started` to `false` while this `await` is pending, but a direct
    // `this.started` read here is narrowed by the compiler to the literal
    // `true` assigned above and the guard is flagged as dead code.
    if (!this.isStarted()) {
      return;
    }
    this.startRefreshPolling();
  }

  private isStarted(): boolean {
    return this.started;
  }

  list(): Promise<readonly HostDirectoryEntry[]> {
    return Promise.resolve(this.snapshot());
  }

  /**
   * This machine's own local host id as the directory knows it: seeded from
   * the shell's durable pid metadata, then adopted from every local snapshot.
   * `null` only on a machine whose local host has never announced itself.
   *
   * In-memory ON PURPOSE. `persistLocalHostId` swallows write failures by
   * design (a blocked quota must never break selection), so a consumer that
   * re-read storage would see `null` on a machine that is very much running a
   * host - and the local-boot gate that reads this would then decide the
   * wrong thing about provisioning it.
   */
  getLocalHostId(): string | null {
    return this.lastKnownLocalHostId;
  }

  /**
   * Refresh the merged directory, coalescing concurrent callers.
   *
   * ERA-SCOPED, at every point that needs it — and needing it at more than one
   * point is the lesson. `AuthService.fetchRegisteredHosts` is bearer-keyed,
   * but this memo sits ABOVE it and returned before that key was ever
   * consulted: an account switch while A's poll was pending joined B's
   * mandatory refresh to A's promise, and A's hosts were committed into B's
   * long-lived directory.
   *
   * Keying this memo alone does not close it either. A refresh that STARTED
   * legally under A can still resolve after the switch, and `performRefresh`
   * writes `remoteEntries` and reconciles the selection unconditionally — so
   * the commit is guarded separately, inside `performRefresh`.
   *
   * The invariant, stated once because it keeps being rediscovered one layer
   * at a time: **an identity guard belongs at every layer that MEMOIZES,
   * FETCHES or COMMITS — and all of them must be guarding on the SAME value.**
   * Guarding each layer against its own ambient read is what produced four
   * consecutive fixes that were individually correct and jointly useless: the
   * memo asked one source, the commit asked another, and the fetch asked a
   * third. They now all take the era from one place, `refreshForEra`.
   */
  refresh(): Promise<readonly HostDirectoryEntry[]> {
    // An AMBIENT caller — the poll, a focus refetch, picker-open, a local-host
    // transition. Nothing is mid-transition, so reading both halves of the era
    // here reads one settled state. A caller reacting to a TRANSITION must not
    // come through here; see `refreshForEra`.
    return this.refreshForEra({
      identity: this.authContextId(),
      credentialGeneration: this.credentialGeneration(),
    });
  }

  /**
   * Refresh on behalf of an EXPLICITLY NAMED credential era.
   *
   * The context-change path must use this, not `refresh()`. An era assembled
   * from the ambient accessors during an auth emission is not one era: the
   * emission is synchronous, and the fields it names are updated by different
   * objects, so a refresh built that way gets some of its answer from after
   * the transition and some from before it. Every round of this bug has been
   * one more field caught on the wrong side of that line.
   *
   * The era passed here is captured once, at the emission, from committed
   * state — and it is then used for ALL FOUR decisions this refresh makes:
   * whether to join an in-flight request, which credential the fetch may run
   * under, whether the result may be committed, and whether a clearing result
   * may be believed. One value for four decisions is the property; they were
   * previously four reads that could disagree.
   */
  refreshForEra(era: AuthEra): Promise<readonly HostDirectoryEntry[]> {
    const inFlight = this.refreshInFlight;
    // Keyed by the WHOLE era, not just the identity: a request issued before a
    // same-user rotation is answering for a credential this caller no longer
    // holds, and joining it is how a caller inherits somebody else's 401.
    if (
      inFlight !== null &&
      inFlight.era.identity === era.identity &&
      inFlight.era.credentialGeneration === era.credentialGeneration
    ) {
      return inFlight.request;
    }
    const request = this.performRefresh(era).finally(() => {
      // Only clear OUR slot: a request superseded by an identity change must
      // not clear the newer one when it finally settles.
      if (this.refreshInFlight?.request === request) {
        this.refreshInFlight = null;
      }
    });
    this.refreshInFlight = { era, request };
    return request;
  }

  /**
   * Drop any in-flight refresh so the next caller starts a fresh one.
   *
   * Called on credential rotation: the pending request carries the OLD bearer,
   * so joining it hands a caller an answer the new credential never asked for
   * — and if that answer is a 401, a clear. Losing the coalescing here costs
   * one request.
   */
  invalidateInFlightRefresh(): void {
    this.refreshInFlight = null;
  }

  findById(hostId: string): HostDirectoryEntry | null {
    for (const entry of this.snapshot()) {
      if (entry.hostId === hostId) {
        return entry;
      }
    }
    return null;
  }

  getLocalEntry(): HostDirectoryEntry | null {
    return this.localEntry;
  }

  /**
   * Resolves the host that should auto-bind when no explicit selection has
   * been made yet.
   *
   * Rules:
   *   - If a local-kind entry exists (desktop path), prefer it. A live local
   *     snapshot always publishes a websocket URL and `available` status, so
   *     this is already D7's "dialable local first" answer.
   *   - Else, if the merged directory has exactly one entry, return it.
   *   - Else, return `null` - the zero/many mobile paths require an
   *     explicit user gesture before binding.
   *
   * The `null` for a many-entry directory is a RULE, not a gap: falling
   * through to the first remote silently bound a host the user never picked.
   *
   * NOTHING in this class consumes this any more (redesign P1.2): "which
   * host should this app be on" is the authority's derivation, and "where
   * does an already-bound window go when its host dies" is the failover
   * engine's (P1.3). It survives as a directory READ - the shape of the
   * merged directory, answered in one place - for the surfaces that ask it.
   */
  getDefaultEntry(): HostDirectoryEntry | null {
    if (this.localEntry !== null) {
      return this.localEntry;
    }
    const entries = this.snapshot();
    if (entries.length === 1) {
      return entries[0];
    }
    return null;
  }

  /**
   * Returns the cardinality of the merged directory.
   *
   * The host-readiness controller consumes this as `hasMobileNoHost`, which
   * resolves to the `mobile-no-host` readiness kind and its no-host guidance
   * surface. Consumers can alternatively compute it from `list()`; this helper
   * just centralises the mapping.
   */
  getCardinality(): "zero" | "one" | "many" {
    const total = this.snapshot().length;
    if (total === 0) {
      return "zero";
    }
    if (total === 1) {
      return "one";
    }
    return "many";
  }

  onChange(listener: HostDirectoryListener): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  dispose(): void {
    if (this.localSubscription !== null) {
      this.localSubscription.dispose();
      this.localSubscription = null;
    }
    this.stopRefreshPolling();
    this.listeners.clear();
    this.started = false;
  }

  private startRefreshPolling(): void {
    if (this.refreshIntervalId !== null) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    // WHO OWNS THE CADENCE (redesign P4.1/F22, connection registry §1b).
    //
    // When the shell polls the registry for the whole app - desktop's main
    // process does, so N windows make ONE `GET /api/v3/hosts` instead of N -
    // this window arms no timer at all and rides the push instead. When it
    // does not (browser/dev, the single-window topology D16 names, and every
    // test shell), the interval below is still THE app's one liveness timer,
    // exactly as before.
    //
    // Deliberately not "both": arming the interval as a safety net alongside
    // the push would recreate the twin timer F22 exists to collapse, and it
    // would do it invisibly, because two sources of the same refresh look
    // identical from every consumer downstream.
    if (this.subscribeToShellRegistryPushes()) {
      return;
    }
    this.visibilityDocument = typeof document === "undefined" ? null : document;
    this.armPollInterval();
    this.visibilityDocument?.addEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
  }

  /**
   * Rides the shell's registry cadence when it has one. Returns whether it
   * took ownership, so the caller knows not to arm a second source.
   *
   * A push drives the SAME two things the interval drives, through the same
   * paths: `refresh()`, whose projection and emit gate are untouched by this
   * change, and `onRegistryPollTick()`, which INVALIDATES the registry query
   * rather than seeding it. Seeding is what the pushed rows might seem to
   * enable, and it stays wrong for a reason this move strengthens rather than
   * weakens: that query reaches the registry through
   * `AuthService.fetchRegisteredHosts(era)`, whose issue-time credential fence
   * exists to refuse a fetch whose bearer belongs to a different era - and
   * these rows were fetched with the SHELL's bearer, one process over.
   * Invalidating lets it refetch through its own fence, and costs nothing when
   * nothing is observing.
   *
   * The account fence: a push carries the identity it was FETCHED under, and a
   * window showing another account drops it. Same key on both sides - a user
   * id - because a main-process generation counter means nothing here.
   */
  private subscribeToShellRegistryPushes(): boolean {
    const subscription = this.runnerHost.onRegisteredHostsChange((push) => {
      const currentContext = this.authContextId();
      if (push.identityKey !== currentContext) {
        appLogger.debug("[host-directory] dropped a push for another account", {
          pushed: push.identityKey,
          current: currentContext,
        });
        return;
      }
      // HIDDEN WINDOWS DO NOT REFETCH ON A PUSH, the same rule the timer path
      // applies to its own tick. Riding pushes returned from `start()` before
      // `visibilityDocument` was ever assigned, so `isDocumentHidden()` was
      // permanently false on desktop and every background window issued its
      // own `GET /api/v3/hosts` on each of main's 60 s ticks - the very fetch
      // the removed per-window timer used to skip. The push is remembered and
      // acted on when the window next becomes visible.
      if (this.isDocumentHidden()) {
        this.pushMissedWhileHidden = true;
        return;
      }
      this.applyRegistryPush();
    });
    if (subscription === null) {
      return false;
    }
    this.registrySubscription = subscription;
    this.visibilityDocument = typeof document === "undefined" ? null : document;
    this.visibilityDocument?.addEventListener(
      "visibilitychange",
      this.handleVisibilityChangeWhileRidingPushes,
    );
    return true;
  }

  /**
   * What one shell push drives: the SAME two things the interval tick drives,
   * through the same paths (see the doc above for why the pushed rows are not
   * seeded directly).
   */
  private applyRegistryPush(): void {
    void this.refresh();
    if (this.onRegistryPollTick !== null) {
      this.onRegistryPollTick();
    }
  }

  /**
   * (Re)arms the poll timer from now. Called on initial setup and again on
   * every visibility resume, so a tab that was hidden gets a fresh
   * `HOST_DIRECTORY_REFRESH_POLL_MS` window from the moment it resumes
   * instead of also firing whatever tick was already scheduled seconds
   * later.
   */
  private armPollInterval(): void {
    if (typeof window === "undefined") {
      return;
    }
    if (this.refreshIntervalId !== null) {
      window.clearInterval(this.refreshIntervalId);
    }
    this.refreshIntervalId = window.setInterval(() => {
      if (this.isDocumentHidden()) {
        return;
      }
      void this.refresh();
      // THE APP'S ONE LIVENESS TIMER (redesign P4.1 / F22). This tick used to
      // have a twin: a second 60s `refetchInterval` on the registered-hosts
      // query, against the same `GET /api/v3/hosts`, which this file's own
      // comment already called out as not the goal. The twin is gone and the
      // TanStack observers ride this tick instead.
      //
      // INVALIDATE rather than seed, and the distinction is load-bearing.
      // This poll's fetcher returns already-projected `HostDirectoryEntry`
      // rows, not the raw `HostListResponse` the Settings surfaces read their
      // registry metadata from - and that query reaches the registry through
      // `AuthService.fetchRegisteredHosts(era)`, whose issue-time credential
      // fence exists precisely to refuse a fetch whose bearer belongs to a
      // different era. Handing it data fetched on this path would route
      // around that fence. Invalidating instead lets it refetch through its
      // own, still fenced, and costs nothing when no such surface is mounted:
      // an invalidation with no ACTIVE observer marks stale and issues no
      // request.
      if (this.onRegistryPollTick !== null) {
        this.onRegistryPollTick();
      }
    }, HOST_DIRECTORY_REFRESH_POLL_MS);
  }

  private stopRefreshPolling(): void {
    this.registrySubscription?.dispose();
    this.registrySubscription = null;
    if (this.refreshIntervalId !== null && typeof window !== "undefined") {
      window.clearInterval(this.refreshIntervalId);
    }
    this.refreshIntervalId = null;
    this.visibilityDocument?.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    this.visibilityDocument?.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChangeWhileRidingPushes,
    );
    this.visibilityDocument = null;
    this.pushMissedWhileHidden = false;
  }

  private isDocumentHidden(): boolean {
    return this.visibilityDocument !== null && this.visibilityDocument.hidden;
  }

  /**
   * On `failed`, retains the last-known `remoteEntries` and does not
   * re-resolve the bound row - a transient blip must never unbind an active
   * remote selection (T20 / audit P4). `signed-out` clears remotes exactly
   * as a successful empty `hosts` result would.
   */
  private async performRefresh(
    era: AuthEra,
  ): Promise<readonly HostDirectoryEntry[]> {
    // The era goes DOWN to the fetcher, not just into the guards below. A
    // guard can only decide whether to keep an answer; the fetcher is the
    // only layer that can decide which credential the question is asked with,
    // and asking with the wrong one is the failure the guards kept failing to
    // catch — the answer that comes back is perfectly valid, just for someone
    // else.
    const outcome = await this.fetchRemoteOutcome(era);
    // THE COMMIT GUARD. Everything below mutates a long-lived, app-wide object:
    // `remoteEntries`, the selection, the emit every consumer refetches on. A
    // read issued for account A must not write any of it after the user has
    // become account B — that is how A's machines appeared in B's directory,
    // and how a 401 earned by A's expired bearer cleared the list B had just
    // legitimately loaded.
    //
    // Discarding is the whole action: the switch itself triggers a fresh
    // refresh under the new identity, so there is nothing to salvage here and
    // nothing waiting on this write.
    // A CLEARING outcome is destructive, and a user-id fence cannot see the
    // case that produces it: a same-user bearer rotation. The old credential's
    // poll 401s, comes back `signed-out`, and the user id still matches — so
    // an expired token empties a directory the new token had just filled.
    //
    // Constructive commits stay fenced by user (a rotation mid-flight still
    // describes the right account's hosts); destructive ones additionally
    // require the credential that OBSERVED the failure to still be current.
    // Constructive commits are additionally ORDERED by the generation
    // watermark further down - believable is not the same as allowed to
    // overwrite something newer.
    if (
      outcome.kind === "signed-out" &&
      this.credentialGeneration() !== era.credentialGeneration
    ) {
      appLogger.debug(
        "[host-directory] ignoring a sign-out clear observed by a superseded credential",
        { remoteCount: this.remoteEntries.length },
      );
      return this.snapshot();
    }
    if (this.authContextId() !== era.identity) {
      appLogger.debug(
        "[host-directory] discarding a refresh that resolved after an identity change",
        { outcome: outcome.kind },
      );
      return this.snapshot();
    }
    if (outcome.kind === "failed") {
      // Retention is only safe for the SAME identity. The era fence above has
      // already proven `era.identity` is the CURRENT identity, so a mismatch
      // here means the retained list was committed by a previous account:
      // keeping it would show (and keep bindable) A's machines under B's
      // session until some later read succeeds. Dropping is not a genuine
      // outcome - it clears the foreign list without claiming the registry
      // said "empty".
      if (
        this.remoteEntries.length > 0 &&
        this.lastCommitIdentity !== era.identity
      ) {
        appLogger.debug(
          "[host-directory] dropping remote entries committed under a previous identity after a failed refresh",
          { remoteCount: this.remoteEntries.length },
        );
        this.remoteEntries = [];
        this.lastCommitIdentity = null;
        this.emitIfSnapshotChanged();
        return this.snapshot();
      }
      appLogger.debug(
        "[host-directory] refresh failed, retaining last-known remote entries",
        { remoteCount: this.remoteEntries.length },
      );
      return this.snapshot();
    }
    // The ORDERING fence, completing the era fences above. A constructive
    // read issued under a superseded credential is still ALLOWED to commit -
    // it describes the right account's hosts, and discarding it outright
    // would trade a valid answer for a stale directory until the next poll.
    // What it must not do is land ON TOP of a commit a newer credential
    // already made: the reorder (old read resolving after the post-rotation
    // refresh committed) would silently replace the newer list with the
    // older one - resurrecting stale connectivity, or dropping a host
    // registered between the two reads - until the next poll happened by.
    if (
      this.lastCommitCredentialGeneration !== null &&
      era.credentialGeneration < this.lastCommitCredentialGeneration
    ) {
      appLogger.debug(
        "[host-directory] discarding a stale-generation result that resolved after a newer commit",
        { outcome: outcome.kind },
      );
      return this.snapshot();
    }
    this.lastCommitCredentialGeneration = era.credentialGeneration;
    this.lastCommitIdentity = era.identity;
    // Captured BEFORE the overwrite: this is the only place that holds both
    // sides of a membership transition (F6b).
    const previousRemoteIds = new Set(
      this.remoteEntries.map((entry) => entry.hostId),
    );
    this.remoteEntries = outcome.kind === "hosts" ? outcome.entries : [];
    // A host registered late - from the CLI, or from another machine - reaches
    // this directory through its own poll, while the selection authority's
    // fleet (desktop main) stays stale. Activate on it then refuses
    // `unknown-host`: the user is told a machine they just registered is "no
    // longer registered to this account".
    //
    // ADDED ids only. A REMOVED id is the deregister mutation's own
    // announcement and must not be made twice; a first fetch that finds hosts
    // fires once, which is correct rather than noise - main's fleet can be
    // exactly as stale at cold start as at any other moment, and the cost is
    // one refetch.
    //
    // The `hosts` check is DOCUMENTARY, not load-bearing, and a mutation probe
    // proved it: `failed` returns above this line, and `signed-out` commits an
    // empty set, so neither can ever satisfy the added-ids predicate. It stays
    // because it states the rule a future edit has to keep - but no test pins
    // it, because no mutation of it can go red.
    if (
      outcome.kind === "hosts" &&
      outcome.entries.some((entry) => !previousRemoteIds.has(entry.hostId))
    ) {
      requestFleetRefresh(this.runnerHost);
    }
    await this.reseedLocalHostIdIfUnknown();
    // Emit only when the merged snapshot actually changed. The 60s registry
    // poll lands here on every tick; an unconditional emit made every
    // `onChange` consumer (17 query call sites) re-render/refetch app-wide
    // each tick even when nothing changed.
    this.emitIfSnapshotChanged();
    appLogger.debug("[host-directory] refresh complete", {
      outcome: outcome.kind,
      localCount: this.localEntry === null ? 0 : 1,
      remoteCount: this.remoteEntries.length,
      totalCount: this.snapshot().length,
    });
    return this.snapshot();
  }

  /**
   * Runs the fetcher, collapsing a REJECTED fetcher promise into the same
   * `failed` outcome a well-behaved fetcher returns. Without this a throwing
   * fetcher (a rejected IPC bridge call) would reject `refresh()` - and,
   * through `start()`'s await, tear down the whole host runtime with no
   * retry - instead of taking the designed retain-last-known path
   * (T20 / audit P4).
   *
   * A fetcher that REFUSES the era — the credential it holds belongs to a
   * different one — throws, and lands here as `failed`: retain last known,
   * change nothing. That is the correct shape for a refusal. A refusal to ask
   * is not an answer about the account's hosts, so it must not clear them,
   * and the era that superseded this one issues its own refresh regardless.
   */
  private async fetchRemoteOutcome(
    era: AuthEra,
  ): Promise<RemoteHostFetchOutcome> {
    try {
      return await this.remoteFetcher(era);
    } catch (error) {
      appLogger.warn("[host-directory] remote fetcher threw", {
        error: describeLogError(error),
      });
      return { kind: "failed" };
    }
  }

  /**
   * The shell's answer WINS over the persisted one whenever it has one.
   *
   * Consulting the shell only when the cache was empty made the persisted value
   * authoritative, and it is not: the host can be re-enrolled while the
   * renderer is not running, leaving a stale id behind. On the next launch that
   * stale value would neutralise an obsolete twin while THIS machine's current
   * registry entry stayed remote-kind - relay-dialable and auto-selectable -
   * which is the exact failure this seed exists to prevent, just pointed at a
   * different id.
   *
   * The persisted value survives only as the fallback for a shell that cannot
   * answer (web/mobile, or a machine that has never enrolled).
   *
   * Best-effort throughout: a shell that throws must not stop the directory
   * from starting. Failing closed here would trade a mislabelled row for an app
   * that lists no hosts at all.
   */
  /**
   * Re-attempt the shell seed while this machine's id is still UNKNOWN.
   *
   * `start()` asks exactly once, and the ask can come back `null` for reasons
   * that are all transient: the query is `retry: false` over an IPC boundary,
   * its result is cacheable for a minute, and on a fresh profile there is no
   * persisted value to fall back to. A single `null` used to be permanent for
   * the session - and a null id is not a harmless gap.
   *
   * It decides whether `snapshot()` recognises the registry's twin of THIS
   * machine. Unrecognised, the twin is published as-is: `kind: "remote"` with
   * the relay URL and whatever its presence lease says. Right after the host
   * was down - which is exactly when this matters - that lease reads expired,
   * so this machine's own row appears as a remote host marked `unavailable`,
   * which `useHostReachability` reports as `unreachable` and every chat owned
   * by it locks to a published copy. Both protections miss it: the
   * empty-directory arm because the directory is not empty, and the
   * booting-local arm because the row is not `kind: "local"`. Worse, that row
   * is relay-DIALABLE, so selection can bind our own machine through the relay
   * and disable the local provisioning lifecycle (see `lastKnownLocalHostId`).
   *
   * Cheap and self-retiring: it runs only while the id is unknown, on a poll
   * that is already happening, and stops for good on the first answer.
   */
  private async reseedLocalHostIdIfUnknown(): Promise<void> {
    if (this.lastKnownLocalHostId !== null) {
      return;
    }
    await this.seedLocalHostIdFromShell();
  }

  private async seedLocalHostIdFromShell(): Promise<void> {
    let hostId: string | null;
    try {
      hostId = await this.localHostIdSeeder();
    } catch (error) {
      appLogger.warn("[host-directory] local host id seed failed", {
        error: describeLogError(error),
      });
      return;
    }
    if (hostId === null || hostId === this.lastKnownLocalHostId) {
      return;
    }
    this.adoptLocalHostId(hostId);
    appLogger.debug("[host-directory] seeded local host id from shell", {
      hostId,
    });
  }

  /**
   * The ONE place `lastKnownLocalHostId` moves from one id to another, for
   * both movers - the shell seed at start and a live snapshot re-enrollment.
   *
   * A re-enrollment does not just change which row `snapshot()` neutralises;
   * every other holder of the OLD id is now pointing at an obsolete twin that
   * the registry may keep listing as a remote-kind, relay-dialable row.
   * Updating only the field left every OTHER holder of the old id pointing at
   * that obsolete row: the app strands on a dead relay target with the local
   * Retry path disabled - the exact lockout the id tracking exists to
   * prevent. So the holders migrate with the id: "this machine" follows the
   * machine.
   *
   * Enumerated holders, migrated here: the Settings viewing scope. There
   * used to be two more - the live selection and the pointer the authority's
   * verdict was resolved through - and both died with the active slot
   * (redesign P4.2). This directory no longer holds a selection to migrate;
   * the app-wide host is the authority's `effectiveHostId`, resolved through
   * a pinned requester at each read, so a re-enrollment is picked up by the
   * next resolution rather than by rewriting a stored row. Deliberately NOT
   * migrated: tab bindings (bound to a
   * hostId for life by design - cross-host is clone-not-migrate) and
   * notification origin ids (ephemeral, scoped to a delivered notification).
   * The durable INTENT is no longer one of them - it is the authority's
   * `preferredHostId`, which is fleet-validated at its own layer (F14): a
   * preferred id this machine has re-enrolled away from is simply not in the
   * fleet any more, and derivation falls back rather than stranding.
   *
   * Migration only fires when the PREVIOUS id is known and matches: with no
   * previous id there is no evidence the remembered selection meant "this
   * machine", and rewriting it would move a genuine remote selection.
   */
  private adoptLocalHostId(next: string): void {
    const previous = this.lastKnownLocalHostId;
    this.lastKnownLocalHostId = next;
    persistLocalHostId(next);
    if (previous === null || previous === next) {
      return;
    }
    // The Settings viewing scope is a holder too. A pin of this machine's
    // OLD id would keep Settings administering the dead registry twin (and
    // read `vanished` once the twin deregisters). A genuine remote pin never
    // matches `previous`, so it is left alone.
    const settingsScope = useSettingsHostScopeStore.getState();
    if (settingsScope.scopedHostId === previous) {
      settingsScope.setScopedHostId(next);
    }
    appLogger.debug("[host-directory] local host id re-enrolled", {
      previous,
      next,
    });
  }

  private snapshot(): readonly HostDirectoryEntry[] {
    const entries: HostDirectoryEntry[] = [];
    const seenHostIds = new Set<string>();
    if (this.localEntry !== null) {
      entries.push(this.localEntry);
      seenHostIds.add(this.localEntry.hostId);
    }
    for (const entry of this.remoteEntries) {
      if (seenHostIds.has(entry.hostId)) {
        continue;
      }
      // This machine's own host id is served exclusively by the local arm.
      // While the local host is down/booting the registry twin is the only
      // entry carrying it, and it is remote-kind and relay-dialed. Present it
      // as a non-dialable LOCAL entry instead of dropping it, so the id stays
      // resolvable for selection while nothing can dial it through the relay
      // (see `lastKnownLocalHostId`).
      entries.push(
        entry.hostId === this.lastKnownLocalHostId
          ? bootingLocalEntry(entry)
          : entry,
      );
      seenHostIds.add(entry.hostId);
    }
    return entries;
  }

  private emit(): void {
    const snapshot = this.snapshot();
    this.lastEmittedSnapshot = snapshot;
    for (const listener of this.listeners) {
      listener(snapshot, this.localEntry);
    }
  }

  /**
   * Poll-path emit: skips the fan-out when the snapshot is value-equal to the
   * last one emitted. Every non-poll mutation (local host change, selection,
   * re-enrollment) still emits unconditionally and refreshes the baseline, so
   * a change landing between two polls can never be swallowed.
   */
  private emitIfSnapshotChanged(): void {
    if (
      this.lastEmittedSnapshot !== null &&
      hostDirectorySnapshotsEqual(this.lastEmittedSnapshot, this.snapshot())
    ) {
      return;
    }
    this.emit();
  }
}

function loadPersistedLocalHostId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(LAST_LOCAL_HOST_ID_STORAGE_KEY);
    return raw !== null && raw.length > 0 ? raw : null;
  } catch (error) {
    appLogger.warn("[host-directory] persisted local host id load failed", {
      storageKey: LAST_LOCAL_HOST_ID_STORAGE_KEY,
      error: describeLogError(error),
    });
    return null;
  }
}

function persistLocalHostId(hostId: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(LAST_LOCAL_HOST_ID_STORAGE_KEY, hostId);
  } catch (error) {
    appLogger.warn("[host-directory] persisted local host id write failed", {
      storageKey: LAST_LOCAL_HOST_ID_STORAGE_KEY,
      hostId,
      error: describeLogError(error),
    });
  }
}

/**
 * Field-equality check mirroring `useHostDirectoryEntry`'s cache (React
 * hooks land, this class predates React entirely, so the comparison is
 * reimplemented rather than imported across that boundary). Remote/local
 * entries are freshly allocated on every fetch/IPC snapshot even when
 * nothing observable changed, so a bound remote selection would otherwise
 * reassign and fan out to every `onSelectionChange` handler on every 60s
 * poll tick for no reason.
 */
function hostDirectoryEntriesEqual(
  a: HostDirectoryEntry,
  b: HostDirectoryEntry,
): boolean {
  return (
    a.hostId === b.hostId &&
    a.label === b.label &&
    a.kind === b.kind &&
    a.websocketUrl === b.websocketUrl &&
    a.version === b.version &&
    // The DERIVED verdict, not the coarse bit. Same reason as
    // `useHostDirectoryEntry`'s twin: a host moving from `indeterminate` to a
    // confirmed `offline` is not-dialable on both sides, and swallowing that
    // emit would freeze every surface reading the reason at "we don't know".
    hostUnavailability(a) === hostUnavailability(b) &&
    // The recovery-dial window (F7). Computed at projection time from
    // `lastSeenAt` recency, so an `offline` row whose ONLY change is aging
    // past RELAY_FUSE_MAX_ATTACH_MS flips this field and nothing else this
    // comparison reads (the derived verdict stays `offline` on both sides).
    // Without it that flip was swallowed as a field-identical poll tick, and
    // every consumer kept a `relayFuseGrace: true` entry forever - recovery
    // dials permitted indefinitely past the documented 4h cap.
    isRelayFuseRecoveryCandidate(a) === isRelayFuseRecoveryCandidate(b) &&
    remotePublicKeyOf(a) === remotePublicKeyOf(b)
  );
}

function remotePublicKeyOf(entry: HostDirectoryEntry): string | null {
  return isRemoteHostDirectoryEntry(entry) ? entry.publicKey : null;
}

function hostDirectorySnapshotsEqual(
  a: readonly HostDirectoryEntry[],
  b: readonly HostDirectoryEntry[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  // Index access is in-bounds for both arrays under the length check above.
  return a.every((entry, index) => hostDirectoryEntriesEqual(entry, b[index]));
}

/**
 * Rewrites the registry's view of THIS machine into the local, not-yet-dialable
 * entry the local arm will publish once the host is up.
 *
 * `websocketUrl: null` is what makes it safe: `isHostDialable()` refuses it, so
 * no transport - app-wide or per-tab - can reach for the relay against our own
 * host. `kind: "local"` is what makes it useful: the readiness controller keeps
 * `localTarget` true, so the local provisioning lifecycle stays armed and the
 * surface offers the loading/Retry card instead of the dead-end one.
 *
 * The registry's label/version are kept: they are this machine's, and they are
 * the freshest description available while the host is down.
 *
 * `transportDialability` is forced to `not-dialable` rather than carried over
 * from the twin's presence lease. It is the truth about DIALABILITY - nothing
 * can reach this entry - and dialability transitions are an event other
 * surfaces subscribe to: the landing-terminal tombstone recovery bridge fires
 * its pending kill on a `not-dialable -> dialable` edge. Copying the lease's
 * `dialable` would make
 * it fire at boot against an entry with no `websocketUrl` (the mutation
 * rejects), and then see no edge when the real host publishes - stranding the
 * tombstone and leaving the host terminal alive.
 *
 * Written coarsely on purpose: this is a FABRICATED local entry, not a verdict
 * the cloud reached about a machine, so there is no reason to derive. The
 * derivation reads it back as `offline`, which is what "this machine's own host
 * process is down" means - and the comment on `hostUnavailability` says exactly
 * that locality is decided by a direct read of the process, never by a relay.
 *
 * What that `offline` must NOT be read as is "this machine's host is dead". It
 * is produced whenever the local snapshot is merely ABSENT, which covers boot,
 * a restart, and a host busy enough to lose a probe - and on 2026-08-11 it was
 * the row that locked a healthy machine's chats read-only, freshly derived on
 * every relaunch because the registry twin arrives from the cloud before the
 * local snapshot arrives from the shell. `useHostReachability` therefore
 * recognises this entry by its shape (`kind: "local"` with no `websocketUrl` -
 * nothing else in the directory can produce that pair) and reports
 * `host-starting`, the same verdict the empty directory has produced since
 * 2026-07-14 for the same "not published yet" reason.
 */
function bootingLocalEntry(twin: HostDirectoryEntry): HostDirectoryEntry {
  return {
    hostId: twin.hostId,
    label: twin.label,
    kind: "local",
    websocketUrl: null,
    version: twin.version,
    transportDialability: "not-dialable",
  };
}

/**
 * The local host, read DIRECTLY from the running process rather than from any
 * relay verdict — so the coarse bit is written, not derived. A local snapshot
 * exists only when this machine's host is up and serving, which is the whole
 * evidence needed for "dialable".
 */
function toLocalEntry(
  snapshot: LocalHostSnapshot | null,
): HostDirectoryEntry | null {
  if (snapshot === null) {
    return null;
  }
  return {
    hostId: snapshot.hostId,
    label: snapshot.displayName,
    kind: "local",
    websocketUrl: snapshot.websocketUrl,
    version: snapshot.version,
    // Projected from the shell, never assumed. This is the ONE place a
    // `HostAvailability` becomes a `HostTransportDialability`, and it is the
    // seam that keeps `busy` from ever reading as death downstream: the shell
    // used to drop the whole snapshot the moment a probe failed, so the
    // renderer's only two states were "available" and "no entry at all", which
    // is the vocabulary that turned a busy host into a dead one on 2026-08-11.
    //
    // A live snapshot is `available | busy` today, so this is total in
    // practice - written as a projection rather than a hardcoded "dialable" so
    // that widening `LiveHostAvailability` produces the right entry instead of
    // a silent false claim.
    transportDialability: isHostReachable(snapshot.availability)
      ? "dialable"
      : "not-dialable",
  };
}
