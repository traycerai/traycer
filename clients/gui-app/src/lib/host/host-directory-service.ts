import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { IHostDirectoryService } from "@traycer-clients/shared/host-client/host-runtime";
import {
  fetchRemoteHosts,
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
import {
  Analytics,
  AnalyticsEvent,
  type AnalyticsSource,
} from "@/lib/analytics";
import { lastLocalHostIdKey, lastSelectedHostKey } from "@/lib/persist";
import { dialableHostEndpoint } from "@/lib/host/transport-key";
import {
  hostSwitchLabel,
  toastHostSwitched,
} from "@/lib/host/host-switch-toast";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

const HOST_DIRECTORY_REFRESH_POLL_MS = 15_000;
const LAST_SELECTED_HOST_STORAGE_KEY = lastSelectedHostKey();
const LAST_LOCAL_HOST_ID_STORAGE_KEY = lastLocalHostIdKey();

/**
 * How many CONSECUTIVE genuine directory reads must agree about a host's
 * dialability before the app moves the app-wide binding, in EITHER direction
 * (D7).
 *
 * Two, not one. A presence lease lapses on its own schedule and the registry
 * is polled every ~15s; one read that arrives inside a lease gap - or a single
 * slow relay round-trip - is a blip, and re-homing the window on it would move
 * the user off a host that was never actually gone.
 *
 * ONE constant on purpose: an undamped recovery is the same defect as an
 * undamped death, just pointed the other way. A host that flaps
 * dialable/non-dialable would oscillate the binding at poll cadence - a toast
 * and a full app-wide query-scope invalidation every ~15s - if coming back
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
   * Armed ONLY when the user's explicit pick named that host: the failover is
   * deliberately transient (`explicitSelection` is never rewritten), and the
   * promise it makes is that the user's own choice survives the outage. A
   * selection that was itself auto-promoted or transient has no such claim -
   * the post-failover default is exactly as valid - so dragging the app back
   * to it would be a second unrequested move, not a restoration.
   */
  private failoverOriginHostId: string | null = null;
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
  private refreshInFlight: Promise<readonly HostDirectoryEntry[]> | null = null;
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

  refresh(): Promise<readonly HostDirectoryEntry[]> {
    if (this.refreshInFlight === null) {
      this.refreshInFlight = this.performRefresh().finally(() => {
        this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
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
  private async performRefresh(): Promise<readonly HostDirectoryEntry[]> {
    const outcome = await this.fetchRemoteOutcome();
    if (outcome.kind === "failed") {
      appLogger.debug(
        "[host-directory] refresh failed, retaining last-known remote entries",
        { remoteCount: this.remoteEntries.length },
      );
      return this.snapshot();
    }
    this.remoteEntries = outcome.kind === "hosts" ? outcome.entries : [];
    this.hasGenuineRemoteOutcome = true;
    this.retireFailoverStateOnAuthoritativeClear(outcome.kind);
    this.consumeRestoreAfterFailedRefresh();
    if (outcome.kind === "hosts") {
      this.consumeUnboundFollowUpRestore(outcome.entries);
    }
    this.reconcileSelection();
    // AFTER `reconcileSelection`, which has already refreshed the selection to
    // this read's row - so the dialability test below runs on what the
    // registry just said, not on the object bound one poll ago.
    this.reconcileSelectionDialability();
    // Emit only when the merged snapshot actually changed. The 15s registry
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
   */
  private async fetchRemoteOutcome(): Promise<RemoteHostFetchOutcome> {
    try {
      return await this.remoteFetcher();
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
        // the selection listeners every ~15s with an unchanged host.
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
   *     The failover never rewrote `explicitSelection`, so this hands the
   *     window back to the user's own pick rather than making a new decision
   *     for them.
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
    if (isThisMachineKind(fresh)) {
      // THIS machine's own host, down: it is booting or restarting and the
      // local provisioning lifecycle owns that recovery. See the guard-rail
      // note above - re-homing the window onto a different MACHINE here is
      // the 2026-07-14 false-positive shape.
      this.nonDialableSelectionStreak = null;
      return;
    }
    // Clamped, because the streak is a STATE MARKER ("confirmed dead") and not
    // a census. Left uncapped it gained one per 15s poll for as long as a host
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
    // A host we are failing away from that is NOT the explicit pick keeps
    // whatever marker is already armed rather than clearing it. That is the
    // second-outage case - explicit A dies, we move to B, B dies too - where
    // overwriting with `null` would quietly retire the user's claim on A while
    // A is still the host they chose.
    if (
      this.explicitSelection !== null &&
      this.explicitSelection.hostId === fresh.hostId
    ) {
      this.failoverOriginHostId = fresh.hostId;
    }
    this.nonDialableSelectionStreak = null;
    appLogger.debug("[host-directory] failing over from a dead host", {
      from: fresh.hostId,
      to: next.hostId,
      restorable: this.failoverOriginHostId !== null,
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
 * Whether a socket can be opened against this entry RIGHT NOW, through the
 * repository's canonical rule (`dialableHostEndpoint`: a websocket URL plus an
 * `available` status) rather than a second copy of it. The app-wide transport,
 * the per-tab streams and the readiness controller all gate on that same rule,
 * so a selection this says yes to is a selection those can actually use.
 */
function isEntryDialable(entry: HostDirectoryEntry): boolean {
  return dialableHostEndpoint(entry) !== null;
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
 * reassign and fan out to every `onSelectionChange` handler on every 15s
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
    a.status === b.status &&
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
 * `status` is forced to `unavailable` rather than carried over from the twin's
 * presence lease. It is the truth - this host cannot be reached - and status
 * transitions are an event other surfaces subscribe to: the landing-terminal
 * tombstone recovery bridge fires its pending kill on an
 * `unavailable -> available` edge. Copying the lease's `available` would make
 * it fire at boot against an entry with no `websocketUrl` (the mutation
 * rejects), and then see no edge when the real host publishes - stranding the
 * tombstone and leaving the host terminal alive.
 */
function bootingLocalEntry(twin: HostDirectoryEntry): HostDirectoryEntry {
  return {
    hostId: twin.hostId,
    label: twin.label,
    kind: "local",
    websocketUrl: null,
    version: twin.version,
    status: "unavailable",
  };
}

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
    status: "available",
  };
}
