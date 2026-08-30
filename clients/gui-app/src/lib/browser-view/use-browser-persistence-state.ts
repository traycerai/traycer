import { useCallback, useMemo, useSyncExternalStore } from "react";
import type {
  BrowserPersistenceState,
  BrowserViewBridge,
} from "@traycer-clients/shared/platform/browser-view";
import { refreshBrowserSessionsPersistenceState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import {
  browserPersistenceEnableResult,
  trackBrowserPersistence,
  type BrowserPersistenceSurface,
} from "@/lib/browser-view/browser-persistence-analytics";

/**
 * The renderer's single reader of desktop browser-login persistence (keychain
 * refactor ticket 02). Every tile shares ONE store per bridge: the state is a
 * statement about the machine, not about a tile, so N open tiles must never
 * mean N reads, N subscriptions, or - worst - N different answers on screen.
 *
 * The desktop pushes `onPersistenceStateChanged` after every decision, which
 * is also what tells the host-facing coordinator to re-report (ticket 03).
 */

export interface BrowserPersistenceSnapshot {
  /** Null until the first read settles, and on a bridge that predates this. */
  readonly state: BrowserPersistenceState | null;
  /** An enable / decline / relaunch call is in flight. */
  readonly pending: boolean;
}

export interface BrowserPersistenceController extends BrowserPersistenceSnapshot {
  /**
   * Runs the keystore probe. THIS is what raises the OS dialog.
   *
   * `source` is required, and is the surface the gesture came from: the card
   * passes `"card"`, the tile shield `"shield"`, and Settings ▸ Browser
   * `"settings"` (ticket 10). The outcome event is emitted HERE rather
   * than at each call site so all three surfaces report the same funnel with
   * the same duration; a new surface only has to name itself.
   */
  readonly enable: (source: BrowserPersistenceSurface) => void;
  readonly decline: () => void;
  readonly relaunch: (source: BrowserPersistenceSurface) => void;
}

const EMPTY_SNAPSHOT: BrowserPersistenceSnapshot = {
  state: null,
  pending: false,
};

const NO_OP_CONTROLLER: BrowserPersistenceController = {
  ...EMPTY_SNAPSHOT,
  enable: () => undefined,
  decline: () => undefined,
  relaunch: () => undefined,
};

class BrowserPersistenceStore {
  private readonly bridge: BrowserViewBridge;
  private readonly listeners = new Set<() => void>();
  private snapshot: BrowserPersistenceSnapshot = EMPTY_SNAPSHOT;
  private subscription: { dispose: () => void } | null = null;
  private inFlight = 0;

  constructor(bridge: BrowserViewBridge) {
    this.bridge = bridge;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.subscription === null) this.attach();
    return () => {
      this.listeners.delete(listener);
      // The store outlives its last subscriber (it is keyed by bridge, and a
      // remount is common), but its push subscription must not: an orphaned
      // main-process listener would keep waking a window with no reader.
      if (this.listeners.size > 0) return;
      this.subscription?.dispose();
      this.subscription = null;
    };
  }

  getSnapshot(): BrowserPersistenceSnapshot {
    return this.snapshot;
  }

  enable(source: BrowserPersistenceSurface): void {
    const startedAt = Date.now();
    this.run(
      () => this.bridge.enablePersistence(),
      (state) => {
        trackBrowserPersistence({
          name: "browser_persistence_enable_result",
          result: browserPersistenceEnableResult(state),
          durationMs: Date.now() - startedAt,
          source,
        });
      },
    );
  }

  decline(): void {
    this.run(
      () => this.bridge.declinePersistence(),
      () => undefined,
    );
  }

  relaunch(source: BrowserPersistenceSurface): void {
    // The desktop exits inside this call, so the click IS the event: there is
    // no outcome to settle here, and a result emitted after the exit would
    // never leave the renderer.
    trackBrowserPersistence({
      name: "browser_persistence_relaunch_clicked",
      source,
    });
    // Only a pending flag is applied, so the button cannot be pressed twice on
    // the way out.
    this.run(
      () =>
        this.bridge.relaunchForPersistence().then(() => this.snapshot.state),
      () => undefined,
    );
  }

  private attach(): void {
    this.subscription = this.bridge.onPersistenceStateChanged((state) => {
      this.apply(state);
    });
    // Wrapped so a bridge older than this channel rejects rather than throwing
    // synchronously into the component that mounted the tile.
    void Promise.resolve()
      .then(() => this.bridge.getPersistenceState())
      .then((state) => {
        this.apply(state);
      })
      .catch(() => {
        this.publish({ state: null, pending: this.inFlight > 0 });
      });
  }

  /**
   * `onSettled` runs exactly once per call - with the state the action
   * resolved with, or `null` when it resolved with nothing or rejected. It is
   * what keeps a funnel event tied to one gesture instead of to the store's
   * shared state, which any other window's push can also move.
   */
  private run(
    action: () => Promise<BrowserPersistenceState | null>,
    onSettled: (state: BrowserPersistenceState | null) => void,
  ): void {
    this.inFlight += 1;
    this.publish({ state: this.snapshot.state, pending: true });
    void action()
      .then((state) => {
        this.inFlight -= 1;
        onSettled(state);
        if (state === null) {
          this.publish({ state: this.snapshot.state, pending: this.busy() });
          return;
        }
        this.apply(state);
      })
      .catch(() => {
        this.inFlight -= 1;
        onSettled(null);
        this.publish({ state: this.snapshot.state, pending: this.busy() });
      });
  }

  private apply(state: BrowserPersistenceState): void {
    this.publish({ state, pending: this.busy() });
    // The host is told separately (ticket 03's `persistenceStateChanged`
    // frame); a decision the agent cannot see is a seed notice that lies.
    refreshBrowserSessionsPersistenceState();
  }

  private busy(): boolean {
    return this.inFlight > 0;
  }

  private publish(snapshot: BrowserPersistenceSnapshot): void {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => {
      listener();
    });
  }
}

const storesByBridge = new WeakMap<
  BrowserViewBridge,
  BrowserPersistenceStore
>();

function storeForBridge(bridge: BrowserViewBridge): BrowserPersistenceStore {
  const existing = storesByBridge.get(bridge);
  if (existing !== undefined) return existing;
  const store = new BrowserPersistenceStore(bridge);
  storesByBridge.set(bridge, store);
  return store;
}

export function useBrowserPersistenceState(
  browserView: BrowserViewBridge | null,
): BrowserPersistenceController {
  const store = browserView === null ? null : storeForBridge(browserView);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (store === null) return () => undefined;
      return store.subscribe(listener);
    },
    [store],
  );
  const getSnapshot = useCallback(
    () => (store === null ? EMPTY_SNAPSHOT : store.getSnapshot()),
    [store],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => {
    if (store === null) return NO_OP_CONTROLLER;
    return {
      state: snapshot.state,
      pending: snapshot.pending,
      enable: (source: BrowserPersistenceSurface) => {
        store.enable(source);
      },
      decline: () => {
        store.decline();
      },
      relaunch: (source: BrowserPersistenceSurface) => {
        store.relaunch(source);
      },
    };
  }, [snapshot, store]);
}
