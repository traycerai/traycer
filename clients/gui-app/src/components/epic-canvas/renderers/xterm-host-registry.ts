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
 * Per-mount callbacks the live xterm engine reaches through. The engine is
 * built once per session and outlives any single `TerminalXtermHost` React
 * instance (it survives pane splits, tab switches, and reopen). Each mounting
 * host points these at its own current callback refs, so a reparented host
 * keeps driving the same long-lived `Terminal` without recreating it.
 */
export interface XtermHostLiveCallbacks {
  onUserInput: (data: string) => void;
  onContainerResize: (cols: number, rows: number) => void;
  openLink: (uri: string, event: LinkClickEvent | null) => void;
  getFindTargetId: () => string | null;
  onSearchResults: (result: ISearchResultChangeEvent) => void;
}

/**
 * Imperative size controls the long-lived engine exposes so the mounting host's
 * appearance / visibility effects drive resizes through the engine's guarded,
 * host-reporting path instead of calling `fitAddon.fit()` directly. A raw
 * `fit()` resizes only the local grid - it skips the 0x0 / collapsed-box guard,
 * never updates the engine's last-sent dedupe, and never tells the host - so it
 * can silently desync the local grid from the shared effective size and leave
 * the dedupe unable to repair it.
 */
export interface XtermHostControls {
  /**
   * Fit the local grid to the container and report it to the host, deduped
   * against the last size this engine reported. Use {@link reconcileWithHost}
   * to repair a stale shared grid the box-unchanged dedupe would otherwise pin.
   */
  readonly fitToContainer: () => void;
  /**
   * Recovery: when the host's authoritative grid (`hostCols`/`hostRows`)
   * disagrees with what this healthy container would naturally propose,
   * re-report the container's natural size so a stale/degenerate shared grid
   * can't pin the terminal small forever. When the container is unmeasurable
   * at call time (hidden pane, collapsed box) the reconcile is deferred and
   * completed by the next successful {@link fitToContainer} measurement.
   */
  readonly reconcileWithHost: (hostCols: number, hostRows: number) => void;
}

/**
 * The long-lived xterm engine for one terminal tab instance: the `Terminal`,
 * its addons, the persistent container element it was `open()`-ed into, and the
 * `term.write` proxy the session store streams host frames through. The
 * container is detached from the DOM on host unmount and re-`appendChild`-ed by
 * the next host - never disposed on a layout change - so scrollback survives.
 *
 * Each engine belongs to one tab instance. Two tab instances of the same host
 * session hold two separate engines, each driven by its own stream client, so
 * `sessionId` here is only retained for perf-mark correlation, not as the cache
 * key.
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
   * The one owner of this engine's accelerated canvases (see
   * {@link XtermRendererController}). There is no `canvasAddon` field: the
   * addon comes and goes with presentation, so a reader must ask
   * `rendererController.currentCanvas()` at use time.
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

// Keyed by per-tab `instanceId`, not `sessionId`: two tab instances of the same
// host session each own their own engine + container, so both can render live
// at once.
const entries = new Map<string, XtermHostEntry>();

// Live mount count per instanceId. The measure-before-subscribe probe mounts
// the engine BEFORE its session handle enters the session registry, so the
// follower can no longer treat registry membership as the only liveness
// signal - a mounted engine must never be reaped out from under its host.
const mountCounts = new Map<string, number>();

function isMounted(instanceId: string): boolean {
  return (mountCounts.get(instanceId) ?? 0) > 0;
}

// Deferred-disposal timers for plain-terminal engines, keyed by `instanceId`.
// React StrictMode (dev) and fast reparents mount → unmount → remount the host
// synchronously. Disposing the engine eagerly on the unmount throws away the
// terminal that already consumed the one-shot host snapshot, and the remount
// builds a blank engine (the snapshot is gone from the store's pending queue).
// Deferring the dispose by a macrotask lets the synchronous remount re-acquire
// the SAME engine - scrollback, cursor, and the rendered snapshot intact - and
// cancel the pending dispose. A genuine close has no remount, so the timer
// fires and the engine is disposed.
const pendingDisposals = new Map<string, number>();
const PLAIN_TERMINAL_DISPOSE_DELAY_MS = 0;

/**
 * How long an engine may sit with zero presented mounts before its accelerated
 * canvases are disposed. Long enough to survive a tab switch, a pane split, the
 * StrictMode double mount and the reparent flows this registry already defers
 * ENGINE disposal for; short enough that the GPU memory is gone before a user
 * notices. A tunable starting value - it lives beside
 * {@link PLAIN_TERMINAL_DISPOSE_DELAY_MS} because it is the same kind of knob:
 * a grace on a teardown that a fast remount is expected to cancel.
 */
