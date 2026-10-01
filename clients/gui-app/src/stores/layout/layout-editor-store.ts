import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AnalyticsSource } from "@/lib/analytics";
import {
  EMPTY_LAYOUT_HISTORY,
  rebaseLayoutSnapshot,
  recordLayoutChange,
  redoLayout,
  undoLayout,
  type LayoutHistory,
} from "@/lib/layout/layout-history";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";
import type { RegionId } from "@/lib/layout/region-id";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import type { SurfaceGroupId } from "@/components/layout-editor/regions/region-grammar";
import {
  getLayoutSnapshot,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * Everything that is true only while the editor is open, and nothing else
 * (L-01, L-21).
 *
 * The split from `layout-store.ts` is the load-bearing part: this store holds
 * NO layout values. A gesture mutates the layout store and lands one snapshot
 * on the stacks here, which is what makes Undo, Redo and Discard exact whatever
 * a gesture touched, and what lets a write from another window arrive without
 * this store having an opinion about it.
 *
 * Two fields are persisted - where the instrument panel sits and, when it
 * floats, where the user left it. Both are preferences about the panel rather
 * than about a session (L-38).
 */

/**
 * The gesture that reached the door (L-30, L-54).
 *
 * A session fact rather than a property of the opening gesture, because both
 * readers are at the other end of the session: the exit motion, which falls
 * back for a session that was entered from the keyboard exactly as the entry
 * did, and `layout_editor_session.entry` at exit.
 */
export type LayoutEditorEntryMethod = "pointer" | "keyboard";

/** Where the inspector sits (L-38). `float` is the one mode allowed to overlap. */
export type LayoutDockMode = "right" | "left" | "float";

/**
 * A floating inspector's top-left corner, in viewport pixels. `null` until the
 * user has dragged it somewhere, which is what lets the default corner follow
 * the window rather than being frozen at whatever the first window was.
 */
export interface LayoutDockPosition {
  readonly x: number;
  readonly y: number;
}

export interface LayoutEditorSession {
  readonly entry: LayoutEditorEntryMethod;
  /**
   * The gesture that reached the door (`OpenLayoutEditorInput.source`),
   * carried on `layout_editor_session` at exit. Stored here rather than read
   * from the door's own input at close time, because `closeLayoutEditor`
   * only ever sees the session, never the call that opened it.
   */
  readonly source: AnalyticsSource;
  readonly startedAt: number;
  /** Where Done and Discard return the user to. */
  readonly origin: LayoutEditorOrigin;
}

/**
 * The door that opened the session. `tab`: closing the sample tab already
 * returns to the tab the user came from. `settings`: Settings > Layout at the
 * area they were reading (`null` is Presets).
 */
export type LayoutEditorOrigin =
  | { readonly kind: "tab" }
  | { readonly kind: "settings"; readonly area: SurfaceGroupId | null };

export type RegionInstanceKey = string;

/**
 * One live region node on the canvas. Registered by `useLayoutRegion`, which
 * also stamps the data attributes the decoration CSS reads (4.1, 4.2); this
 * record is what the ring and the chip measure and anchor to.
 */
export interface RegionInstance {
  readonly key: RegionInstanceKey;
  readonly regionId: RegionId;
  readonly sceneId: string;
  readonly instanceId: string | null;
  readonly node: HTMLElement;
}

/**
 * The two surfaces a canvas selection can hold that are not regions (D14): the
 * tab strip and the sidebar, keyed by their `SurfaceGroupId`. Neither is a
 * region - the strip is not one at all, and the sidebar's regions are its rail
 * icons - so they are selected as surfaces and placed by the placement bar.
 */
export type PlacementSurfaceId = "topBar" | "sidebar";

/**
 * An area row the canvas draws a part of without the row being a region: Side
 * tab view, whose part is the list of live agents under the active tab. It has
 * no value bag and no index row, so it is not one of `LayoutRegions`; like a
 * region, it hovers and selects from the canvas and from its row, the ring
 * goes around its part, and the part shows ghosted while pointed at in the
 * value that hides it (C3).
 */
export type LayoutSettingId = "sideStripView";

/** The area whose form holds each setting's row. */
const SETTING_AREA: Readonly<Record<LayoutSettingId, SurfaceGroupId>> = {
  sideStripView: "topBar",
};

/** Whether another window holds the single-window lease (L-32). */
export type LayoutEditorLock = "none" | "other-window";

export interface LayoutEditorState {
  readonly session: LayoutEditorSession | null;
  /**
   * Whether an exit is already in flight (5.2). The fallback exit plays the
   * inspector's slide-out BEFORE the teardown clears what it renders, so there
   * is a window in which the session is still open and already leaving; a
   * second reason to leave cannot change where the first one is going.
   *
   * Session state rather than a module flag in `editor-session.ts` so it dies
   * with the session that raised it, the way everything else in this bag does.
   */
  readonly leaving: boolean;
  readonly instances: ReadonlyMap<RegionInstanceKey, RegionInstance>;
  readonly selected: RegionId | null;
  /**
   * A selected SURFACE, the other kind of canvas selection. Never set together
   * with {@link selected}: each setter clears the other, so the ring and the
   * inspector each have one thing to point at.
   */
  readonly selectedSurface: PlacementSurfaceId | null;
  /**
   * The element drawing each placement surface right now, registered by
   * `useLayoutSurface`. A placement write remounts the strip (the top strip and
   * the vertical one are different components), so the ring and the bar
   * re-resolve the node off this map rather than holding the old one (L-90).
   */
  readonly surfaceNodes: ReadonlyMap<PlacementSurfaceId, HTMLElement>;
  /**
   * The third kind of canvas selection, a setting's row and its part. Never set
   * together with {@link selected} or {@link selectedSurface}.
   */
  readonly selectedSetting: LayoutSettingId | null;
  readonly hoveredSetting: LayoutSettingId | null;
  /** The element drawing each setting's part right now, as {@link surfaceNodes}. */
  readonly settingNodes: ReadonlyMap<LayoutSettingId, HTMLElement>;
  /**
   * The inspector's level: `null` is All settings, otherwise the one area whose
   * form is open. Selecting a region on the canvas opens its area.
   */
  readonly area: SurfaceGroupId | null;
  /**
   * Whether the inspector shows the session's change list, a level of its own
   * above whatever {@link area} holds: opening an area leaves it, and its back
   * row returns to the level beneath.
   */
  readonly reviewingSession: boolean;
  /** Rows whose disclosure is open in the area form, by row id. */
  readonly openRows: ReadonlyArray<string>;
  readonly hovered: RegionId | null;
  /**
   * The region element the canvas pointer was last on or pressed. Only a
   * region drawn more than once needs it (a timestamp on every message): the
   * chip and the ring go to the copy the pointer is actually on.
   */
  readonly pointed: HTMLElement | null;
  /**
   * Raised by the first key press and dropped by the first pointer gesture: a
   * row taking focus only drives the canvas highlight when the focus came from
   * the keyboard, so clicking around the inspector leaves the canvas quiet.
   */
  readonly keyboardNav: boolean;
  readonly filter: string;
  readonly dockMode: LayoutDockMode;
  readonly floatPosition: LayoutDockPosition | null;
  readonly history: LayoutHistory;
  /**
   * How many times `undo` has actually travelled back this session
   * (`layout_editor_session.undo_count`). Not derivable from the final
   * history stacks alone: a redo, or a fresh gesture that drops the redo
   * branch, both leave no trace of how many undos preceded them.
   */
  readonly undoCount: number;
  /**
   * When the first gesture landed, or `null` while nothing has
   * (`layout_editor_session.first_change_bucket`). Set once and never moved,
   * so a later undo back to the entry state does not erase that a change was
   * made.
   */
  readonly firstChangeAt: number | null;
  /** The state Discard restores, rebased on every external write (L-18). */
  readonly entrySnapshot: LayoutSnapshot | null;
  /**
   * Whether the layout differs from {@link entrySnapshot}, which is what the
   * Discard button is enabled by.
   *
   * Derived in the ONE place that sees every layout write - the session's
   * layout-store watcher - rather than in a selector or by hand at each gesture
   * path. As a selector it serialised the whole triple TWICE on every
   * editor-store notification, which on a pointer sweep is hundreds of times a
   * second (G1-04); by hand it was five call sites that had to stay in step.
   */
  readonly dirty: boolean;
  readonly lockedBy: LayoutEditorLock;

  readonly beginSession: (session: LayoutEditorSession) => void;
  readonly endSession: () => void;
  readonly registerInstance: (instance: RegionInstance) => void;
  readonly unregisterInstance: (
    key: RegionInstanceKey,
    node: HTMLElement,
  ) => void;
  readonly select: (regionId: RegionId | null) => void;
  readonly selectSurface: (surface: PlacementSurfaceId) => void;
  readonly registerSurfaceNode: (
    surface: PlacementSurfaceId,
    node: HTMLElement,
  ) => void;
  readonly unregisterSurfaceNode: (
    surface: PlacementSurfaceId,
    node: HTMLElement,
  ) => void;
  /** Selects a setting's row and its part, opening the row's area. */
  readonly selectSetting: (setting: LayoutSettingId) => void;
  readonly setHoveredSetting: (setting: LayoutSettingId | null) => void;
  readonly registerSettingNode: (
    setting: LayoutSettingId,
    node: HTMLElement,
  ) => void;
  readonly unregisterSettingNode: (
    setting: LayoutSettingId,
    node: HTMLElement,
  ) => void;
  /**
   * Opens an area's form, or All settings for `null`. A `row` is a region the
   * form opens expanded and highlighted, and the canvas rings; `select` is this
   * with the region's own area.
   */
  readonly openArea: (
    area: SurfaceGroupId | null,
    row: RegionId | null,
  ) => void;
  /**
   * Opens or closes one row's disclosure in the area form. A REGION row's
   * disclosure is also its selection, so the canvas rings it and shows it while
   * hidden: opening one selects it, and closing the selected one clears it. A
   * stacked sidebar pair draws one canvas icon, so its lower member has no
   * other way to be selected.
   */
  readonly toggleRow: (rowId: string) => void;
  readonly setReviewingSession: (reviewingSession: boolean) => void;
  /**
   * One rung of the Escape ladder: leave the session's change list, close the
   * open rows (and the selection), then the selected surface or setting, then
   * the area back to All settings. `false` means the ladder is already at All
   * settings, where it stops.
   */
  readonly popInspectorLevel: () => boolean;
  readonly setHovered: (regionId: RegionId | null) => void;
  readonly setPointed: (node: HTMLElement | null) => void;
  readonly setKeyboardNav: (keyboardNav: boolean) => void;
  readonly setFilter: (filter: string) => void;
  readonly setDockMode: (dockMode: LayoutDockMode) => void;
  /**
   * Where a floating inspector was left, or `null` for "nowhere in
   * particular".
   *
   * `null` is a real value rather than a missing one: an edge snap takes the
   * SIDE as the memory and must clear the coordinates with it, or the next
   * Float opens flush against the edge it was docked to, one pixel from
   * snapping straight back (I-15).
   */
  readonly setFloatPosition: (floatPosition: LayoutDockPosition | null) => void;
  readonly setLockedBy: (lockedBy: LayoutEditorLock) => void;
  /** One gesture: whatever `mutate` writes to the layout store is one undo step. */
  readonly recordGesture: (mutate: () => void) => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly discard: () => void;
}

const SESSION_DEFAULTS = {
  session: null,
  leaving: false,
  instances: new Map<RegionInstanceKey, RegionInstance>(),
  selected: null,
  selectedSurface: null,
  selectedSetting: null,
  hoveredSetting: null,
  area: null,
  reviewingSession: false,
  openRows: [],
  hovered: null,
  pointed: null,
  keyboardNav: false,
  filter: "",
  history: EMPTY_LAYOUT_HISTORY,
  undoCount: 0,
  firstChangeAt: null,
  entrySnapshot: null,
  dirty: false,
} as const;

export const useLayoutEditorStore = create<LayoutEditorState>()(
  persist(
    (set, get) => ({
      ...SESSION_DEFAULTS,
      surfaceNodes: new Map<PlacementSurfaceId, HTMLElement>(),
      settingNodes: new Map<LayoutSettingId, HTMLElement>(),
      dockMode: "right",
      floatPosition: null,
      lockedBy: "none",
      beginSession: (session) => {
        set({
          ...SESSION_DEFAULTS,
          // The nodes on screen belong to the app, not to the session: a
          // region that registered before the session opened stays registered.
          instances: get().instances,
          surfaceNodes: get().surfaceNodes,
          settingNodes: get().settingNodes,
          session,
          entrySnapshot: getLayoutSnapshot(),
        });
        watchExternalLayoutWrites();
      },
      endSession: () => {
        stopWatchingLayoutWrites();
        set({
          ...SESSION_DEFAULTS,
          instances: get().instances,
          surfaceNodes: get().surfaceNodes,
          settingNodes: get().settingNodes,
        });
      },
      registerInstance: (instance) =>
        set((state) => {
          if (state.instances.get(instance.key) === instance) return state;
          const instances = new Map(state.instances);
          instances.set(instance.key, instance);
          return { instances };
        }),
      unregisterInstance: (key, node) =>
        set((state) => {
          // Node-checked, so a remount that registers before the old copy
          // tears down does not delete the live entry.
          if (state.instances.get(key)?.node !== node) return state;
          const instances = new Map(state.instances);
          instances.delete(key);
          return { instances };
        }),
      // Every one of these setters is guarded, because zustand notifies on
      // every `set` and the canvas's own painter runs on every notification:
      // `setHovered` alone fires on each pointer event, which on a 120Hz
      // trackpad is 120 full repaints a second of state that did not move
      // (G1-04).
      select: (selected) => {
        const state = get();
        if (selected === null) {
          if (
            state.selected === null &&
            state.selectedSurface === null &&
            state.selectedSetting === null
          )
            return;
          set({ selected: null, selectedSurface: null, selectedSetting: null });
          return;
        }
        get().openArea(LAYOUT_REGIONS[selected].surface, selected);
      },
      selectSurface: (selectedSurface) => {
        const state = get();
        if (
          state.selectedSurface === selectedSurface &&
          state.selected === null &&
          state.selectedSetting === null &&
          state.area === selectedSurface &&
          !state.reviewingSession
        )
          return;
        set({
          selectedSurface,
          selected: null,
          selectedSetting: null,
          area: selectedSurface,
          reviewingSession: false,
          filter: "",
        });
      },
      selectSetting: (selectedSetting) => {
        const state = get();
        const area = SETTING_AREA[selectedSetting];
        if (
          state.selectedSetting === selectedSetting &&
          state.selected === null &&
          state.selectedSurface === null &&
          state.area === area &&
          !state.reviewingSession
        )
          return;
        set({
          selectedSetting,
          selected: null,
          selectedSurface: null,
          area,
          reviewingSession: false,
          filter: "",
        });
      },
      setHoveredSetting: (hoveredSetting) => {
        if (get().hoveredSetting === hoveredSetting) return;
        set({ hoveredSetting });
      },
      registerSettingNode: (setting, node) =>
        set((state) => {
          if (state.settingNodes.get(setting) === node) return state;
          const settingNodes = new Map(state.settingNodes);
          settingNodes.set(setting, node);
          return { settingNodes };
        }),
      unregisterSettingNode: (setting, node) =>
        set((state) => {
          if (state.settingNodes.get(setting) !== node) return state;
          const settingNodes = new Map(state.settingNodes);
          settingNodes.delete(setting);
          return { settingNodes };
        }),
      registerSurfaceNode: (surface, node) =>
        set((state) => {
          if (state.surfaceNodes.get(surface) === node) return state;
          const surfaceNodes = new Map(state.surfaceNodes);
          surfaceNodes.set(surface, node);
          return { surfaceNodes };
        }),
      unregisterSurfaceNode: (surface, node) =>
        set((state) => {
          // Node-checked like `unregisterInstance`: the strip's next copy may
          // register before the old one tears down.
          if (state.surfaceNodes.get(surface) !== node) return state;
          const surfaceNodes = new Map(state.surfaceNodes);
          surfaceNodes.delete(surface);
          return { surfaceNodes };
        }),
      openArea: (area, row) => {
        const state = get();
        const openRows =
          row === null || state.openRows.includes(row)
            ? state.openRows
            : [...state.openRows, row];
        if (
          state.area === area &&
          state.selected === row &&
          state.selectedSurface === null &&
          state.selectedSetting === null &&
          state.openRows === openRows &&
          (area === null || state.filter === "") &&
          !state.reviewingSession
        )
          return;
        set({
          area,
          reviewingSession: false,
          selected: row,
          selectedSurface: null,
          selectedSetting: null,
          // All settings has no rows, so nothing stays open behind it.
          openRows: area === null ? [] : openRows,
          // Find lives at All settings: opening an area consumes the query, so
          // a leftover one never narrows what the next visit shows.
          filter: area === null ? state.filter : "",
        });
      },
      toggleRow: (rowId) => {
        const state = get();
        const closing = state.openRows.includes(rowId);
        const openRows = closing
          ? state.openRows.filter((entry) => entry !== rowId)
          : [...state.openRows, rowId];
        const region =
          Object.values(LAYOUT_REGIONS).find((entry) => entry.id === rowId)
            ?.id ?? null;
        if (region === null) {
          set({ openRows });
        } else if (!closing) {
          set({
            openRows,
            selected: region,
            selectedSurface: null,
            selectedSetting: null,
          });
        } else if (state.selected === region) {
          set({ openRows, selected: null });
        } else {
          set({ openRows });
        }
      },
      setReviewingSession: (reviewingSession) => {
        if (get().reviewingSession === reviewingSession) return;
        set({ reviewingSession });
      },
      popInspectorLevel: () => {
        const state = get();
        if (state.reviewingSession) {
          set({ reviewingSession: false });
          return true;
        }
        if (state.selected !== null || state.openRows.length > 0) {
          set({ selected: null, openRows: [] });
          return true;
        }
        if (state.selectedSurface !== null || state.selectedSetting !== null) {
          set({ selectedSurface: null, selectedSetting: null });
          return true;
        }
        if (state.area !== null) {
          set({ area: null, openRows: [] });
          return true;
        }
        return false;
      },
      setHovered: (hovered) => {
        if (get().hovered === hovered) return;
        set({ hovered });
      },
      setPointed: (pointed) => {
        if (get().pointed === pointed) return;
        set({ pointed });
      },
      setKeyboardNav: (keyboardNav) => {
        if (get().keyboardNav === keyboardNav) return;
        set({ keyboardNav });
      },
      setFilter: (filter) => {
        if (get().filter === filter) return;
        set({ filter });
      },
      setDockMode: (dockMode) => {
        if (get().dockMode === dockMode) return;
        set({ dockMode });
      },
      setFloatPosition: (floatPosition) => set({ floatPosition }),
      setLockedBy: (lockedBy) => {
        if (get().lockedBy === lockedBy) return;
        set({ lockedBy });
      },
      recordGesture: (mutate) => {
        // A quick verb fires with no session open (L-19), and there is no
        // history for it to be a step in: pushing a snapshot onto a stack
        // nothing can pop would notify every editor-store subscriber and stamp
        // a first-change time for a session that does not exist (G3-12).
        if (get().session === null) {
          applyAsEditorWrite(mutate);
          return;
        }
        const before = getLayoutSnapshot();
        applyAsEditorWrite(mutate);
        // A gesture that landed on the value it already had is not a step: an
        // Undo that visibly does nothing is worse than no Undo.
        const after = getLayoutSnapshot();
        if (sameDrawnLayout(before, after)) return;
        set({
          history: recordLayoutChange(get().history, before),
          firstChangeAt: get().firstChangeAt ?? Date.now(),
        });
      },
      undo: () => {
        const travel = undoLayout(get().history, getLayoutSnapshot());
        if (travel === null) return;
        applyAsEditorWrite(() => {
          useLayoutStore.getState().replaceAll(travel.snapshot);
        });
        set({ history: travel.history, undoCount: get().undoCount + 1 });
      },
      redo: () => {
        const travel = redoLayout(get().history, getLayoutSnapshot());
        if (travel === null) return;
        applyAsEditorWrite(() => {
          useLayoutStore.getState().replaceAll(travel.snapshot);
        });
        set({ history: travel.history });
      },
      discard: () => {
        const entrySnapshot = get().entrySnapshot;
        if (entrySnapshot === null) return;
        applyAsEditorWrite(() => {
          useLayoutStore.getState().replaceAll(entrySnapshot);
        });
        set({ history: EMPTY_LAYOUT_HISTORY });
      },
    }),
    {
      ...basePersistOptions(persistKey(STORE_KEYS.layoutEditorDock)),
      storage: createJSONStorage(() => localStorage),
      // The dock is a preference about the instrument panel; everything else
      // in this store describes one session and dies with it.
      partialize: (state) => ({
        dockMode: state.dockMode,
        floatPosition: state.floatPosition,
      }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        dockMode: persistedDockMode(persistedState),
        floatPosition: persistedFloatPosition(persistedState),
      }),
    },
  ),
);

