import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { IHostDirectoryService } from "@traycer-clients/shared/host-client/host-runtime";
import {
  fetchRemoteHosts,
  type RemoteHostFetcher,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import type {
  IRunnerHost,
  LocalHostSnapshot,
} from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import { appLogger } from "@/lib/logger";
import {
  Analytics,
  AnalyticsEvent,
  type AnalyticsSource,
} from "@/lib/analytics";

export interface HostDirectoryServiceOptions {
  readonly runnerHost: IRunnerHost;
  /**
   * Fetcher for remote hosts. Defaults to the shared stubbed
   * `fetchRemoteHosts` (returns an empty list) so the composition is the
   * same in production and tests; tests can pass a custom fetcher to assert
   * merged directory behavior.
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
 * to `onSelectionChange(...)` to rebind `HostClient`.
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
  private readonly listeners = new Set<HostDirectoryListener>();
  private readonly selectionListeners = new Set<
    (entry: HostDirectoryEntry | null) => void
  >();
  private localSubscription: Disposable | null = null;
  private started = false;

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
  }

  list(): Promise<readonly HostDirectoryEntry[]> {
    return Promise.resolve(this.snapshot());
  }

  async refresh(): Promise<readonly HostDirectoryEntry[]> {
    this.remoteEntries = await this.remoteFetcher();
    this.reconcileSelection();
    this.emit();
    appLogger.debug("[host-directory] refresh complete", {
      localCount: this.localEntry === null ? 0 : 1,
      remoteCount: this.remoteEntries.length,
      totalCount: this.snapshot().length,
    });
    return this.snapshot();
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
    return this.getDefaultEntry();
  }

  selectById(hostId: string | null): void {
    appLogger.debug("[host-directory] explicit host selection requested", {
      hostId,
      clearingSelection: hostId === null,
    });
    this.explicitSelection = { hostId };
    if (hostId === null) {
      this.setSelected(null);
      return;
    }
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
    this.listeners.clear();
    this.selectionListeners.clear();
    this.started = false;
  }

  private snapshot(): readonly HostDirectoryEntry[] {
    const entries: HostDirectoryEntry[] = [];
    if (this.localEntry !== null) {
      entries.push(this.localEntry);
    }
    for (const entry of this.remoteEntries) {
      entries.push(entry);
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

  private reconcileSelection(): void {
    if (this.selected !== null) {
      const fresh = this.findById(this.selected.hostId);
      if (fresh !== null) {
        if (fresh !== this.selected) {
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
    this.setSelected(this.selectionFromIntent());
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
    for (const listener of this.listeners) {
      listener(snapshot, this.localEntry);
    }
  }
}

interface ExplicitHostSelection {
  readonly hostId: string | null;
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
