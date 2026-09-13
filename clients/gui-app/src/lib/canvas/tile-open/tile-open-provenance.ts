import { useCallback, useSyncExternalStore } from "react";

/**
 * Which tiles on this canvas somebody ASKED for in this session, as opposed to
 * the ones the persisted layout put back.
 *
 * ## Why a tile needs to know
 *
 * Opening a terminal-agent tile starts its agent: the bootstrap sees no live
 * session and creates one, resuming the conversation. That is right for a
 * click - "opening it resumes the same session" is the promise the sleeping
 * agent's own copy makes - and wrong for a restore, where an epic whose canvas
 * holds ten sleeping agents would spawn ten provider CLIs the moment the tab
 * is shown, which is precisely the cost the host's idle reap freed.
 *
 * The two are indistinguishable from inside a tile: a restored tile and a
 * clicked one mount identically, with the same ref and the same props. What
 * separates them is whether anything CALLED the open seam for that tile in
 * this session, and that is what this records.
 *
 * ## Why it is a session set and not a field on the tile
 *
 * The tile refs are persisted (`partialize` in the canvas store), so a flag
 * written onto one would be restored with it and every tile would read as
 * explicitly opened on the second run. The distinction is about THIS session
 * by construction, so it lives in memory that dies with the page.
 *
 * ## What counts
 *
 * Every open goes through `openTileWithNavigation` - the seam
 * `traycer-tile-open-boundary-rules` exists to make the only one - so marking
 * there covers the click, the palette, a drag-and-drop commit, tab activation
 * and a host push alike. A host push is deliberately included: an agent asking
 * for a tile is still something asking, and the tile it asks for is one
 * somebody is about to look at.
 *
 * A tile opened in this session, closed with its epic tab and restored later
 * keeps its instance id and therefore still reads as requested. That is a
 * single stale entry, and it errs toward today's behaviour (start the agent)
 * rather than toward a tile that silently refuses to.
 *
 * ## Why it notifies
 *
 * The interesting open is of a tile that is ALREADY MOUNTED. The seam mints a
 * fresh instance id per intent and dedupe routes the open onto the existing
 * tile, which is not remounted - a terminal body is pinned, so focusing it
 * re-renders nothing by itself. So a consumer that only read this at mount
 * would answer for the restore forever and never hear the open, which is the
 * user clicking Open on a sleeping agent and watching it stay asleep.
 *
 * Hence {@link subscribeTileOpenRequested}. The set only ever GROWS, so the
 * answer for one instance can go `false -> true` and never back: a tile that
 * has decided to start its agent cannot be un-decided by anything here, which
 * is the property the mount-time read was originally protecting.
 */
const requestedInstanceIds = new Set<string>();
const listenersByInstanceId = new Map<string, Set<() => void>>();

/**
 * Record that this tile instance was opened by a request rather than restored,
 * and tell a mounted tile for that instance. Called by the open seam; nothing
 * else should.
 *
 * Idempotent, and that is load-bearing rather than tidy: the seam marks on
 * every open, and re-notifying an instance already marked would re-render
 * every tile watching it for no change.
 */
export function markTileOpenRequested(instanceId: string): void {
  if (requestedInstanceIds.has(instanceId)) return;
  requestedInstanceIds.add(instanceId);
  // Snapshotted, so a listener that unsubscribes while being notified cannot
  // mutate the set mid-iteration.
  for (const listener of [...(listenersByInstanceId.get(instanceId) ?? [])]) {
    listener();
  }
}

/**
 * Whether this tile instance was opened by a request in this session. `false`
 * for a tile the persisted layout restored - including on the very first
 * render, which is what a mount-time decision needs.
 */
export function wasTileOpenRequested(instanceId: string): boolean {
  return requestedInstanceIds.has(instanceId);
}

/**
 * Watch one instance's answer. Returns the unsubscribe.
 *
 * Keyed per instance rather than one global listener list because every
 * terminal tile on the canvas would otherwise re-render on every open
 * anywhere, and the answer they would re-read is unchanged for all but one.
 */
export function subscribeTileOpenRequested(
  instanceId: string,
  onChange: () => void,
): () => void {
  const listeners =
    listenersByInstanceId.get(instanceId) ?? new Set<() => void>();
  listeners.add(onChange);
  listenersByInstanceId.set(instanceId, listeners);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) listenersByInstanceId.delete(instanceId);
  };
}

/**
 * {@link wasTileOpenRequested} as a live read: `false` for a restored tile on
 * its very first render, flipping to `true` if the open seam later marks this
 * instance.
 *
 * `useSyncExternalStore` rather than an effect, so the first render already
 * has the right answer - a tile that WAS requested must not render one frame
 * as unrequested and start its agent a tick late.
 *
 * Here rather than beside the tile: this is the registry's own read, the two
 * would have to be edited together, and the tile that consumes it is already
 * at its complexity budget.
 */
export function useTileOpenRequested(instanceId: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeTileOpenRequested(instanceId, onChange),
    [instanceId],
  );
  const read = useCallback(
    () => wasTileOpenRequested(instanceId),
    [instanceId],
  );
  return useSyncExternalStore(subscribe, read, read);
}
