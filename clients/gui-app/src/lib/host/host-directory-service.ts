import type { AuthEra } from "@traycer-clients/shared/auth/request-context-provider";
import {
  isHostReachable,
  type HostDirectoryEntry,
} from "@traycer-clients/shared/host-client/host-directory";
import type { IHostDirectoryService } from "@traycer-clients/shared/host-client/host-runtime";
import {
  fetchRemoteHosts,
  hostUnavailability,
  isConfirmedHostDeath,
  isRelayFuseRecoveryCandidate,
  isRemoteHostDirectoryEntry,
  type RemoteHostFetchOutcome,
  type RemoteHostFetcher,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { hasReadyRemoteSession } from "@traycer-clients/shared/host-transport/remote/index";
import type {
  IRunnerHost,
  LocalHostSnapshot,
} from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import { appLogger, describeLogError } from "@/lib/logger";
import {
  Analytics,
  AnalyticsEvent,
  type AnalyticsSource,
} from "@/lib/analytics";
import { lastLocalHostIdKey, lastSelectedHostKey } from "@/lib/persist";
import {
  hostSwitchLabel,
  toastHostSwitched,
} from "@/lib/host/host-switch-toast";
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
const LAST_SELECTED_HOST_STORAGE_KEY = lastSelectedHostKey();
const LAST_LOCAL_HOST_ID_STORAGE_KEY = lastLocalHostIdKey();

/**
 * How many CONSECUTIVE genuine directory reads must agree about a host's
 * dialability before the app moves the app-wide binding, in EITHER direction
 * (D7).
 *
 * Two, not one. A presence lease lapses on its own schedule and the registry
 * is polled every ~60s; one read that arrives inside a lease gap - or a single
 * slow relay round-trip - is a blip, and re-homing the window on it would move
 * the user off a host that was never actually gone. Two reads at that cadence
 * is up to ~2 minutes of confirmation, which is the price of not moving someone
 * off a working machine.
 *
 * ONE constant on purpose: an undamped recovery is the same defect as an
 * undamped death, just pointed the other way. A host that flaps
 * dialable/non-dialable would oscillate the binding at poll cadence - a toast
 * and a full app-wide query-scope invalidation every ~60s - if coming back
 * were cheaper to believe than going away. Both streaks are advanced only by
 * GENUINE fetcher outcomes: a `failed` refresh returns before either is
 * touched, so it neither advances nor resets them.
 */
const CONSECUTIVE_DIALABILITY_READS = 2;

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

/**
 * The user's live host-selection intent, in ids. See
 * `HostDirectoryService.readSelectionIntent`.
 */
export interface HostSelectionIntent {
  /**
   * The host id the current selection names, or `null` when the user has not
   * picked one (first run, or an explicit clear). NOT resolved against the
   * directory - that is the point.
   */
  readonly selectedHostId: string | null;
  /**
   * This machine's own local host id as the directory knows it: seeded from
   * the shell's durable pid metadata, then adopted from every local snapshot.
   * `null` only on a machine whose local host has never announced itself.
   */
  readonly localHostId: string | null;
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
 * stable shape regardless of remote discovery progress (D3). Selection state
 * is owned here - `HostRuntime.start()` reads `getSelected()` and listens
 * to `onSelectionChange(...)` to rebind `HostClient`. `refresh()` only ever
 * replaces `remoteEntries` on a genuine `hosts` or `signed-out` fetcher
 * outcome; a `failed` outcome retains the last-known entries instead of
 * unbinding an active remote selection (T20 / audit P4). That same refresh
 * path owns the D7 auto-failover (`reconcileSelectionDialability`): a
 * selection the registry still lists but nothing can dial is re-homed to the
 * next available host, transiently, and handed back when it returns.
 *
 * The service never calls any `getLocalHost()` accessor; the current
 * snapshot is the most recent value delivered through the subscription.
 * Subscribing to `onLocalHostChange` fires synchronously with the current
 * snapshot, so `start()` does not need a separate seeding fetch.
 */
export class HostDirectoryService implements IHostDirectoryService {
  private readonly runnerHost: IRunnerHost;
  private readonly remoteFetcher: RemoteHostFetcher;
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
   * selection: the remembered id then resolved to nothing at startup, so a
   * registry holding exactly one other machine had that remote auto-promoted,
   * and `reconcileSelection()` kept the still-valid remote even after the
   * local host came back. Keeping the id present preserves the user's intent
   * while still refusing the relay.
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
  private selected: HostDirectoryEntry | null = null;
  /**
   * Tracks the user's explicit selection gesture via `selectById(...)`
   * (including explicit clear with `selectById(null)`).
   *
   * Startup path: when no explicit selection has been made yet, directory
   * refreshes / local-host arrivals that newly resolve a `getDefaultEntry()`
   * are promoted into the effective selection so downstream
   * `onSelectionChange(...)` subscribers (e.g. `HostRuntime`) rebind without
   * requiring a remount or picker gesture.
   *
   * Once the user has explicitly selected a host id, that host is restored
   * if it briefly leaves and re-enters the directory. Explicit clear suppresses
   * auto-promotion until the user chooses again.
   */
  private explicitSelection: ExplicitHostSelection | null = null;
  /**
   * Non-null only during `start()`: suppresses default-promotion until the
   * initial remote refresh has had a chance to resolve the persisted host.
   */
  private startupRestoreHostId: string | null = null;
  /**
   * One post-startup retry for web/mobile shells that remained fully unbound
   * after the startup restore attempt. Consumed by the next refresh that
   * actually delivers at least one remote entry.
   */
  private unboundFollowUpRestoreHostId: string | null = null;
  /**
   * True once any refresh has delivered a genuine fetcher outcome (`hosts`
   * or `signed-out`). Until then the remote side of the directory is simply
   * UNKNOWN - a `failed` fetch proves nothing about a remembered host's
   * registration - which is what lets the startup restore distinguish "the
   * registry omitted the host" (deregistered) from "the registry was never
   * reached" (transient blip).
   */
  private hasGenuineRemoteOutcome = false;
  /**
   * One-shot startup-restore retry armed when the persisted host could not
   * be resolved because the initial refresh FAILED (never delivered a
   * genuine outcome). The default host is still promoted for usability, but
   * the user's remembered selection is settled by the FIRST refresh that
   * genuinely resolves: restored when present (overriding only the
   * auto-promoted default - "we do not silently move them" cuts both ways),
   * or retired when a genuine result omits it, exactly as a genuine first
   * refresh would have fallen to the default. Retired by an explicit
   * `selectById(...)` gesture.
   */
  private restoreAfterFailedRefreshHostId: string | null = null;
  /**
   * Consecutive genuine directory reads that found the current selection
   * LISTED but not dialable, and the host they were counted for.
   *
   * Counted on the refresh path only (`performRefresh`), never on the
   * local-snapshot path: a local snapshot re-reads the SAME registry rows, so
   * counting it would let two local events inside one poll window satisfy a
   * debounce whose whole point is two independent reads of the registry.
   * Reset the moment the selection is dialable again, moves, or leaves.
   */
  private nonDialableSelectionStreak: DialabilityStreak | null = null;
  /**
   * The mirror of `nonDialableSelectionStreak` for the way back: consecutive
   * genuine reads that found the FAILOVER ORIGIN dialable again. Recovery is
   * damped exactly as hard as death (see `CONSECUTIVE_DIALABILITY_READS`);
   * a host that answers once and lapses again restarts this from zero, so a
   * flapping origin never re-homes the window.
   */
  private dialableOriginStreak: DialabilityStreak | null = null;
  /**
   * The host an auto-failover moved the app OFF, so the window can move back
   * when it returns (D7.3).
   *
   * Armed for EVERY failover origin (F7): the hand-back covers
   * auto/default/transient selections as well as an explicit pick, because a
   * transient false-`offline` - a lease lapse the relay fuse is still holding -
   * must not permanently move the app-wide selection off a host that is still
   * working. The failover stays transient (`explicitSelection` is never
   * rewritten). Two rails keep the claim honest: an explicit pick ALWAYS
   * reclaims this marker for itself, and a non-explicit origin is recorded only
   * when nothing already holds it, so the user's own choice still outranks an
   * auto one across a second outage (explicit A dies -> B, then B dies: the
   * marker stays A).
   */
  private failoverOriginHostId: string | null = null;
  /**
   * WHERE the failover machinery parked the app - the failover target, kept in
   * step with `failoverOriginHostId` (cold review P2). The hand-back promise
   * is "undo the move the failover made", so it is only redeemable while the
   * app is still parked where that move left it. Every move the failover
   * machinery itself makes (the initial failover, a chained second failover,
   * the both-ends-vanished continuation) updates this; any OTHER route the
   * selection travels - an explicit pick, a notification's transient
   * activation - retires the whole marker instead, because handing back over
   * a newer intent would steal the selection from a host the user just chose
   * to look at.
   */
  private failoverTargetHostId: string | null = null;
  private readonly listeners = new Set<HostDirectoryListener>();
  private readonly selectionListeners = new Set<
    (entry: HostDirectoryEntry | null) => void
  >();
  private localSubscription: Disposable | null = null;
  private started = false;
  private refreshIntervalId: number | null = null;
  private visibilityDocument: Document | null = null;
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

  constructor(options: HostDirectoryServiceOptions) {
    this.runnerHost = options.runnerHost;
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
    this.preparePersistedSelectionRestore();
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
      this.reconcileSelection();
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
    this.resolveStartupRestore();
    this.startRefreshPolling();
  }

  private isStarted(): boolean {
    return this.started;
  }

  list(): Promise<readonly HostDirectoryEntry[]> {
    return Promise.resolve(this.snapshot());
  }

  /**
   * The live selection INTENT, as ids - what the user is pointed at, whether
   * or not the directory can currently resolve it to an entry.
   *
   * `getSelected()` cannot answer this: it returns `null` both for "nothing
   * selected" and for "the selected host has no row right now" (an explicit
   * pick of an id the directory does not hold goes through `setSelected(null)`),
   * and callers deciding whether to run LOCAL host management must tell those
   * apart - one is a cold local start, the other is a remote host the user is
   * waiting on.
   *
   * Read-only and in-memory ON PURPOSE. The persisted keys are this service's
   * startup SEED, not the authority: `persistHostSelection` /
   * `persistLocalHostId` swallow write failures by design (a blocked quota
   * must never break selection), so a consumer that re-read storage would see
   * "nothing selected" for a user who is very much pointed at a remote host,
   * and would then provision the local machine underneath them. These fields
   * are correct even when every write failed.
   *
   * Precedence mirrors `getSelected()`, minus its `getDefaultEntry()` tail: a
   * default-promoted entry is not an intent, and its absence is exactly the
   * "no pick yet" answer callers need.
   */
  readSelectionIntent(): HostSelectionIntent {
    return {
      selectedHostId: this.selectionIntentHostId(),
      localHostId: this.lastKnownLocalHostId,
    };
  }

  private selectionIntentHostId(): string | null {
    if (this.selected !== null) {
      return this.selected.hostId;
    }
    // An explicit clear (`{hostId: null}`) STOPS here rather than falling
    // through to a restore id: the user erased the intent, and a remembered
    // one must not resurrect it.
    if (this.explicitSelection !== null) {
      return this.explicitSelection.hostId;
    }
    return (
      this.startupRestoreHostId ??
      this.restoreAfterFailedRefreshHostId ??
      this.unboundFollowUpRestoreHostId
    );
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

  getSelected(): HostDirectoryEntry | null {
    if (this.selected !== null) {
      return this.selected;
    }
    if (this.explicitSelection !== null) {
      if (this.explicitSelection.hostId === null) {
        return null;
      }
      return this.findById(this.explicitSelection.hostId);
    }
    if (this.startupRestoreHostId !== null) {
      return this.findById(this.startupRestoreHostId);
    }
    return this.getDefaultEntry();
  }

  selectById(hostId: string | null): void {
    appLogger.debug("[host-directory] explicit host selection requested", {
      hostId,
      clearingSelection: hostId === null,
    });
    this.startupRestoreHostId = null;
    this.unboundFollowUpRestoreHostId = null;
    this.restoreAfterFailedRefreshHostId = null;
    // The user answered "which host do you work on" themselves, so the whole
    // failover memory is retired: both dialability streaks belong to a
    // selection that no longer exists, and the origin marker exists only to
    // hand the app back to the pick this gesture just replaced.
    this.nonDialableSelectionStreak = null;
    this.dialableOriginStreak = null;
    this.failoverOriginHostId = null;
    this.failoverTargetHostId = null;
    this.explicitSelection = { hostId };
    if (hostId === null) {
      // An explicit clear erases the remembered host entirely rather than
      // persisting a "cleared" marker - otherwise every future launch would
      // restore that marker and stay unbound forever instead of falling back
      // to today's getDefaultEntry() behavior.
      removePersistedHostSelection();
      this.setSelected(null);
      return;
    }
    persistHostSelection(hostId);
    const entry = this.findById(hostId);
    if (entry !== null) {
      Analytics.getInstance().track(AnalyticsEvent.HostSelected, {
        source: "direct_ui",
        host_kind: entry.kind === "remote" ? "remote" : "local",
      });
    }
    this.setSelected(entry);
  }

  /**
   * Binds a host for the CURRENT app context without recording it as the
   * user's chosen host.
   *
   * Same single binding authority as `selectById` - it goes through
   * `setSelected`, so `HostRuntime` still performs exactly one synchronous
   * `hostClient.bind(entry)` and the directory and client cannot disagree.
   * What it deliberately does NOT write is `explicitSelection`: activating a
   * host to show a notification's destination moves the app, it does not
   * answer "which host do you work on". Leaving that intent unset is what
   * lets `reconcileSelection` promote `getDefaultEntry()` again if the
   * activated host later leaves the directory - a durable pin would strand
   * the session unbound on a host that no longer exists.
   *
   * `source` is the caller's analytics attribution: this seam is about
   * selection LIFETIME, not about who triggered it, so the entry point names
   * itself rather than being assumed here.
   *
   * An id the directory does not currently hold is a no-op, never a clear: a
   * transient activation must not be able to unbind the app.
   */
  selectTransientById(hostId: string, source: AnalyticsSource): void {
    const entry = this.findById(hostId);
    appLogger.debug("[host-directory] transient host activation requested", {
      hostId,
      resolved: entry !== null,
      source,
    });
    if (entry === null) {
      return;
    }
    if (source !== "host_failover") {
      // A transient activation from anywhere OUTSIDE the failover machinery
      // (today: a notification's destination) is newer intent about where the
      // app should be. The hand-back marker's promise is "undo the failover's
      // own move"; once the selection travels by another route that promise
      // is stale, and redeeming it later would yank the user off the host
      // they just navigated to (cold review P2: A dies -> failover B ->
      // notification C -> A recovers must stay on C). The streaks retire with
      // it - their evidence was counted for a parking spot that no longer
      // exists. The failover's own moves pass `host_failover` and keep the
      // marker, which is what lets a chained failover still hand back.
      this.nonDialableSelectionStreak = null;
      this.dialableOriginStreak = null;
      this.failoverOriginHostId = null;
      this.failoverTargetHostId = null;
    }
    Analytics.getInstance().track(AnalyticsEvent.HostSelected, {
      source,
      host_kind: entry.kind === "remote" ? "remote" : "local",
    });
    this.setSelected(entry);
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
   * through to the first remote silently bound a host on mobile and bypassed
   * the mounted `<HostPicker />` (Flow 6). D7's "next available" rule
   * therefore lives in `nextAvailableEntry`, which answers a different
   * question - where an ALREADY-BOUND window goes when its host dies, a move
   * the user is told about and which is undone when their host returns -
   * rather than choosing a host for a user who has never picked one.
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

  onSelectionChange(
    handler: (entry: HostDirectoryEntry | null) => void,
  ): Disposable {
    this.selectionListeners.add(handler);
    return {
      dispose: () => {
        this.selectionListeners.delete(handler);
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
    this.selectionListeners.clear();
    this.started = false;
  }

  private startRefreshPolling(): void {
    if (this.refreshIntervalId !== null) {
      return;
    }
    if (typeof window === "undefined") {
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
    }, HOST_DIRECTORY_REFRESH_POLL_MS);
  }

  private stopRefreshPolling(): void {
    if (this.refreshIntervalId !== null && typeof window !== "undefined") {
      window.clearInterval(this.refreshIntervalId);
    }
    this.refreshIntervalId = null;
    this.visibilityDocument?.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    this.visibilityDocument = null;
  }

  private isDocumentHidden(): boolean {
    return this.visibilityDocument !== null && this.visibilityDocument.hidden;
  }

  /**
   * On `failed`, retains the last-known `remoteEntries` and skips
   * `reconcileSelection()` - a transient blip must never unbind an active
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
        this.retireFailoverStateOnAuthoritativeClear(outcome.kind);
        this.reconcileSelection();
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
    this.remoteEntries = outcome.kind === "hosts" ? outcome.entries : [];
    this.hasGenuineRemoteOutcome = true;
    this.retireFailoverStateOnAuthoritativeClear(outcome.kind);
    await this.reseedLocalHostIdIfUnknown();
    this.consumeRestoreAfterFailedRefresh();
    if (outcome.kind === "hosts") {
      this.consumeUnboundFollowUpRestore(outcome.entries);
    }
    this.reconcileSelection();
    // AFTER `reconcileSelection`, which has already refreshed the selection to
    // this read's row - so the dialability test below runs on what the
    // registry just said, not on the object bound one poll ago.
    this.reconcileSelectionDialability();
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
   * Updating only the field left the persisted `last-selected-host` (and the
   * in-flight restore intents already loaded from it - `start()` loads them
   * BEFORE the seed runs) restoring that obsolete row as a valid remote
   * selection, which `reconcileSelection()` then preserves: the app strands
   * on a dead relay target with the local Retry path disabled - the exact
   * lockout the id tracking exists to prevent. So the selection INTENT
   * migrates with the id: "this machine" follows the machine.
   *
   * Enumerated holders, migrated here: the persisted selection, the three
   * one-shot restore intents, and a live `explicitSelection`. Deliberately
   * NOT migrated: tab bindings (bound to a hostId for life by design -
   * cross-host is clone-not-migrate) and notification origin ids (ephemeral,
   * scoped to a delivered notification).
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
    if (this.startupRestoreHostId === previous) {
      this.startupRestoreHostId = next;
    }
    if (this.restoreAfterFailedRefreshHostId === previous) {
      this.restoreAfterFailedRefreshHostId = next;
    }
    if (this.unboundFollowUpRestoreHostId === previous) {
      this.unboundFollowUpRestoreHostId = next;
    }
    if (
      this.explicitSelection !== null &&
      this.explicitSelection.hostId === previous
    ) {
      this.explicitSelection = { hostId: next };
    }
    // The Settings viewing scope is a holder too. A pin of this machine's
    // OLD id would keep Settings administering the dead registry twin (and
    // read `vanished` once the twin deregisters). A genuine remote pin never
    // matches `previous`, so it is left alone.
    const settingsScope = useSettingsHostScopeStore.getState();
    if (settingsScope.scopedHostId === previous) {
      settingsScope.setScopedHostId(next);
    }
    if (loadPersistedHostSelection() === previous) {
      persistHostSelection(next);
    }
    // The LIVE selection is a holder too, and intent alone cannot move it:
    // `reconcileSelection()` keeps any selected id it can still find, and the
    // obsolete twin usually remains listed until deregistration propagates.
    // At seed time nothing is selected yet, so this only acts on the live
    // re-enrollment path - where the caller just installed the new local
    // entry, making it resolvable here.
    if (this.selected !== null && this.selected.hostId === previous) {
      this.setSelected(this.findById(next));
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

  private setSelected(entry: HostDirectoryEntry | null): void {
    if (this.selected === entry) {
      return;
    }
    this.selected = entry;
    appLogger.debug("[host-directory] effective host selection changed", {
      hostId: entry?.hostId ?? null,
      kind: entry?.kind ?? null,
      hasWebsocketUrl: entry !== null && entry.websocketUrl !== null,
    });
    for (const handler of this.selectionListeners) {
      handler(entry);
    }
  }

  private preparePersistedSelectionRestore(): void {
    this.startupRestoreHostId = null;
    this.unboundFollowUpRestoreHostId = null;
    this.restoreAfterFailedRefreshHostId = null;
    this.hasGenuineRemoteOutcome = false;
    if (this.explicitSelection !== null) {
      return;
    }
    this.startupRestoreHostId = loadPersistedHostSelection();
  }

  private resolveStartupRestore(): void {
    const hostId = this.startupRestoreHostId;
    if (hostId === null) {
      return;
    }
    this.startupRestoreHostId = null;
    if (this.restorePersistedHostById(hostId)) {
      return;
    }
    if (!this.hasGenuineRemoteOutcome) {
      // The initial refresh FAILED, so the remembered host's absence proves
      // nothing about deregistration - a transient network blip at launch
      // must not consume the user's persisted selection ("we do not silently
      // move them"). Promote the default below for usability, but keep a
      // one-shot retry armed so the first refresh that genuinely resolves can
      // still restore the remembered host.
      this.restoreAfterFailedRefreshHostId = hostId;
    }
    this.reconcileSelection();
    if (
      this.selected === null &&
      this.explicitSelection === null &&
      this.localEntry === null &&
      this.getDefaultEntry() === null
    ) {
      this.unboundFollowUpRestoreHostId = hostId;
    }
  }

  /**
   * Settles the failed-initial-refresh restore retry on the FIRST genuine
   * fetcher outcome: restore the remembered host if the registry still knows
   * it (overriding only an auto-promoted default - an explicit pick made in
   * the meantime wins and already retired this one-shot), or retire the
   * intent when the genuine result omits it, exactly as a genuine FIRST
   * refresh would have fallen to the default (the deregistered case).
   */
  private consumeRestoreAfterFailedRefresh(): void {
    const hostId = this.restoreAfterFailedRefreshHostId;
    if (hostId === null) {
      return;
    }
    this.restoreAfterFailedRefreshHostId = null;
    if (this.explicitSelection !== null) {
      return;
    }
    this.restorePersistedHostById(hostId);
  }

  private consumeUnboundFollowUpRestore(
    remoteEntries: readonly HostDirectoryEntry[],
  ): void {
    const hostId = this.unboundFollowUpRestoreHostId;
    if (hostId === null) {
      return;
    }
    if (remoteEntries.length === 0) {
      return;
    }
    if (this.selected !== null || this.explicitSelection !== null) {
      // Something else already resolved a selection while this was pending
      // (e.g. a manual pick) - the "still fully unbound" precondition no
      // longer holds, so retire the one-shot rather than keep chasing it.
      this.unboundFollowUpRestoreHostId = null;
      return;
    }
    // Only consumed on an actual match - `restorePersistedHostById` clears
    // it itself on success. A batch that doesn't contain the remembered host
    // must not burn the one shot; leave it armed for the next delivery.
    this.restorePersistedHostById(hostId);
  }

  private restorePersistedHostById(hostId: string): boolean {
    const entry = this.findById(hostId);
    if (entry === null) {
      return false;
    }
    this.explicitSelection = { hostId };
    this.unboundFollowUpRestoreHostId = null;
    appLogger.debug("[host-directory] persisted host selection restored", {
      hostId,
    });
    this.setSelected(entry);
    return true;
  }

  private reconcileSelection(): void {
    if (this.selected !== null) {
      const fresh = this.findById(this.selected.hostId);
      if (fresh !== null) {
        // Value equality, not identity: a remote-registry refresh rebuilds
        // every entry object each poll, so an identity compare would re-fire
        // the selection listeners every ~60s with an unchanged host.
        if (!hostDirectoryEntriesEqual(fresh, this.selected)) {
          this.selected = fresh;
          appLogger.debug(
            "[host-directory] effective host selection refreshed",
            {
              hostId: fresh.hostId,
              kind: fresh.kind,
              hasWebsocketUrl: fresh.websocketUrl !== null,
            },
          );
          for (const handler of this.selectionListeners) {
            handler(fresh);
          }
        }
        return;
      }
      // The selected host left the directory. Fall through to resolve the
      // next selection from INTENT rather than clearing and waiting for a
      // later pass: a selection with no durable intent behind it (a transient
      // notification activation) hands straight back to the default host in
      // one transition, instead of leaving the app unbound until the next
      // refresh happens to arrive. An explicit pick still resolves to the
      // same `null` it always did - the user chose that host, so we do not
      // silently move them somewhere else.
    }
    if (this.startupRestoreHostId !== null) {
      // A startup restore is still pending (Remote Host Support): resolving
      // from intent now would auto-promote the default host before the
      // remembered host's first directory batch has had a chance to arrive.
      return;
    }
    const next = this.selectionFromIntent();
    if (next !== null && this.explicitSelection === null) {
      // The default host was promoted while fully unbound - the one-shot
      // unbound follow-up restore no longer applies; retire it.
      this.unboundFollowUpRestoreHostId = null;
    }
    if (next === null && this.failoverOriginHostId !== null) {
      // BOTH ends of an in-progress failover are gone: the target this app was
      // moved to has left the directory, and so has the origin the intent
      // still names. Unbinding here stranded the window with a dialable host
      // sitting right there - `failOverFromDeadSelection` returns immediately
      // on a null selection, so nothing downstream picks it up.
      //
      // The "an explicit pick resolves to null, because the user chose that
      // host" rule above is not being broken. It has already been spent: a
      // failover moved this window off that pick once, which is exactly what
      // `failoverOriginHostId` records. Continuing that move is the same
      // decision, not a new one.
      //
      // Acting at once, with no dialability damping, matches how a VANISHED
      // host is handled everywhere here - the damping exists for a host that
      // is listed but will not dial, which is a different signal.
      const continuation = this.nextAvailableEntry(null);
      if (continuation !== null) {
        appLogger.debug(
          "[host-directory] failover target and origin both vanished, continuing",
          {
            failoverOriginHostId: this.failoverOriginHostId,
            continuationHostId: continuation.hostId,
          },
        );
        // The continuation is the failover machinery's own move, so the
        // hand-back marker stays redeemable: the target follows the app to
        // its new parking spot (cold review P2 - only a NON-failover route
        // moving the selection retires the marker).
        this.failoverTargetHostId = continuation.hostId;
        this.setSelected(continuation);
        return;
      }
    }
    this.setSelected(next);
  }

  /**
   * D7 auto-failover: keeps the app-wide selection pointed at a host it can
   * actually DIAL, not merely at one the registry still lists.
   *
   * `reconcileSelection` deliberately treats "still listed" as "still fine" -
   * that is what keeps a selection stable through registry churn - so a remote
   * host whose presence lease lapsed stayed bound indefinitely and the app
   * stranded on the actionless full-screen card. This is the one place that
   * reads dialability, and it runs on the refresh path only, so "consecutive"
   * means consecutive genuine reads of the registry.
   *
   * Two moves, in priority order:
   *
   *  1. Re-adopt the host a previous failover moved off, once it has been
   *     dialable for {@link CONSECUTIVE_DIALABILITY_READS} consecutive reads.
   *     The failover never rewrote `explicitSelection`, so this restores the
   *     remembered origin - an explicit pick, or (since F7) an auto/default/
   *     transient selection - rather than making a new decision for them.
   *  2. Fail over off a listed-but-non-dialable selection, after the same
   *     {@link CONSECUTIVE_DIALABILITY_READS} consecutive reads say so.
   *
   * Both moves go through `selectTransientById`, so the durable intent is
   * untouched in either direction and one selection change produces exactly
   * one `hostClient.bind` (`HostRuntime`), which is also what raises the
   * status strip's "Switching to …".
   *
   * Guard rails (D7.5), and where each one lives:
   *  - never off THIS machine's own host - a local row that cannot be dialed
   *    is a host booting or restarting, and its provisioning lifecycle owns
   *    that recovery (the 2026-07-14 mass-false-positive incident is what an
   *    availability read taken inside that window looks like when it is
   *    treated as death);
   *  - never TO a non-dialable entry, and never to the dead host itself
   *    (`nextAvailableEntry`), which is also what makes "the dead host is the
   *    only host" a no-op;
   *  - an empty directory cannot reach the failover branch at all: with no
   *    rows the selection does not resolve, so `reconcileSelection` has
   *    already taken the vanished-selection path above.
   */
  private reconcileSelectionDialability(): void {
    if (this.readoptFailoverOrigin()) {
      return;
    }
    this.failOverFromDeadSelection();
  }

  /**
   * Drops the failover's whole memory - the origin marker and both dialability
   * streaks - when a genuine outcome says the REGISTRY this state describes no
   * longer holds anything.
   *
   * The trigger is the remote registry coming back EMPTY, which both genuine
   * clearing outcomes produce (`signed-out` empties `remoteEntries`, and so
   * does a `hosts` result with no entries). Keyed on the remote side, not on
   * the merged snapshot, because everything this retires is about a remote
   * host: the marker can only ever name one (`failOverFromDeadSelection` arms
   * it from a remote row), so an empty registry means the marked host is not
   * merely unreachable - the account does not list it at all. Testing the
   * merged snapshot instead made the desktop case - where the local row keeps
   * that snapshot non-empty - silently skip the retirement, which is the shape
   * a user actually hits: parked on their local host after a failover, with
   * the registry since emptied.
   *
   * Without this the marker outlives its world. Sign out and back in and the
   * first refresh that re-lists the old host would re-adopt it - moving the
   * app-wide binding, with a toast, on the strength of a pick made in a
   * session this one is not. The streaks are retired for the same reason:
   * evidence counted against a registry that has since been cleared is not
   * evidence about this one.
   *
   * Deliberately NOT triggered by the marked host merely going missing from a
   * still-populated list. That is the outage this feature exists for - one
   * host deregistered or unreachable while others remain - and the whole
   * promise is that the user's pick survives it.
   */
  private retireFailoverStateOnAuthoritativeClear(
    outcomeKind: RemoteHostFetchOutcome["kind"],
  ): void {
    if (this.remoteEntries.length > 0) {
      return;
    }
    if (
      this.failoverOriginHostId === null &&
      this.nonDialableSelectionStreak === null &&
      this.dialableOriginStreak === null
    ) {
      return;
    }
    appLogger.debug("[host-directory] retiring failover state", {
      reason: outcomeKind === "signed-out" ? "signed-out" : "empty-registry",
      originHostId: this.failoverOriginHostId,
    });
    this.failoverOriginHostId = null;
    this.failoverTargetHostId = null;
    this.nonDialableSelectionStreak = null;
    this.dialableOriginStreak = null;
  }

  private readoptFailoverOrigin(): boolean {
    const hostId = this.failoverOriginHostId;
    if (hostId === null) {
      return false;
    }
    if (this.selected !== null && this.selected.hostId === hostId) {
      // Already back on it by some other route (a restore, a re-enrollment
      // migration): the marker has nothing left to do.
      this.failoverOriginHostId = null;
      this.failoverTargetHostId = null;
      this.dialableOriginStreak = null;
      return false;
    }
    if (
      this.selected === null ||
      this.failoverTargetHostId === null ||
      this.selected.hostId !== this.failoverTargetHostId
    ) {
      // The app is no longer parked where the failover left it: some route
      // that does not manage this marker moved (or cleared) the selection.
      // The hand-back promise - "undo the failover's own move" - has nothing
      // left to undo, and redeeming it anyway is exactly the P2 selection
      // steal (it would override whatever moved the app since). Defensive
      // belt to `selectTransientById`'s retirement: any route we did not
      // foresee still cannot redeem a stale marker.
      appLogger.debug(
        "[host-directory] failover marker stale - selection moved off the failover target",
        {
          originHostId: hostId,
          failoverTargetHostId: this.failoverTargetHostId,
          selectedHostId: this.selected === null ? null : this.selected.hostId,
        },
      );
      this.failoverOriginHostId = null;
      this.failoverTargetHostId = null;
      this.dialableOriginStreak = null;
      return false;
    }
    const entry = this.findById(hostId);
    if (entry === null || !isEntryDialable(entry)) {
      // Absent or still not dialable. A host that answered ONE read and
      // lapsed again was flapping, not recovering, so the count restarts from
      // zero rather than accumulating across the gap - the same evidence bar
      // the death streak sets.
      this.dialableOriginStreak = null;
      return false;
    }
    const count = nextStreakCount(this.dialableOriginStreak, hostId);
    this.dialableOriginStreak = { hostId, count };
    if (count < CONSECUTIVE_DIALABILITY_READS) {
      appLogger.debug(
        "[host-directory] failover origin answered once, waiting for a second read",
        { hostId, reads: count },
      );
      return false;
    }
    this.failoverOriginHostId = null;
    this.failoverTargetHostId = null;
    this.dialableOriginStreak = null;
    this.nonDialableSelectionStreak = null;
    appLogger.debug("[host-directory] failover origin is dialable again", {
      hostId,
      reads: count,
    });
    this.selectTransientById(hostId, "host_failover");
    toastHostSwitched(entry, `${hostSwitchLabel(entry)} is available again.`);
    return true;
  }

  private failOverFromDeadSelection(): void {
    const selected = this.selected;
    if (selected === null) {
      this.nonDialableSelectionStreak = null;
      return;
    }
    const fresh = this.findById(selected.hostId);
    // A row that VANISHED is `reconcileSelection`'s business - it resolves the
    // next selection from intent. This path is only about a row that is still
    // listed and no longer usable.
    if (fresh === null || isEntryDialable(fresh)) {
      this.nonDialableSelectionStreak = null;
      return;
    }
    // Re-homing the app-wide selection is the most disruptive thing in this
    // file: it moves every new piece of work to a different MACHINE. So it
    // demands positive evidence the host is dead, not merely the absence of
    // evidence that it is alive.
    //
    // `isConfirmedHostDeath` withholds exactly the two cases that are not
    // evidence — a failed liveness read (`indeterminate`) and a plan-gated
    // host that never attaches by design — and honours a live E2E session as
    // firsthand proof. Without it, one degraded Redis read on the cloud side
    // moved the user's window off a host they were actively working on, and
    // the debounce below did not help: the poll re-reads the same degraded
    // answer, so two consecutive reads agree and the streak completes.
    if (!isConfirmedHostDeath(fresh, hasReadyRemoteSession(fresh.hostId))) {
      this.nonDialableSelectionStreak = null;
      return;
    }
    if (isThisMachineKind(fresh)) {
      // THIS machine's own host, down: it is booting or restarting and the
      // local provisioning lifecycle owns that recovery. See the guard-rail
      // note above - re-homing the window onto a different MACHINE here is
      // the 2026-07-14 false-positive shape.
      this.nonDialableSelectionStreak = null;
      return;
    }
    // Clamped, because the streak is a STATE MARKER ("confirmed dead") and not
    // a census. Left uncapped it gained one per 60s poll for as long as a host
    // stayed dead with nothing to fail over to, so the `reads:` value below
    // grew into the thousands and stopped meaning "reads before we act" -
    // which is the only thing anyone reading that line wants from it.
    const count = Math.min(
      nextStreakCount(this.nonDialableSelectionStreak, fresh.hostId),
      CONSECUTIVE_DIALABILITY_READS,
    );
    this.nonDialableSelectionStreak = { hostId: fresh.hostId, count };
    if (count < CONSECUTIVE_DIALABILITY_READS) {
      appLogger.debug(
        "[host-directory] selected host is not dialable, waiting for a second read",
        { hostId: fresh.hostId, reads: count },
      );
      return;
    }
    const next = this.nextAvailableEntry(fresh.hostId);
    if (next === null) {
      // Nothing to fail over TO. Stay put and let the readiness surface report
      // it: moving to a second host we cannot dial would re-home the window on
      // every poll and still leave the user on a dead host.
      //
      // The streak is deliberately left ARMED. The debounce guards against a
      // single stale read, not against acting once death is confirmed - two
      // reads already confirmed it - so the first poll that finally produces a
      // dialable candidate fails over immediately instead of re-serving a wait
      // the user has already sat through.
      appLogger.debug("[host-directory] no dialable host to fail over to", {
        hostId: fresh.hostId,
        totalCount: this.snapshot().length,
      });
      return;
    }
    // Armed BEFORE the bind: `selectTransientById` fans out to the selection
    // listeners synchronously, and the marker is what those listeners' world
    // needs to be able to hand the app back later.
    //
    // F7: every failover origin is remembered so the hand-back covers
    // auto/default/transient selections too, not only an explicit pick - a
    // transient false-`offline` must not permanently move the app-wide
    // selection off a host that is still working. Two guard rails keep that
    // safe:
    //   - the user's explicit pick ALWAYS (re)claims the marker for itself, so
    //     it outranks any auto/transient origin;
    //   - otherwise the marker is armed only when nothing already holds it, so
    //     a non-explicit failover never overwrites an existing claim. That is
    //     the second-outage case - explicit A dies, we move to B, B dies too -
    //     where clobbering with B would quietly retire the user's claim on A
    //     while A is still the host they chose.
    if (
      (this.explicitSelection !== null &&
        this.explicitSelection.hostId === fresh.hostId) ||
      this.failoverOriginHostId === null
    ) {
      this.failoverOriginHostId = fresh.hostId;
    }
    // The target ALWAYS tracks the newest failover move, even when the origin
    // marker above kept an older claim (explicit A dies -> B, B dies -> C:
    // origin stays A, target becomes C). The hand-back is redeemable only
    // while the selection still sits on this target (cold review P2).
    this.failoverTargetHostId = next.hostId;
    this.nonDialableSelectionStreak = null;
    appLogger.debug("[host-directory] failing over from a dead host", {
      from: fresh.hostId,
      to: next.hostId,
      // Always restorable since F7 (every failover arms or keeps an origin
      // claim, and the target above tracks this newest move), so the useful
      // datum is WHICH origin the hand-back would restore.
      originHostId: this.failoverOriginHostId,
    });
    this.selectTransientById(next.hostId, "host_failover");
    toastHostSwitched(next, `${hostSwitchLabel(fresh)} stopped responding.`);
  }

  /**
   * D7's next-available rule: this machine's own host when it is dialable,
   * else the first dialable entry, and never the host we are failing away
   * from.
   *
   * Deliberately NOT folded into `getDefaultEntry()`, which the sub-plan
   * proposed. That function answers "what should auto-bind for a user who has
   * never picked a host", and its `null` for a many-entry directory is the
   * Flow 6 rule - falling through to the first remote silently bound a host on
   * mobile and bypassed the mounted picker. This one answers "where does an
   * already-bound window go when its host dies", which is a different promise:
   * the user already has a host, the move is announced, and it is handed back
   * when their own host returns.
   *
   * Never returns a non-dialable candidate, and never the corpse: either would
   * just re-arm the whole failover path on the next poll.
   */
  private nextAvailableEntry(
    // `null` excludes nothing - used when the host being moved off has already
    // left the directory, so there is no id left to exclude.
    excludedHostId: string | null,
  ): HostDirectoryEntry | null {
    const candidates = this.snapshot().filter(
      (entry) => entry.hostId !== excludedHostId && isEntryDialable(entry),
    );
    const localCandidate = candidates.find(isThisMachineKind);
    if (localCandidate !== undefined) {
      return localCandidate;
    }
    return candidates.length === 0 ? null : candidates[0];
  }

  /**
   * The selection implied by durable intent alone, ignoring whatever is
   * currently selected: the user's explicit pick while the directory can
   * still resolve it, their explicit clear when they made one, and otherwise
   * the auto-promoted default host.
   */
  private selectionFromIntent(): HostDirectoryEntry | null {
    if (this.explicitSelection !== null) {
      if (this.explicitSelection.hostId === null) {
        return null;
      }
      return this.findById(this.explicitSelection.hostId);
    }
    return this.getDefaultEntry();
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

interface ExplicitHostSelection {
  readonly hostId: string | null;
}

interface DialabilityStreak {
  readonly hostId: string;
  readonly count: number;
}

/**
 * The streak count this read produces: one more than the last read when it was
 * about the SAME host, otherwise a fresh 1. Keying on the host id is what
 * keeps two different hosts' evidence from being added together - the marker
 * can move between hosts across a second outage.
 */
function nextStreakCount(
  streak: DialabilityStreak | null,
  hostId: string,
): number {
  if (streak === null || streak.hostId !== hostId) {
    return 1;
  }
  return streak.count + 1;
}

/**
 * Whether the directory POSITIVELY says this entry can be dialed right now: a
 * websocket URL plus the projection's `dialable` bit (for a remote row that is
 * `connectivity === "connectable"` - the relay holds a live attachment; for a
 * local row, the shell publishing a live snapshot).
 *
 * Deliberately NOT `dialableHostEndpoint(entry) !== null` any more (cold
 * review P1). That helper answers dial PERMISSION - "may a socket be
 * attempted" - which correctly stays open for `indeterminate` and for a
 * fuse-window `offline` (the recovery-dial affordance,
 * `isRelayFuseRecoveryCandidate`). The failover machinery here asks three
 * POSITIVE questions with it - is the selection still usable, is a candidate
 * worth failing over TO, has the origin actually returned - and answering
 * those from the permission gate let the fuse window's recency suppress
 * failover through a second door (and would let a mere dial-permitted corpse
 * be adopted as a failover target or trigger the hand-back). Death itself is
 * still judged by `isConfirmedHostDeath` below, so a degraded `unknown` read
 * remains non-evidence exactly as before.
 *
 * A READY remote session is the OTHER positive answer, and it is stronger
 * than the projection: a client holding an open E2E session has firsthand
 * proof the host is up (the same evidence that outranks the cloud in
 * `isConfirmedTransportRefusal` and `isConfirmedHostDeath`). Tabs stay bound
 * to their origin host across an app-wide failover, so exactly this arises: a
 * bound tab's fuse-recovery dial succeeds while the registry still says
 * `offline` - the origin is proven live and must be eligible for the
 * hand-back (and a proven-live candidate selectable) without waiting for the
 * cloud verdict to catch up. This is evidence, not permission: a fuse-window
 * `offline` with NO session still answers `false` here.
 */
function isEntryDialable(entry: HostDirectoryEntry): boolean {
  if (entry.websocketUrl === null) {
    return false;
  }
  if (entry.transportDialability === "dialable") {
    return true;
  }
  return hasReadyRemoteSession(entry.hostId);
}

/**
 * Whether the entry is THIS machine's own host - the live local snapshot or
 * the non-dialable booting twin `snapshot()` rewrites for it. `mock` counts as
 * local for the same reason every other host-kind test in the app treats it
 * that way: it is a locally-run host, not a machine reached through the relay.
 */
function isThisMachineKind(entry: HostDirectoryEntry): boolean {
  return entry.kind !== "remote";
}

function loadPersistedHostSelection(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(LAST_SELECTED_HOST_STORAGE_KEY);
    return raw !== null && raw.length > 0 ? raw : null;
  } catch (error) {
    appLogger.warn("[host-directory] persisted host selection load failed", {
      storageKey: LAST_SELECTED_HOST_STORAGE_KEY,
      error: describeLogError(error),
    });
    return null;
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

function persistHostSelection(hostId: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(LAST_SELECTED_HOST_STORAGE_KEY, hostId);
  } catch (error) {
    appLogger.warn("[host-directory] persisted host selection write failed", {
      storageKey: LAST_SELECTED_HOST_STORAGE_KEY,
      hostId,
      error: describeLogError(error),
    });
  }
}

function removePersistedHostSelection(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(LAST_SELECTED_HOST_STORAGE_KEY);
  } catch {
    // Best-effort cleanup; the load failure path already logged context.
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