/**
 * The instance the overlays point at: the first one registered for the region
 * that is on screen, else the first one registered (4.6, C-25).
 *
 * Most regions have exactly one instance in a live session. `useLayoutRegion`
 * registers nothing from a surface whose `PaneVisibilityContext` is false; the
 * editor's canvas is always the sample workspace, which is a plain top-level
 * tab and `splitEligibility: "ineligible"`, so while a session is live that
 * tab is the only visible surface. This used to be a PIN on the sample tile,
 * carried on the session, back when the editor decorated the user's own
 * screen in place (L-15) and two tiles could both be looking at it; L-87
 * removed the second tile, and the pin with it.
 *
 * The transcript's regions are the exception (L-178): a timestamp is drawn on
 * every message, and the first one registered is the oldest - scrolled out of
 * the sample conversation, which opens at its end. The chip and the ring go to
 * the copy the canvas pointer is on (`pointed`), else to one the reader can
 * see, and "can see" is the browser's own hit test at its centre, which knows
 * about the scroller's clip and anything drawn over it.
 */
export function preferredRegionInstance(
  state: Pick<LayoutEditorState, "instances" | "pointed">,
  regionId: RegionId,
): RegionInstance | null {
  let first: RegionInstance | null = null;
  let onScreen: RegionInstance | null = null;
  for (const instance of state.instances.values()) {
    if (instance.regionId !== regionId) continue;
    if (instance.node === state.pointed) return instance;
    first ??= instance;
    if (onScreen === null && instanceOnScreen(instance.node))
      onScreen = instance;
  }
  return onScreen ?? first;
}

