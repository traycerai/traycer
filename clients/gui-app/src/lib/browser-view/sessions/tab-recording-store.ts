/**
 * Per-tab recording state, as the renderer learns it from the four recording
 * frames on `browser.sessions` (D15).
 *
 * ## Why the renderer holds this at all
 *
 * The recording itself is the HOST's (ticket 21): it mints the `recordingId`,
 * drives the helper, owns the chunk sink and finalizes the file. The renderer
 * neither starts nor stops one by writing here. What it does own is what the
 * tile SHOWS - a badge that has to be live for the whole recording (D20) - and
 * the two frames that say a helper came up or went away are the only place
 * that fact exists on this side. So this is a projection of frames, never a
 * source of truth, and every writer below is named after the frame it applies.
 *
 * ## Keyed by (host, tab), indexed by recording
 *
 * `startTabRecording` names a tab; `stopTabRecording` names only a
 * `recordingId`, deliberately - the tab may already be gone (auto-stop on tab
 * close is one of the reasons the host sends it), so naming it would make the
 * stop unroutable in exactly the case it matters most. The index is what lets
 * a recording-addressed frame find the tab that was recording.
 *
 * Tab ids are host-minted, but a `tabId` alone is not a key here: two hosts
 * are two coordinators and their id spaces are unrelated.
 *
 * ## Rows are OWNED
 *
 * Two epics open on one host are two coordinators with the same `hostId`, so
 * "forget this host's rows" when one of them closes would clear the other's
 * live badge. Each writer names an owner token instead and only its own rows
 * go with it - the same shape `electron-tab-directory` uses for tab bindings,
 * and for the same reason.
 */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/**
 * - `idle` - nothing recording, and the state every tab starts in.
 * - `starting` - the host asked for a helper; none has reported ready yet.
 * - `recording` - a helper is up and chunks are flowing.
 * - `ended` - it finished, was stopped, or the helper went away mid-run.
 * - `refused` - this client cannot serve a recording at all (no runtime that
 *   can open a helper window). Distinct from `ended` because nothing was ever
 *   captured and there is no file coming, which is different copy and a
 *   different badge.
 */
export type TabRecordingStatus =
  | "idle"
  | "starting"
  | "recording"
  | "ended"
  | "refused";

export interface TabRecordingState {
  readonly status: TabRecordingStatus;
  /** The host-minted correlation handle, `null` only while `idle`. */
  readonly recordingId: string | null;
  /**
   * The `recordingEnded` reason, verbatim. An OPEN string on the wire and
   * therefore open here: it is a diagnostic, never a discriminator, so a value
   * this build has never seen costs a less specific line rather than a state.
   */
  readonly reason: string | null;
}

export const IDLE_TAB_RECORDING: TabRecordingState = {
  status: "idle",
  recordingId: null,
  reason: null,
};

interface TabRecordingStoreState {
  readonly byTab: Partial<Record<string, TabRecordingState>>;
  readonly tabKeyByRecordingId: Partial<Record<string, string>>;
}

const tabRecordingStore = createStore<TabRecordingStoreState>()(() => ({
  byTab: {},
  tabKeyByRecordingId: {},
}));

/**
 * Who wrote each row. Beside the store rather than in it: a `symbol` is not a
 * serializable state value, and nothing renders from it - it exists only so a
 * closing coordinator can drop exactly its own rows.
 */
const ownerByTabKey = new Map<string, symbol>();

/**
 * A NUL join rather than JSON: NUL cannot occur in a host id or a host-minted
 * tab id, so one string cannot be two different `(host, tab)` pairs. Same
 * separator `open-browser-url.ts` joins its in-flight keys with.
 */
function tabKey(hostId: string, tabId: string): string {
  return `${hostId}\u0000${tabId}`;
}

/** `startTabRecording`: the host wants a helper for this tab. */
export function applyTabRecordingStarted(args: {
  /** The coordinator this row belongs to; see the ownership note above. */
  readonly owner: symbol;
  readonly hostId: string;
  readonly tabId: string;
  readonly recordingId: string;
}): void {
  const key = tabKey(args.hostId, args.tabId);
  ownerByTabKey.set(key, args.owner);
  const current = tabRecordingStore.getState();
  tabRecordingStore.setState({
    byTab: {
      ...current.byTab,
      [key]: {
        status: "starting",
        recordingId: args.recordingId,
        reason: null,
      },
    },
    tabKeyByRecordingId: {
      ...current.tabKeyByRecordingId,
      [args.recordingId]: key,
    },
  });
}

