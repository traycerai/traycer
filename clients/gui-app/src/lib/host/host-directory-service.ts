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

/** The app's ONE background cadence for `GET /api/v3/hosts`. */
const HOST_DIRECTORY_REFRESH_POLL_MS = 60_000;
const LAST_LOCAL_HOST_ID_STORAGE_KEY = lastLocalHostIdKey();

export interface HostDirectoryServiceOptions {
  readonly runnerHost: IRunnerHost;
  /**
   * Fetcher for remote hosts.
   * Defaults to the shared stubbed `fetchRemoteHosts` (returns an empty hosts result) so the composition is the same in production and tests; tests can pass a custom fetcher to assert merged directory behavior.
   */
  readonly remoteFetcher: RemoteHostFetcher | null;
  /**
   * Fired on each poll tick so the app's other registry readers can refresh off this ONE timer (redesign P4.1 / F22).
   * `null` for shells and tests with no query cache to invalidate.
   */
  readonly onRegistryPollTick: (() => void) | null;
  /**
   * Identity of the auth context a refresh is being made ON BEHALF OF, read at the moment it is needed.
   * `null` disables identity scoping - correct only for tests with a single implicit account.
   */
  readonly authContextId: (() => string | null) | null;
  /**
   * Monotonic counter that advances on every credential change, INCLUDING a same-user rotation.
   * `null` disables the credential fence - tests only.
   */
  readonly credentialGeneration: (() => number) | null;
  /**
   * Resolves this machine's durable local host id (see `lastKnownLocalHostId`).
   * Injected like `remoteFetcher` rather than read off `runnerHost` inside the service: this class is constructed outside React and cannot use hooks, so the composition root stays the one place that decides HOW a shell request is made.
   */
  readonly localHostIdSeeder: (() => Promise<string | null>) | null;
}

export type HostDirectoryListener = (
  entries: readonly HostDirectoryEntry[],
  localEntry: HostDirectoryEntry | null,
) => void;

/** GUI-owned host directory implementing the shared `IHostDirectoryService` port consumed by `HostRuntime`. */
export class HostDirectoryService implements IHostDirectoryService {
  private readonly runnerHost: IRunnerHost;
  private readonly remoteFetcher: RemoteHostFetcher;
  private readonly onRegistryPollTick: (() => void) | null;
  private readonly authContextId: () => string | null;
  private readonly credentialGeneration: () => number;
  private readonly localHostIdSeeder: () => Promise<string | null>;
  private localEntry: HostDirectoryEntry | null = null;
  /** The hostId this MACHINE's local host last published. */
  private lastKnownLocalHostId: string | null = loadPersistedLocalHostId();
  private remoteEntries: readonly HostDirectoryEntry[] = [];
  /**
   * The snapshot most recently fanned out through `emit()`, kept so the poll path (`emitIfSnapshotChanged`) can suppress no-change re-emits.
   * `null` only before the first emit.
   */
  private lastEmittedSnapshot: readonly HostDirectoryEntry[] | null = null;
  /**
   * True once a fetch has actually DELIVERED a registry listing (`hosts`), empty or not.
   * It is what separates "the registry says you own no hosts" from "nobody has managed to ask the registry yet", which an empty `remoteEntries` alone cannot say - see `getCardinality()`.
   */
  private hasObservedRemoteListing = false;
  private readonly listeners = new Set<HostDirectoryListener>();
  /**
   * Refresh-liveness subscribers, kept OFF the main `listeners` fan-out on purpose: a refresh starting and finishing changes no entry, and the directory snapshot feeds ~17 query call sites that would re-render twice per poll tick for a signal only the.
   */
  private readonly refreshStateListeners = new Set<
    (refreshing: boolean) => void
  >();
  private localSubscription: Disposable | null = null;
  private started = false;
  private refreshIntervalId: number | null = null;
  private visibilityDocument: Document | null = null;
  /**
   * The shell's own registry cadence, when it has one (desktop's main process - redesign P4.1/F22).
   * Non-null means this window arms NO interval of its own: the push IS the tick.
   */
  private registrySubscription: Disposable | null = null;
  /**
   * Coalesces concurrent `refresh()` callers onto a single in-flight fetch (T20 / audit P4) - a foundation for T21's interval + open-time triggers, which would otherwise stack requests.
   */
  /**
   * The in-flight refresh, WITH the credential era it was started for.
   * Joining is only legal for a caller in that same era - see `refreshForEra`.
   */
  private refreshInFlight: {
    readonly era: AuthEra;
    readonly request: Promise<readonly HostDirectoryEntry[]>;
  } | null = null;
  /**
   * The credential generation of the most recent COMMITTED outcome - the ordering half of the commit guard.
   * The era fences answer "may this credential's observation be believed at all"; this watermark answers "has a NEWER credential's observation already landed".
   */
  private lastCommitCredentialGeneration: number | null = null;
  /**
   * The identity the committed `remoteEntries` belong to - the OWNERSHIP half of the retention rule.
   * The `failed` branch keeps the last-known list on the grounds that a network blip should not blank a directory, but that grounds only holds when the list describes the SAME account: after a direct A -> B account switch whose first read under B fails.
   */
  private lastCommitIdentity: string | null = null;
  private readonly handleVisibilityChange = (): void => {
    if (this.isDocumentHidden()) {
      return;
    }
    // Resume from hidden: refresh now AND rearm the poll clock from this point, so the already-scheduled tick (whatever was left of its pre-hidden schedule) doesn't also fire moments later.
    this.armPollInterval();
    void this.refresh();
  };