function instanceOnScreen(node: HTMLElement): boolean {
  // Widened on purpose: jsdom implements no hit testing, and there every
  // instance is as good as the first.
  const doc: {
    readonly elementFromPoint: Document["elementFromPoint"] | undefined;
  } = node.ownerDocument;
  if (doc.elementFromPoint === undefined) return false;
  const rect = node.getBoundingClientRect();
  const hit = node.ownerDocument.elementFromPoint(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
  );
  return hit !== null && node.contains(hit);
}

/**
 * Whether the editor is asking for this region to be on screen right now even
 * though the user hid it (L-14).
 *
 * There are no ghosts at rest: a hidden region materialises in place only
 * while its index row is hovered or selected, and vanishes again the moment
 * the pointer leaves. Whether it is actually hidden is the caller's question -
 * this one only says whether the editor is pointing at it.
 */
export function regionGhostRequested(
  state: Pick<LayoutEditorState, "session" | "hovered" | "selected">,
  regionId: RegionId,
): boolean {
  if (state.session === null) return false;
  return state.hovered === regionId || state.selected === regionId;
}

/**
 * Writes the editor made itself, so the external-write watcher can tell them
 * apart from a write by another window or by a settings surface (L-18).
 */
let editorWriteDepth = 0;

function applyAsEditorWrite(mutate: () => void): void {
  editorWriteDepth += 1;
  try {
    mutate();
  } finally {
    editorWriteDepth -= 1;
  }
}

