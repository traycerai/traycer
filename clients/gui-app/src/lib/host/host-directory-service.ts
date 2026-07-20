import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { IHostDirectoryService } from "@traycer-clients/shared/host-client/host-runtime";
import {
  fetchRemoteHosts,
  isRemoteHostDirectoryEntry,
  type RemoteHostFetcher,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import type {
  IRunnerHost,
  LocalHostSnapshot,
} from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import { appLogger, describeLogError } from "@/lib/logger";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { lastSelectedHostKey } from "@/lib/persist";

const HOST_DIRECTORY_REFRESH_POLL_MS = 15_000;
const LAST_SELECTED_HOST_STORAGE_KEY = lastSelectedHostKey();

export interface HostDirectoryServiceOptions {
  readonly runnerHost: IRunnerHost;
  /**
   * Fetcher for remote hosts. Defaults to the shared stubbed
   * `fetchRemoteHosts` (returns an empty hosts result) so the composition is
   * the same in production and tests; tests can pass a custom fetcher to
   * assert merged directory behavior.
   */
  readonly remoteFetcher: RemoteHostFetcher | null;
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
 * unbinding an active remote selection (T20 / audit P4).
 *
 * The service never calls any `getLocalHost()` accessor; the current
 * snapshot is the most recent value delivered through the subscription.
 * Subscribing to `onLocalHostChange` fires synchronously with the current
 * snapshot, so `start()` does not need a separate seeding fetch.
 */
export class HostDirectoryService implements IHostDirectoryService {
  private readonly runnerHost: IRunnerHost;
  private readonly remoteFetcher: RemoteHostFetcher;
  private localEntry: HostDirectoryEntry | null = null;
  private remoteEntries: readonly HostDirectoryEntry[] = [];
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
    this.localSubscription = this.runnerHost.onLocalHostChange((snapshot) => {
      this.localEntry = toLocalEntry(snapshot);
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

  getLocalEntry(): HostDirectoryEntry | null {
    return this.localEntry;
  }

  /**
   * Resolves the host that should auto-bind when no explicit selection has
   * been made yet.
   *
   * Rules:
   *   - If a local-kind entry exists (desktop path), prefer it.
   *   - Else, if the merged directory has exactly one entry, return it.
   *   - Else, return `null` - the zero/many mobile paths require an
   *     explicit user gesture before binding.
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
   * `<MobileHostGate />` consumes this to decide whether to render the
   * no-host guidance state, let auto-bind proceed, or programmatically
   * open the mounted `<HostPicker />`. Consumers can alternatively
   * compute it from `list()`; this helper just centralises the mapping.
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
    const outcome = await this.remoteFetcher();
    if (outcome.kind === "failed") {
      appLogger.debug(
        "[host-directory] refresh failed, retaining last-known remote entries",
        { remoteCount: this.remoteEntries.length },
      );
      return this.snapshot();
    }
    this.remoteEntries = outcome.kind === "hosts" ? outcome.entries : [];
    if (outcome.kind === "hosts") {
      this.consumeUnboundFollowUpRestore(outcome.entries);
    }
    this.reconcileSelection();
    this.emit();
    appLogger.debug("[host-directory] refresh complete", {
      outcome: outcome.kind,
      localCount: this.localEntry === null ? 0 : 1,
      remoteCount: this.remoteEntries.length,
      totalCount: this.snapshot().length,
    });
    return this.snapshot();
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
      entries.push(entry);
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
      if (fresh === null) {
        this.setSelected(null);
        return;
      }
      if (!hostDirectoryEntriesEqual(fresh, this.selected)) {
        this.selected = fresh;
        appLogger.debug("[host-directory] effective host selection refreshed", {
          hostId: fresh.hostId,
          kind: fresh.kind,
          hasWebsocketUrl: fresh.websocketUrl !== null,
        });
        for (const handler of this.selectionListeners) {
          handler(fresh);
        }
      }
      return;
    }
    if (this.startupRestoreHostId !== null) {
      return;
    }
    if (this.explicitSelection !== null) {
      if (this.explicitSelection.hostId === null) {
        return;
      }
      const explicitEntry = this.findById(this.explicitSelection.hostId);
      if (explicitEntry !== null) {
        this.setSelected(explicitEntry);
      }
      return;
    }
    const defaultEntry = this.getDefaultEntry();
    if (defaultEntry !== null) {
      this.unboundFollowUpRestoreHostId = null;
      this.setSelected(defaultEntry);
    }
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot, this.localEntry);
    }
  }
}

interface ExplicitHostSelection {
  readonly hostId: string | null;
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