export const XTERM_CANVAS_DISPOSE_DELAY_MS = 5_000;

/**
 * The imperative side of the renderer controller, supplied by the engine
 * factory (`createXtermEntry`) because only it holds the `Terminal`.
 */
export interface XtermRendererControllerHooks {
  /**
   * Construct a `CanvasAddon` and `loadAddon` it onto the already-`open()`-ed
   * terminal, returning the live addon - or `null` when the canvas renderer is
   * unavailable in this environment (headless, blocked). The controller
   * LATCHES a `null`: xterm has fallen back to its DOM renderer for good and a
   * later presentation must not retry the construction on every show.
   */
  readonly loadCanvasAddon: () => CanvasAddon | null;
  /**
   * Mark every row dirty (`term.refresh(0, rows - 1)`) so the freshly installed
   * renderer paints the whole grid instead of waiting for the next write.
   * Called only after {@link loadCanvasAddon} returned an addon.
   */
  readonly refreshAllRows: () => void;
}

/**
 * The single owner of every `CanvasAddon` lifetime decision for one engine.
 *
 * Accelerated canvases cost real GPU memory (four full-size backing surfaces
 * per terminal), and a kept-alive engine holds them whether or not anything is
 * on screen. So the addon exists only while the engine is PRESENTED: mounted
 * into a tile body that is itself visible (`useTileBodyVisible()`). Presentation
 * is a COUNT, not a flag, mirroring this registry's own `mountCounts` - the
 * StrictMode double mount and the mid-reparent overlap it already supports put
 * two presented hosts on one engine, and neither may flip the renderer.
 *
 * An engine whose count reaches zero keeps its canvases for
 * {@link XTERM_CANVAS_DISPOSE_DELAY_MS} and then drops them; the next
 * `present()` loads a fresh addon and repaints. Everything else about the
 * engine - the `Terminal`, its buffer and scrollback, the fit/search addons,
 * the detached container - is untouched by either transition.
 */
export interface XtermRendererController {
  /**
   * Register one presented mount. Cancels a pending canvas disposal and, when
   * the engine currently has no canvas, loads one and repaints. Call it from a
   * `useLayoutEffect` AFTER the engine's container is attached, so the restore
   * lands before the next paint.
   */
  readonly present: () => void;
  /** Drop one presented mount; the last one out arms the disposal grace. */
  readonly unpresent: () => void;
  /**
   * The live addon, or `null` while the engine is unpresented (or permanently
   * DOM-rendered). Read it at USE time - the atlas clear must reach whichever
   * addon is live now, not whichever one was live when a ref was last written.
   */
  readonly currentCanvas: () => CanvasAddon | null;
  /**
   * Teardown, owned by the engine's own `disposeEngine`. Cancels a pending
   * grace timer and disposes any live addon; every later `present()` /
   * `unpresent()` / timer callback becomes a no-op.
   */
  readonly dispose: () => void;
}

