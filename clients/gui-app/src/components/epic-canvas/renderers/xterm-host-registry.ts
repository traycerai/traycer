import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type {
  ISearchResultChangeEvent,
  SearchAddon,
} from "@xterm/addon-search";
import type { CanvasAddon } from "@xterm/addon-canvas";
import type { TerminalDataWriter } from "@/stores/terminals/terminal-session-store";
import { getTerminalSessionRegistry } from "@/lib/registries/terminal-session-registry";
import type { LinkClickEvent } from "@/lib/links/open-link";
import type { TerminalWarmSessionIdentity } from "@/stores/terminals/terminal-session-registry";

export type { TerminalWarmSessionIdentity };

/**
 * Each mounting host points these at its own current callback refs, so a reparented host keeps driving the same long-lived `Terminal` without recreating it.
 */
export interface XtermHostLiveCallbacks {
  onUserInput: (data: string) => void;
  onContainerResize: (cols: number, rows: number) => void;
  openLink: (uri: string, event: LinkClickEvent | null) => void;
  getFindTargetId: () => string | null;
  onSearchResults: (result: ISearchResultChangeEvent) => void;
}

/**
 * Imperative size controls the long-lived engine exposes so the mounting host's appearance / visibility effects drive resizes through the engine's guarded, host-reporting path instead of calling `fitAddon.fit()` directly.
 * A raw `fit()` resizes only the local grid - it skips the 0x0 / collapsed-box guard, never updates the engine's last-sent dedupe, and never tells the host - so it can silently desync the local grid from the shared effective size and leave the dedupe unable to repair it.
 */
export interface XtermHostControls {
  /**
   * Use {@link reconcileWithHost} to repair a stale shared grid the box-unchanged dedupe would otherwise pin.
   */
  readonly fitToContainer: () => void;
  /**
   * Recovery: when the host's authoritative grid (`hostCols`/`hostRows`) disagrees with what this healthy container would naturally propose, re-report the container's natural size so a stale/degenerate shared grid can't pin the terminal small forever.
   */
  readonly reconcileWithHost: (hostCols: number, hostRows: number) => void;
}

/**
 * The container is detached from the DOM on host unmount and re-`appendChild`-ed by the next host - never disposed on a layout change - so scrollback survives.
 * Two tab instances of the same host session hold two separate engines, each driven by its own stream client, so `sessionId` here is only retained for perf-mark correlation, not as the cache key.
 */
export interface XtermHostEntry {
  readonly sessionId: string;
  /** Bound owner host. `null` is the explicit hostless/non-terminal path. */
  readonly hostId: string | null;
  readonly containerEl: HTMLDivElement;
  readonly term: Terminal;
  readonly fitAddon: FitAddon;
  readonly searchAddon: SearchAddon;
  /**
   * There is no `canvasAddon` field: the addon comes and goes with presentation, so a reader must ask `rendererController.currentCanvas()` at use time.
   */
  readonly rendererController: XtermRendererController;
  readonly writerProxy: TerminalDataWriter;
  /** Mutated by the mounting host each mount to reach its current refs. */
  readonly live: XtermHostLiveCallbacks;
  /** Guarded, host-reporting size controls (see {@link XtermHostControls}). */
  readonly controls: XtermHostControls;
  /** Disconnects the observer, disposes addons + disposables, and (after a
   * macrotask, so xterm's startup Viewport timer drains) the `Terminal`. */
  readonly disposeEngine: () => void;
}

// Keyed by per-tab `instanceId`, not `sessionId`: two tab instances of the same host session each own their own engine + container, so both can render live at once.
const entries = new Map<string, XtermHostEntry>();

// The measure-before-subscribe probe mounts the engine BEFORE its session handle enters the session registry, so the follower can no longer treat registry membership as the only liveness signal - a mounted engine must never be reaped out from under its host.
const mountCounts = new Map<string, number>();

function isMounted(instanceId: string): boolean {
  return (mountCounts.get(instanceId) ?? 0) > 0;
}

// Deferred-disposal timers for plain-terminal engines, keyed by `instanceId`.
// React StrictMode (dev) and fast reparents mount → unmount → remount the host synchronously.
const pendingDisposals = new Map<string, number>();
const PLAIN_TERMINAL_DISPOSE_DELAY_MS = 0;

/**
 * How long an engine may sit with zero presented mounts before its accelerated canvases are disposed.
 * Long enough to survive a tab switch, a pane split, the StrictMode double mount and the reparent flows this registry already defers ENGINE disposal for; short enough that the GPU memory is gone before a user notices.
 */