let stopLayoutWatch: (() => void) | null = null;

/**
 * The session's one window onto the layout store, and the only writer of
 * {@link LayoutEditorState.dirty}.
 *
 * Every path that can change whether there is anything to discard - a gesture,
 * an undo, a redo, a discard, and a write from another window - is a write to
 * the layout store, so the answer is derived here instead of restated at each
 * of them. What the editor's own writes do NOT do is move the entry snapshot:
 * that is what tells Discard apart from an external rebase (L-18).
 */
function watchExternalLayoutWrites(): void {
  stopWatchingLayoutWrites();
  let previous = getLayoutSnapshot();
  stopLayoutWatch = useLayoutStore.subscribe(() => {
    const before = previous;
    const next = getLayoutSnapshot();
    previous = next;
    const entrySnapshot = useLayoutEditorStore.getState().entrySnapshot;
    if (entrySnapshot === null) return;
    if (editorWriteDepth > 0) {
      setDirty(!sameSnapshot(entrySnapshot, next));
      return;
    }
    // Every snapshot the session can restore moves onto the external write:
    // Discard's baseline and each Undo/Redo step, so none of them puts back
    // what another window changed. The stacks themselves are kept - the old
    // editor wiped them on any external write, which lost the user's own work
    // to someone else's.
    const rebase = (snapshot: LayoutSnapshot): LayoutSnapshot =>
      rebaseLayoutSnapshot(snapshot, before, next);
    const { history } = useLayoutEditorStore.getState();
    const rebased = rebase(entrySnapshot);
    useLayoutEditorStore.setState({
      entrySnapshot: rebased,
      history: {
        past: history.past.map(rebase),
        future: history.future.map(rebase),
      },
      dirty: !sameSnapshot(rebased, next),
    });
  });
}