export function createXtermRendererController(
  hooks: XtermRendererControllerHooks,
): XtermRendererController {
  let presentedMounts = 0;
  let canvas: CanvasAddon | null = null;
  let disposeTimer: number | null = null;
  // Latched by a `loadCanvasAddon` that returned null: the environment has no
  // canvas renderer, so the engine is DOM-rendered for life and no presentation
  // retries the construction.
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
    // Disposing the addon hands the render service back to xterm's default DOM
    // renderer and removes the addon's `<canvas>` layers from the container,
    // which is what actually releases their backing surfaces.
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
    // Order is load-then-refresh: the render service installs the canvas
    // renderer during `loadAddon`, and only a full refresh after that paints
    // the existing buffer into it.
    hooks.refreshAllRows();
  };

  const unpresent = (): void => {
    if (disposed) return;
    // A host that never presented (born hidden) unpresents on unmount anyway;
    // it must not push the count below zero and strand a presented peer.
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

/**
 * Evict any kept-alive engine whose tab instance has left the
 * `TerminalSessionRegistry`. Live sessions keep their engine cached across
 * unmount (`releaseXtermHost(..., true)`) - terminal-agents for as long as the
 * agent runs, plain terminals for the registry's release-linger window - so
 * the engine's true owner is the session handle, and this follower is what
 * finally disposes the engine when the registry evicts that handle (agent
 * exit, linger expiry, or a forced release). Only exited sessions release
 * their engine eagerly. The registry keys handles by `instanceId` too, so the
 * membership sets line up.
 */
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
      // A mounted engine is alive by definition even before its session
      // handle registers (the pre-subscribe measurement probe); its own
      // release decides its fate once it unmounts.
      if (isMounted(instanceId)) continue;
      cancelPendingDisposal(instanceId);
      entries.delete(instanceId);
      entry.disposeEngine();
    }
  });
}

/**
 * Return the live engine for `instanceId`, building it via `create` on first
 * acquire. A reparented or reopened host hits the cache and re-attaches the
 * existing `Terminal` instead of constructing a fresh one.
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
 * Drop a host's reference to the engine. `keepAlive` is the caller's "this
 * session is still live" signal (a running terminal-agent or plain terminal):
 * true keeps the engine cached for the next host so scrollback and cursor
 * state survive a split / tab-switch / reopen, with the follower disposing it
 * once the session registry evicts the matching handle; false (exited
 * sessions) disposes it now - the matching session handle is being torn down
 * too, so the next open rebuilds both and replays a fresh host snapshot.
 *
 * `presented` is the releasing host's own answer to "am I still counting as a
 * presented mount?". Dropping it here settles the engine's renderer count in
 * the same call that settles its mount count, so a departing host can never
 * strand one: React destroys effect cleanups in DECLARATION order, so a host's
 * acquire-effect cleanup (this call) runs BEFORE its presentation effect's
 * cleanup. The host clears its own presented flag as it passes it, which is
 * what stops that later cleanup dropping the same count a second time.
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
    // Kept for the live session - unless the instance never registered a
    // session handle at all (a measurement probe whose tab closed before the
    // subscribe was dispatched). Nothing would ever evict that orphan (the
    // follower only runs on registry changes), so give it the same deferred
    // disposal a plain terminal gets; a synchronous remount re-acquires and
    // cancels it.
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
 * Move a cached engine to a new tab instance id, following a session-handle
 * adoption (`TerminalSessionRegistry.rekeyLeaseFreeEntry`): a reopened tab
 * mints a fresh instance id, and adopting the closed tab's warm handle under
 * it must carry the engine along - the handle's store still streams into this
 * engine's writer, and the reopened tile's mount reattaches it with
 * scrollback intact. MUST run BEFORE the session-registry rekey: that rekey
 * notifies the engine follower, which disposes any engine whose instance id
 * is no longer a session-registry member. Returns whether the caller may
 * proceed with that handle rekey: true when the engine moved or none was
 * cached (tab closed before the xterm chunk ever mounted); false when the
 * move is refused - source engine still mounted by a live host, or the
 * target id already holds an engine - in which case the handle must stay
 * keyed with its engine.
 */
export function rekeyXtermHost(
  oldInstanceId: string,
  newInstanceId: string,
): boolean {
  const entry = entries.get(oldInstanceId);
  // No engine to move: trivially consistent - the caller may proceed with
  // the session-handle rekey (the engine never existed or was disposed).
  if (entry === undefined) return true;
  // A host still renders the source engine (e.g. a concurrent second reopen
  // of the same session racing this one's probe): moving it would strand the
  // mount refcount and let that host's cleanup release a key it no longer
  // owns. Refuse; the caller must not split the handle from its engine.
  if (isMounted(oldInstanceId)) return false;
  if (entries.has(newInstanceId)) return false;
  cancelPendingDisposal(oldInstanceId);
  entries.delete(oldInstanceId);
  entries.set(newInstanceId, entry);
  return true;
}