export const XTERM_CANVAS_DISPOSE_DELAY_MS = 5_000;

/**
 * The imperative side of the renderer controller, supplied by the engine
 * factory (`createXtermEntry`) because only it holds the `Terminal`.
 */
export interface XtermRendererControllerHooks {
  /**
   * The controller LATCHES a `null`: xterm has fallen back to its DOM renderer for good and a later presentation must not retry the construction on every show.
   * The implementation owes a best-effort rollback before it returns `null`, because `loadAddon` is NOT transactional (see the call site).
   */
  readonly loadCanvasAddon: () => CanvasAddon | null;
  /**
   * Mark every row dirty (`term.refresh(0, rows - 1)`) so the freshly installed renderer paints the whole grid instead of waiting for the next write.
   * Called only after {@link loadCanvasAddon} returned an addon.
   */
  readonly refreshAllRows: () => void;
}

/**
 * So the addon exists only while the engine is PRESENTED: mounted into a tile body that is itself visible (`useTileBodyVisible()`).
 */
export interface XtermRendererController {
  /**
   * Call it from a `useLayoutEffect` AFTER the engine's container is attached, so the restore lands before the next paint.
   */
  readonly present: () => void;
  /** Drop one presented mount; the last one out arms the disposal grace. */
  readonly unpresent: () => void;
  /**
   * Read it at USE time - the atlas clear must reach whichever addon is live now, not whichever one was live when a ref was last written.
   * `null` means only that this controller owns no addon; see {@link XtermRendererControllerHooks.loadCanvasAddon} for the one failure mode where that is not the same as "no accelerated renderer exists".
   */
  readonly currentCanvas: () => CanvasAddon | null;
  /**
   * Whether the renderer currently installed on the terminal is the one this engine SETTLES on - and therefore whether a grid measured right now may be reported to the host. xterm's two renderers do not measure the same cell.
   * False only in between: unpresented with the grace expired, or before the first presentation of an engine that could still get a canvas.
   */
  readonly isRendererSettled: () => boolean;
  /**
   * Teardown, owned by the engine's own `disposeEngine`.
   * Cancels a pending grace timer and disposes any live addon; every later `present()` / `unpresent()` / timer callback becomes a no-op.
   */
  readonly dispose: () => void;
}

export function createXtermRendererController(
  hooks: XtermRendererControllerHooks,
): XtermRendererController {
  let presentedMounts = 0;
  let canvas: CanvasAddon | null = null;
  let disposeTimer: number | null = null;
  // Latched by a `loadCanvasAddon` that returned null: the environment has no canvas renderer, so the engine is DOM-rendered for life and no presentation retries the construction.
  let canvasUnavailable = false;
  let disposed = false;

  const cancelDisposeTimer = (): void => {
    if (disposeTimer === null) return;
    clearTimeout(disposeTimer);
    disposeTimer = null;
  };

  const disposeCanvasNow = (): void => {
    if (canvas === null) return;
    const live = canvas;
    canvas = null;
    // DEFERRED (the plan's second tier): that DOM renderer is LIVE, not idle. xterm pauses rendering on IntersectionObserver geometry only, and a retained terminal keeps its box under `visibility:hidden`, so a hidden session that is still streaming keeps running `DomRenderer.renderRows` and rebuilding each dirty row's spans.
    live.dispose();
  };

  const present = (): void => {
    if (disposed) return;
    cancelDisposeTimer();
    presentedMounts += 1;
    if (canvas !== null) return;
    if (canvasUnavailable) return;
    const loaded = hooks.loadCanvasAddon();
    if (loaded === null) {
      canvasUnavailable = true;
      return;
    }
    canvas = loaded;
    // Order is load-then-refresh: the render service installs the canvas renderer during `loadAddon`, and only a full refresh after that paints the existing buffer into it.
    hooks.refreshAllRows();
  };

  const unpresent = (): void => {
    if (disposed) return;
    // Every `unpresent` must balance a `present`, and production keeps that true: a never-presented host is skipped by the presentation effect and passes `false` to `releaseXtermHost`.
    // It cannot protect a peer whose count is one; that is what the count itself is for.
    if (presentedMounts === 0) return;
    presentedMounts -= 1;
    if (presentedMounts > 0) return;
    if (canvas === null) return;
    // No timer can be armed here: one is armed only on a zero-crossing, and
    // getting back above zero goes through `present`, which cancels it.
    disposeTimer = window.setTimeout(() => {
      disposeTimer = null;
      if (disposed) return;
      if (presentedMounts > 0) return;
      disposeCanvasNow();
    }, XTERM_CANVAS_DISPOSE_DELAY_MS);
  };

  return {
    present,
    unpresent,
    currentCanvas: () => canvas,
    isRendererSettled: () => canvas !== null || canvasUnavailable,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelDisposeTimer();
      presentedMounts = 0;
      disposeCanvasNow();
    },
  };
}