/**
 * Guarded like every other setter here: zustand notifies on every `set`, and
 * this one runs on each of the hundreds of layout writes a drag lands.
 */
function setDirty(dirty: boolean): void {
  if (useLayoutEditorStore.getState().dirty === dirty) return;
  useLayoutEditorStore.setState({ dirty });
}

function stopWatchingLayoutWrites(): void {
  stopLayoutWatch?.();
  stopLayoutWatch = null;
}

/**
 * Compared as JSON, the same way `rebaseLayoutSnapshot` compares a field: both
 * sides are plain data built by the same resolvers, so key order is not a
 * variable.
 */
function sameSnapshot(
  left: LayoutSnapshot | null,
  right: LayoutSnapshot,
): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Whether two snapshots DRAW the same app, which is a different question from
 * whether they are the same record.
 *
 * A pick equal to the last-applied preset's value changes the record and
 * nothing on screen. An Undo that visibly does nothing is worse than no Undo,
 * and a `first_change_bucket` stamped by an invisible pick would report a
 * change nobody could see.
 *
 * Only `recordGesture` asks this, once per gesture. The dirty flag keeps the
 * cheap record comparison above: it runs inside the store subscription, on
 * every one of the hundreds of layout writes a drag lands (G1-21), and its
 * own question - is there anything Discard would put back - is about the
 * record.
 */
