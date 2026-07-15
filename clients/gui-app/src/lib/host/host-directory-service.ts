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
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

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
      if (fresh === null) {
        this.setSelected(null);
        return;
      }
      if (fresh !== this.selected) {
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