let followerInstalled = false;

/** Only exited sessions release their engine eagerly. */
function installFollowerOnce(): void {
  if (followerInstalled) return;
  followerInstalled = true;
  getTerminalSessionRegistry().subscribe(() => {
    if (entries.size === 0) return;
    const liveInstanceIds = new Set(
      getTerminalSessionRegistry().listInstanceIds(),
    );
    for (const [instanceId, entry] of Array.from(entries)) {
      if (liveInstanceIds.has(instanceId)) continue;
      // A mounted engine is alive by definition even before its session handle registers (the pre-subscribe measurement probe); its own release decides its fate once it unmounts.
      if (isMounted(instanceId)) continue;
      cancelPendingDisposal(instanceId);
      entries.delete(instanceId);
      entry.disposeEngine();
    }
  });
}

/**
 * A reparented or reopened host hits the cache and re-attaches the existing `Terminal` instead of constructing a fresh one.
 */
export function acquireXtermHost(
  instanceId: string,
  create: () => XtermHostEntry,
): XtermHostEntry {
  installFollowerOnce();
  // Cancel a pending plain-terminal disposal: a synchronous remount (StrictMode
  // / reparent) reclaims the same engine instead of losing its buffer.
  cancelPendingDisposal(instanceId);
  mountCounts.set(instanceId, (mountCounts.get(instanceId) ?? 0) + 1);
  const existing = entries.get(instanceId);
  if (existing !== undefined) return existing;
  const entry = create();
  entries.set(instanceId, entry);
  return entry;
}

/**
 * Dropping it here settles the engine's renderer count in the same call that settles its mount count, so a departing host can never strand one: React destroys effect cleanups in DECLARATION order, so a host's acquire-effect cleanup (this call) runs BEFORE its presentation effect's cleanup.
 */
export function releaseXtermHost(
  instanceId: string,
  keepAlive: boolean,
  presented: boolean,
): void {
  if (presented) {
    entries.get(instanceId)?.rendererController.unpresent();
  }
  const mounts = mountCounts.get(instanceId) ?? 0;
  if (mounts > 1) {
    // Another host still renders this engine (StrictMode overlap, a
    // mid-reparent double mount): never schedule disposal under it.
    mountCounts.set(instanceId, mounts - 1);
    return;
  }
  mountCounts.delete(instanceId);
  if (keepAlive) {
    // Kept for the live session - unless the instance never registered a session handle at all (a measurement probe whose tab closed before the subscribe was dispatched).
    // Nothing would ever evict that orphan (the follower only runs on registry changes), so give it the same deferred disposal a plain terminal gets; a synchronous remount re-acquires and cancels it.
    if (getTerminalSessionRegistry().get(instanceId) !== null) return;
    scheduleDeferredDisposal(instanceId);
    return;
  }
  if (!entries.has(instanceId)) return;
  scheduleDeferredDisposal(instanceId);
}

function scheduleDeferredDisposal(instanceId: string): void {
  if (!entries.has(instanceId)) return;
  // Already scheduled (double release without an intervening acquire): keep the
  // existing timer rather than stacking another.
  if (pendingDisposals.has(instanceId)) return;
  const timer = window.setTimeout(() => {
    pendingDisposals.delete(instanceId);
    const entry = entries.get(instanceId);
    if (entry === undefined) return;
    entries.delete(instanceId);
    entry.disposeEngine();
  }, PLAIN_TERMINAL_DISPOSE_DELAY_MS);
  pendingDisposals.set(instanceId, timer);
}

function cancelPendingDisposal(instanceId: string): void {
  const timer = pendingDisposals.get(instanceId);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingDisposals.delete(instanceId);
}

/**
 * Move a cached engine to a new tab instance id, following a session-handle adoption (`TerminalSessionRegistry.rekeyLeaseFreeEntry`): a reopened tab mints a fresh instance id, and adopting the closed tab's warm handle under it must carry the engine along - the handle's store still streams into this engine's writer, and the reopened tile's mount reattaches it with scrollback intact.
 * MUST run BEFORE the session-registry rekey: that rekey notifies the engine follower, which disposes any engine whose instance id is no longer a session-registry member.
 */