/**
 * Revive the warm handle a CLOSED tab of this session left behind by
 * rekeying it (and its kept-alive xterm engine) to this tab's fresh instance
 * id. Closing a terminal tab keeps a running session's handle - and its live
 * `terminal.subscribe` stream - warm precisely so reopening reattaches
 * instantly, but a reopened tab mints a NEW instance id, so without adoption
 * the warm handle was unreachable forever: the reopen built a SECOND
 * subscription while the old one lingered as a zombie host-side subscriber.
 * Adoption only touches lease-free entries, so a still-open second view of
 * the session (split) is never stolen.
 *
 * Lives here (not in the bootstrap) because ORDER is load-bearing twice
 * over: the engine must move before the session-registry rekey (whose notify
 * wakes the follower above), and adoption must run before `acquireXtermHost`
 * builds a fresh engine under the new id - the mounting host calls this
 * first, and React runs that child effect before any parent bootstrap
 * effect. Idempotent: with the new id already registered it no-ops.
 */
export function adoptWarmSessionInstance(
  identity: TerminalWarmSessionIdentity,
  instanceId: string,
): void {
  const registry = getTerminalSessionRegistry();
  const oldInstanceId = registry.findAdoptableInstanceId(identity, instanceId);
  if (oldInstanceId === null) return;
  // The handle may only move together with its engine - the warm store's
  // writer streams into that engine, so rekeying the handle after a refused
  // engine move (source still mounted, or the target id already has an
  // engine) would split the pair and orphan the scrollback. When the engine
  // move is refused, leave everything keyed as-is; this tab proceeds as a
  // fresh subscriber and the warm entry stays reachable for its own owner.
  if (!rekeyXtermHost(oldInstanceId, instanceId)) return;
  registry.rekeyLeaseFreeEntry(oldInstanceId, instanceId);
}

/**
 * Peek the current grid of the kept-alive engine for `instanceId`, or null
 * when no engine is cached. The bootstrap uses this to seed
 * `terminal.create` / `terminal.subscribe` with the engine's real grid on a
 * revive-in-place (idle reap, binding restart) instead of the 80x24 bootstrap
 * defaults - the host's smaller-pane-wins `min()` takes the subscriber's
 * opening size seriously, so seeding the defaults forced every revive through
 * a shrink-to-80x24-then-grow cycle (and latched there when the grow-back
 * re-report was missed).
 */
export function peekXtermHostGrid(
  instanceId: string,
): { readonly cols: number; readonly rows: number } | null {
  const entry = entries.get(instanceId);
  if (entry === undefined) return null;
  return { cols: entry.term.cols, rows: entry.term.rows };
}

/**
 * Session-keyed fallback for {@link peekXtermHostGrid}: closing a tab and
 * reopening it mints a NEW tab instance id, so the reopened tile finds no
 * engine under its own key - but the previous tab's engine (kept alive for
 * the still-running session, its handle warm in the session registry) is
 * still cached under the old instance id and knows the session's real grid.
 * Seeding the reopen's `terminal.create`/`subscribe` from it keeps the live
 * PTY from being dragged through the 80x24 defaults (the shrink-then-grow
 * whose stale cells the CLI's inline renderer never repaints away). Lookup is
 * `(hostId, sessionId)` so a same-id engine on another host cannot seed this
 * subscribe. With two cached engines for one owner session (split view) any
 * of them serves: the host's `min()` recompute settles the grid either way.
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
 *
 * The landing terminal panel expands from zero width while its xterm engine
 * stays mounted. Its ResizeObserver normally reports the final box, but a
 * transition can leave the engine's last-sent dedupe at an intermediate grid.
 * Reconcile against the local effective grid after the panel reaches its
 * stable width so the natural container size is re-reported even when an
 * ordinary fit would be deduped.
 */
export function reconcileXtermHostAfterLayoutTransition(
  instanceId: string,
): void {
  const entry = entries.get(instanceId);
  if (entry === undefined) return;
  entry.controls.reconcileWithHost(entry.term.cols, entry.term.rows);
}

/**
 * Whether another live engine (a second tab instance - split view) renders the
 * same host session. Under "smaller pane wins" a peer legitimately holds the
 * shared effective grid below this pane's natural size, so the engine's
 * latched-grid diagnostics suppress themselves when a peer exists - the
 * mismatch is expected there, not evidence of the latch bug. Identified by
 * container element (stable from engine construction) rather than the entry
 * object, which does not exist yet while the engine's closures are being
 * built.
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
