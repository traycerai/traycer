import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type {
  ISearchResultChangeEvent,
  SearchAddon,
} from "@xterm/addon-search";
import type { CanvasAddon } from "@xterm/addon-canvas";
import type { TerminalDataWriter } from "@/stores/terminals/terminal-session-store";
import { getTerminalSessionRegistry } from "@/lib/registries/terminal-session-registry";

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
  openExternalLink: (uri: string) => void;
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
   * can't pin the terminal small forever.
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
  readonly containerEl: HTMLDivElement;
  readonly term: Terminal;
  readonly fitAddon: FitAddon;
  readonly searchAddon: SearchAddon;
  readonly canvasAddon: CanvasAddon | null;
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
 */
export function releaseXtermHost(instanceId: string, keepAlive: boolean): void {
  if (keepAlive) return;
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

export function __disposeAllXtermHostsForTests(): void {
  for (const timer of pendingDisposals.values()) {
    clearTimeout(timer);
  }
  pendingDisposals.clear();
  for (const entry of entries.values()) {
    entry.disposeEngine();
  }
  entries.clear();
}

export function __getXtermHostEntryForTests(
  instanceId: string,
): XtermHostEntry | null {
  return entries.get(instanceId) ?? null;
}