function sameDrawnLayout(left: LayoutSnapshot, right: LayoutSnapshot): boolean {
  return drawnLayout(left) === drawnLayout(right);
}

function drawnLayout(snapshot: LayoutSnapshot): string {
  return JSON.stringify({
    basePreset: snapshot.basePreset,
    values: effectiveLayoutValues(snapshot.basePreset, snapshot.overrides),
    arrangement: snapshot.arrangement,
  });
}

function persistedDockMode(persistedState: unknown): LayoutDockMode {
  if (persistedState === null || typeof persistedState !== "object")
    return "right";
  const dockMode: unknown = Reflect.get(persistedState, "dockMode");
  return dockMode === "left" || dockMode === "float" || dockMode === "right"
    ? dockMode
    : "right";
}

/**
 * A position off another window's viewport is still resolved here; the dock
 * clamps what it reads against the CURRENT viewport, which is the only place
 * that knows how big the panel is.
 */
function persistedFloatPosition(
  persistedState: unknown,
): LayoutDockPosition | null {
  if (persistedState === null || typeof persistedState !== "object")
    return null;
  const floatPosition: unknown = Reflect.get(persistedState, "floatPosition");
  if (floatPosition === null || typeof floatPosition !== "object") return null;
  const x: unknown = Reflect.get(floatPosition, "x");
  const y: unknown = Reflect.get(floatPosition, "y");
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (typeof y !== "number" || !Number.isFinite(y)) return null;
  return { x, y };
}