  /**
   * The push-riding twin of {@link handleVisibilityChange}: no poll clock to rearm, so a resume acts only on a push that arrived while hidden.
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

  /** Initializes the service and RESOLVES ONCE THE REGISTRY HAS ANSWERED. */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.startSeeded();
    // `startSeeded` gives up on a service disposed mid-seed; do not turn that
    // into a fetch nobody is waiting for.
    if (!this.isStarted()) {
      return;
    }
    await this.refresh();
  }

  /**
   * Initializes the service and resolves as soon as it can ANSWER - which is before the registry has said anything.
   */
  async startSeeded(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.hasObservedRemoteListing = false;
    // BEFORE the first refresh: the very first launch after the upgrade that introduced the persisted key has nothing stored, and that launch is exactly the reinstall this guard exists for - the host is down, so no snapshot will seed it either.
    await this.seedLocalHostIdFromShell();
    // The seed introduced an await BEFORE the subscription exists, so a provider that unmounts or swaps its runner mid-flight can call `dispose()` while nothing is registered yet.
    // Without this recheck `start()` would resume onto a disposed service and install a local-host listener that no `dispose()` will ever remove - an orphan dispatching stale callbacks for the life of the page.
    if (!this.isStarted()) {
      return;
    }
    this.localSubscription = this.runnerHost.onLocalHostChange((snapshot) => {
      this.localEntry = toLocalEntry(snapshot);
      if (snapshot !== null && snapshot.hostId !== this.lastKnownLocalHostId) {
        this.adoptLocalHostId(snapshot.hostId);
      }
      appLogger.info("[host-directory] local host snapshot changed", {
        hostId: snapshot?.hostId ?? null,
        hasWebsocketUrl: snapshot !== null,
        status: snapshot === null ? "missing" : "available",
        version: snapshot?.version ?? null,
      });
      this.emit();
    });
    // Issued, not awaited.
    // See this method's doc for why nothing that paints needs it.
    void this.refresh()
      .then(() => {
        // Replaces a diagnostic this change would otherwise have deleted.
        // `[host-runtime] startup complete` logs `hostCardinality` at info, and now reports `"unknown"` every time - truthfully, since the listing is still in flight when boot completes, but uselessly.
        appLogger.info("[host-directory] initial listing settled", {
          cardinality: this.getCardinality(),
          remoteCount: this.remoteEntries.length,
        });
      })
      .catch((error: unknown) => {
        appLogger.warn("[host-directory] initial refresh failed", {
          error: describeLogError(error),
        });
      });
    // Read through a method, not the bare field: a listener woken by the synchronous local-host replay above can re-enter and `dispose()` this service before we get here, but a direct `this.started` read is narrowed by the compiler to the literal `true` assigned.
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
   * This machine's own local host id as the directory knows it: seeded from the shell's durable pid metadata, then adopted from every local snapshot.
   * `null` only on a machine whose local host has never announced itself.
   */
  getLocalHostId(): string | null {
    return this.lastKnownLocalHostId;
  }

  /** Refresh the merged directory, coalescing concurrent callers. */
  refresh(): Promise<readonly HostDirectoryEntry[]> {
    // An AMBIENT caller - the poll, a focus refetch, picker-open, a local-host transition.
    // Nothing is mid-transition, so reading both halves of the era here reads one settled state.
    return this.refreshForEra({
      identity: this.authContextId(),
      credentialGeneration: this.credentialGeneration(),
    });
  }

  /** Refresh on behalf of an EXPLICITLY NAMED credential era. */
  refreshForEra(era: AuthEra): Promise<readonly HostDirectoryEntry[]> {
    const inFlight = this.refreshInFlight;
    // Keyed by the WHOLE era, not just the identity: a request issued before a same-user rotation is answering for a credential this caller no longer holds, and joining it is how a caller inherits somebody else's 401.
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
      this.emitRefreshState();
    });
    this.refreshInFlight = { era, request };
    // After the assignment, so `isRefreshing()` already answers true for a
    // listener that reads it synchronously from this notification.
    this.emitRefreshState();
    return request;
  }

  /** Drop any in-flight refresh so the next caller starts a fresh one. */
  invalidateInFlightRefresh(): void {
    this.refreshInFlight = null;
    this.emitRefreshState();
  }

  /**
   * Whether a registry fetch is in flight right now - a manual one or the background poll, since `refresh()` coalesces both onto one request.
   * Drives the manual-refresh affordance's pending state on the readiness surfaces that offer it.
   */
  isRefreshing(): boolean {
    return this.refreshInFlight !== null;
  }

  onRefreshStateChange(listener: (refreshing: boolean) => void): Disposable {
    this.refreshStateListeners.add(listener);
    return {
      dispose: () => {
        this.refreshStateListeners.delete(listener);
      },
    };
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

  /** Resolves the host that should auto-bind when no explicit selection has been made yet. */
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

  /** Returns the cardinality of the merged directory. */
  getCardinality(): "unknown" | "zero" | "one" | "many" {
    const total = this.snapshot().length;
    if (total === 0) {
      return this.hasObservedRemoteListing ? "zero" : "unknown";
    }
    if (total === 1) {
      return "one";
    }
    return "many";
  }

  /**
   * Whether the fleet this directory reports is one the REGISTRY has actually answered for - so a caller can tell "not in the list" apart from "nobody has managed to ask".
   */
  hasSettledFleet(): boolean {
    return this.hasObservedRemoteListing;
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
    this.refreshStateListeners.clear();
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
   * Rides the shell's registry cadence when it has one.
   * Returns whether it took ownership, so the caller knows not to arm a second source.
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
      // HIDDEN WINDOWS DO NOT REFETCH ON A PUSH, the same rule the timer path applies to its own tick.
      // Riding pushes returned from `start()` before `visibilityDocument` was ever assigned, so `isDocumentHidden()` was permanently false on desktop and every background window issued its own `GET /api/v3/hosts` on each of main's 60 s ticks - the very fetch the.
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
   * What one shell push drives: the SAME two things the interval tick drives, through the same paths (see the doc above for why the pushed rows are not seeded directly).
   */
  private applyRegistryPush(): void {
    void this.refresh();
    if (this.onRegistryPollTick !== null) {
      this.onRegistryPollTick();
    }
  }

  /**
   * (Re)arms the poll timer from now.
   * Called on initial setup and again on every visibility resume, so a tab that was hidden gets a fresh `HOST_DIRECTORY_REFRESH_POLL_MS` window from the moment it resumes instead of also firing whatever tick was already scheduled seconds later.
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
      // THE APP'S ONE LIVENESS TIMER (redesign P4.1 / F22).
      // This tick used to have a twin: a second 60s `refetchInterval` on the registered-hosts query, against the same `GET /api/v3/hosts`, which this file's own comment already called out as not the goal.
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
   * On `failed`, retains the last-known `remoteEntries` and does not re-resolve the bound row - a transient blip must never unbind an active remote selection (T20 / audit P4).
   * `signed-out` clears remotes exactly as a successful empty `hosts` result would.
   */
  private async performRefresh(
    era: AuthEra,
  ): Promise<readonly HostDirectoryEntry[]> {
    // The era goes DOWN to the fetcher, not just into the guards below.
    // A guard can only decide whether to keep an answer; the fetcher is the only layer that can decide which credential the question is asked with, and asking with the wrong one is the failure the guards kept failing to catch - the answer that comes back is.
    const outcome = await this.fetchRemoteOutcome(era);
    // THE COMMIT GUARD.
    // Everything below mutates a long-lived, app-wide object: `remoteEntries`, the selection, the emit every consumer refetches on.
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
      return this.retainOrDropAfterFailedRefresh(era);
    }
    // The ORDERING fence, completing the era fences above.
    // A constructive read issued under a superseded credential is still ALLOWED to commit - it describes the right account's hosts, and discarding it outright would trade a valid answer for a stale directory until the next poll.
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
    // Tracks BOTH directions.
    // `signed-out` un-observes the listing it once saw: it clears `remoteEntries` without the registry having said a word, so a bearer that rotates out from under a directory holding host A left the historical flag standing and turned the clear into the claim.
    const observedBefore = this.hasObservedRemoteListing;
    this.hasObservedRemoteListing = outcome.kind === "hosts";
    const observedChanged = observedBefore !== this.hasObservedRemoteListing;
    // A host registered late - from the CLI, or from another machine - reaches this directory through its own poll, while the selection authority's fleet (desktop main) stays stale.
    // Activate on it then refuses `unknown-host`: the user is told a machine they just registered is "no longer registered to this account".
    if (
      outcome.kind === "hosts" &&
      outcome.entries.some((entry) => !previousRemoteIds.has(entry.hostId))
    ) {
      requestFleetRefresh(this.runnerHost);
    }
    await this.reseedLocalHostIdIfUnknown();
    if (observedChanged) {
      // Crossing between "unknown" and "zero" changes `getCardinality()`'s answer while an EMPTY directory stays byte-for-byte identical either way - so the snapshot compare below would swallow the one emit that redraws the readiness gate.
      this.emit();
    } else {
      // Emit only when the merged snapshot actually changed.
      // The 60s registry poll lands here on every tick; an unconditional emit made every `onChange` consumer (17 query call sites) re-render/refetch app-wide each tick even when nothing changed.
      this.emitIfSnapshotChanged();
    }
    appLogger.debug("[host-directory] refresh complete", {
      outcome: outcome.kind,
      localCount: this.localEntry === null ? 0 : 1,
      remoteCount: this.remoteEntries.length,
      totalCount: this.snapshot().length,
    });
    return this.snapshot();
  }

  /**
   * The `failed` arm of `performRefresh`, split out for the complexity budget: retention is only safe for the same identity, so a foreign residue (rows OR a foreign observed-listing flag) is dropped rather than retained, with the emit choice mirroring the.
   */
  private retainOrDropAfterFailedRefresh(
    era: AuthEra,
  ): readonly HostDirectoryEntry[] {
    // Retention is only safe for the SAME identity.
    // The era fence above has already proven `era.identity` is the CURRENT identity, so a mismatch here means the retained list was committed by a previous account: keeping it would show (and keep bindable) A's machines under B's session until some later read.
    const foreignIdentity = this.lastCommitIdentity !== era.identity;
    const foreignObservedListing =
      foreignIdentity && this.hasObservedRemoteListing;
    if (
      foreignIdentity &&
      (this.remoteEntries.length > 0 || foreignObservedListing)
    ) {
      appLogger.debug(
        "[host-directory] dropping directory state committed under a previous identity after a failed refresh",
        {
          remoteCount: this.remoteEntries.length,
          observedListing: this.hasObservedRemoteListing,
        },
      );
      this.remoteEntries = [];
      this.lastCommitIdentity = null;
      this.hasObservedRemoteListing = false;
      // Un-observing moves `getCardinality()` between its unknown and zero answers over a directory that is empty EITHER WAY, so the snapshot compare would swallow the one emit that redraws the readiness gate - the same reason the commit path emits unconditionally.
      if (foreignObservedListing) {
        this.emit();
      } else {
        this.emitIfSnapshotChanged();
      }
      return this.snapshot();
    }
    appLogger.debug(
      "[host-directory] refresh failed, retaining last-known remote entries",
      { remoteCount: this.remoteEntries.length },
    );
    return this.snapshot();
  }

  /**
   * Runs the fetcher, collapsing a REJECTED fetcher promise into the same `failed` outcome a well-behaved fetcher returns.
   * Without this a throwing fetcher (a rejected IPC bridge call) would reject `refresh()` - and, through `start()`'s await, tear down the whole host runtime with no retry - instead of taking the designed retain-last-known path (T20 / audit P4).
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

  /** The shell's answer WINS over the persisted one whenever it has one. */
  /** Re-attempt the shell seed while this machine's id is still UNKNOWN. */
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
    // THE SEED PATH IS A STATE CHANGE AND HAS TO SAY SO.
    // `snapshot()` reads `lastKnownLocalHostId` to neutralise this machine's registry twin into a `bootingLocalEntry`, so adopting an id here changes what every listener would compute - and this is the one caller of `adoptLocalHostId` with no emit behind it.
    this.emit();
    appLogger.debug("[host-directory] seeded local host id from shell", {
      hostId,
    });
  }

  /**
   * The one place `lastKnownLocalHostId` moves.
   * Migrate holders with the id; only when the previous id is known and matches.
   */
  private adoptLocalHostId(next: string): void {
    const previous = this.lastKnownLocalHostId;
    this.lastKnownLocalHostId = next;
    persistLocalHostId(next);
    if (previous === null || previous === next) {
      return;
    }
    // The Settings viewing scope is a holder too.
    // A pin of this machine's OLD id would keep Settings administering the dead registry twin (and read `vanished` once the twin deregisters).
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
      // While the local host is down/booting the registry twin is the only entry carrying it, and it is remote-kind and relay-dialed.
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

  private emitRefreshState(): void {
    const refreshing = this.isRefreshing();
    for (const listener of this.refreshStateListeners) {
      listener(refreshing);
    }
  }

  /**
   * Poll-path emit: skips the fan-out when the snapshot is value-equal to the last one emitted.
   * Every non-poll mutation (local host change, selection, re-enrollment) still emits unconditionally and refreshes the baseline, so a change landing between two polls can never be swallowed.
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
 * Field-equality check mirroring `useHostDirectoryEntry`'s cache (React hooks land, this class predates React entirely, so the comparison is reimplemented rather than imported across that boundary).
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
    // The DERIVED verdict, not the coarse bit.
    // Same reason as `useHostDirectoryEntry`'s twin: a host moving from `indeterminate` to a confirmed `offline` is not-dialable on both sides, and swallowing that emit would freeze every surface reading the reason at "we don't know".
    hostUnavailability(a) === hostUnavailability(b) &&
    // The recovery-dial window (F7).
    // Computed at projection time from `lastSeenAt` recency, so an `offline` row whose ONLY change is aging past RELAY_FUSE_MAX_ATTACH_MS flips this field and nothing else this comparison reads (the derived verdict stays `offline` on both sides).
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
 * Rewrite this machine's registry twin as a local, not-yet-dialable entry (`websocketUrl: null`, `kind: "local"`).
 * Force `transportDialability` to `not-dialable` so tombstone recovery does not fire at boot against a URL-less entry.
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
 * The local host, read DIRECTLY from the running process rather than from any relay verdict - so the coarse bit is written, not derived.
 * A local snapshot exists only when this machine's host is up and serving, which is the whole evidence needed for "dialable".
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
    // Projected from the shell, never assumed.
    // This is the ONE place a `HostAvailability` becomes a `HostTransportDialability`, and it is the seam that keeps `busy` from ever reading as death downstream: the shell used to drop the whole snapshot the moment a probe failed, so the renderer's only two.
    transportDialability: isHostReachable(snapshot.availability)
      ? "dialable"
      : "not-dialable",
  };
}