/** `recordingHelperReady`: a helper came up and the clip is being captured. */
export function applyTabRecordingLive(recordingId: string): void {
  const target = liveTabFor(recordingId);
  if (target === null) return;
  const current = tabRecordingStore.getState();
  tabRecordingStore.setState({
    byTab: {
      ...current.byTab,
      [target.key]: { status: "recording", recordingId, reason: null },
    },
  });
}

/**
 * The recording is over: `stopTabRecording` (the host tearing the helper
 * down), `recordingEnded` (the helper reporting it went away), or this
 * client's own refusal.
 *
 * The index entry goes with it. A stop is terminal and a `recordingId` is
 * minted per recording, so nothing can address this one again.
 */
export function applyTabRecordingEnded(args: {
  readonly recordingId: string;
  readonly status: "ended" | "refused";
  readonly reason: string | null;
}): void {
  const target = liveTabFor(args.recordingId);
  if (target === null) return;
  const current = tabRecordingStore.getState();
  const tabKeyByRecordingId = { ...current.tabKeyByRecordingId };
  delete tabKeyByRecordingId[args.recordingId];
  tabRecordingStore.setState({
    byTab: {
      ...current.byTab,
      [target.key]: {
        status: args.status,
        recordingId: args.recordingId,
        reason: args.reason,
      },
    },
    tabKeyByRecordingId,
  });
}

/**
 * Forgets every row one coordinator wrote.
 *
 * Called when its stream leaves `live`: a recording is helper- and
 * socket-bound, so a dropped stream means nothing that coordinator started is
 * still running, and a badge left at `recording` would keep counting against a
 * run with no helper behind it. Deliberately back to ABSENT (`idle`) rather
 * than `ended` - that word promises a finalized file - and a reconnect learns
 * the true state from the host's next frames.
 */
export function forgetOwnedTabRecordings(owner: symbol): void {
  const current = tabRecordingStore.getState();
  const byTab: Record<string, TabRecordingState> = {};
  const dropped = new Set<string>();
  for (const [key, state] of Object.entries(current.byTab)) {
    if (state === undefined) continue;
    if (ownerByTabKey.get(key) === owner) {
      dropped.add(key);
      ownerByTabKey.delete(key);
      continue;
    }
    byTab[key] = state;
  }
  if (dropped.size === 0) return;
  const tabKeyByRecordingId: Record<string, string> = {};
  for (const [recordingId, key] of Object.entries(
    current.tabKeyByRecordingId,
  )) {
    if (key === undefined || dropped.has(key)) continue;
    tabKeyByRecordingId[recordingId] = key;
  }
  tabRecordingStore.setState({ byTab, tabKeyByRecordingId });
}

/** Test-only: the store is module-global and outlives one test's coordinator. */
export function resetTabRecordingsForTests(): void {
  ownerByTabKey.clear();
  tabRecordingStore.setState({ byTab: {}, tabKeyByRecordingId: {} });
}

/**
 * The tab a recording-addressed frame settles, or `null` when there is none to
 * settle: a recording this client never saw start (another client's helper
 * served it, or a reconnect wiped the index), or a tab a LATER recording
 * already owns - settling that one from the older id would move a live badge
 * back to `ended`.
 */
function liveTabFor(recordingId: string): { readonly key: string } | null {
  const current = tabRecordingStore.getState();
  const key = current.tabKeyByRecordingId[recordingId];
  if (key === undefined) return null;
  const state = current.byTab[key];
  if (state === undefined || state.recordingId !== recordingId) return null;
  return { key };
}

/**
 * The hook the capture/record toolbar (ticket 24) reads.
 *
 * Returns the shared state object, so a tab with no recording gets the one
 * frozen `IDLE_TAB_RECORDING` and never re-renders on another tab's traffic.
 */
export function useTabRecordingState(
  hostId: string,
  tabId: string,
): TabRecordingState {
  return useStore(
    tabRecordingStore,
    (state) => state.byTab[tabKey(hostId, tabId)] ?? IDLE_TAB_RECORDING,
  );
}

/**
 * Whether a recording is live enough that the toolbar's control means "stop"
 * rather than "record".
 *
 * The exhaustive `switch` is the point: `TabRecordingStatus` is the union every
 * recording surface branches on, so a sixth state added later is a compile
 * error here instead of falling silently into the `record` arm of a button.
 */
export function isTabRecordingInFlight(status: TabRecordingStatus): boolean {
  switch (status) {
    case "starting":
    case "recording":
      return true;
    case "idle":
    case "ended":
    case "refused":
      return false;
    default: {
      const unhandled: never = status;
      void unhandled;
      return false;
    }
  }
}