export function rekeyXtermHost(
  oldInstanceId: string,
  newInstanceId: string,
): boolean {
  const entry = entries.get(oldInstanceId);
  // No engine to move: trivially consistent - the caller may proceed with
  // the session-handle rekey (the engine never existed or was disposed).
  if (entry === undefined) return true;
  // Refuse; the caller must not split the handle from its engine.
  if (isMounted(oldInstanceId)) return false;
  if (entries.has(newInstanceId)) return false;
  cancelPendingDisposal(oldInstanceId);
  entries.delete(oldInstanceId);
  entries.set(newInstanceId, entry);
  return true;
}

/**
 * Closing a terminal tab keeps a running session's handle - and its live `terminal.subscribe` stream - warm precisely so reopening reattaches instantly, but a reopened tab mints a NEW instance id, so without adoption the warm handle was unreachable forever: the reopen built a SECOND subscription while the old one lingered as a zombie host-side subscriber.
 * Adoption only touches lease-free entries, so a still-open second view of the session (split) is never stolen.
 */
export function adoptWarmSessionInstance(
  identity: TerminalWarmSessionIdentity,
  instanceId: string,
): void {
  const registry = getTerminalSessionRegistry();
  const oldInstanceId = registry.findAdoptableInstanceId(identity, instanceId);
  if (oldInstanceId === null) return;
  // The handle may only move together with its engine - the warm store's writer streams into that engine, so rekeying the handle after a refused engine move (source still mounted, or the target id already has an engine) would split the pair and orphan the scrollback.
  if (!rekeyXtermHost(oldInstanceId, instanceId)) return;
  registry.rekeyLeaseFreeEntry(oldInstanceId, instanceId);
}

/**
 * The bootstrap uses this to seed `terminal.create` / `terminal.subscribe` with the engine's real grid on a revive-in-place (idle reap, binding restart) instead of the 80x24 bootstrap defaults - the host's smaller-pane-wins `min()` takes the subscriber's opening size seriously, so seeding the defaults forced every revive through a shrink-to-80x24-then-grow cycle (and latched there when the grow-back re-report was missed).
 */
export function peekXtermHostGrid(
  instanceId: string,
): { readonly cols: number; readonly rows: number } | null {
  const entry = entries.get(instanceId);
  if (entry === undefined) return null;
  return { cols: entry.term.cols, rows: entry.term.rows };
}

/**
 * Seeding the reopen's `terminal.create`/`subscribe` from it keeps the live PTY from being dragged through the 80x24 defaults (the shrink-then-grow whose stale cells the CLI's inline renderer never repaints away).
 * Lookup is `(hostId, sessionId)` so a same-id engine on another host cannot seed this subscribe.
 */
export function peekXtermHostGridForSession(
  identity: TerminalWarmSessionIdentity,
): { readonly cols: number; readonly rows: number } | null {
  for (const entry of entries.values()) {
    if (
      entry.sessionId === identity.sessionId &&
      entry.hostId === identity.hostId
    ) {
      return { cols: entry.term.cols, rows: entry.term.rows };
    }
  }
  return null;
}

/**
 * Reconcile a mounted terminal after an outer layout transition finishes.
 * The landing terminal panel expands from zero width while its xterm engine stays mounted.
 */
export function reconcileXtermHostAfterLayoutTransition(
  instanceId: string,
): void {
  const entry = entries.get(instanceId);
  if (entry === undefined) return;
  entry.controls.reconcileWithHost(entry.term.cols, entry.term.rows);
}

/**
 * Identified by container element (stable from engine construction) rather than the entry object, which does not exist yet while the engine's closures are being built.
 */
export function hasPeerXtermHostForSession(
  identity: TerminalWarmSessionIdentity,
  selfContainerEl: HTMLElement,
): boolean {
  for (const entry of entries.values()) {
    if (entry.containerEl === selfContainerEl) continue;
    if (
      entry.sessionId === identity.sessionId &&
      entry.hostId === identity.hostId
    ) {
      return true;
    }
  }
  return false;
}

export function __disposeAllXtermHostsForTests(): void {
  for (const timer of pendingDisposals.values()) {
    clearTimeout(timer);
  }
  pendingDisposals.clear();
  for (const entry of entries.values()) {
    entry.disposeEngine();
  }
  entries.clear();
  mountCounts.clear();
}

export function __getXtermHostEntryForTests(
  instanceId: string,
): XtermHostEntry | null {
  return entries.get(instanceId) ?? null;
}
