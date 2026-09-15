import { tabRefKey } from "@/stores/tabs/layout";

/**
 * DOM resolution for the spotlight tour: which node a lesson points at, and
 * nothing else. Joyride owns geometry (measurement, scrolling, the cutout);
 * this module only answers "which element, right now" from the anchors
 * ticket 2 placed (`data-tour`) INSIDE the surface the lesson is about.
 *
 * Scoping is the whole point. Retained tabs keep their DOM mounted, split
 * panes show two surfaces at once, and every chat composer carries the same
 * `data-tour="landing-send"` - so an unscoped `document.querySelector` would
 * happily spotlight a hidden duplicate. Every query starts from the ONE
 * top-level surface that is visible AND named by the tour's context
 * (`top-level-tab-host.tsx` stamps `data-surface-ref` / `data-visible`),
 * then narrows to the draft root or the epic surface inside it.
 */

export type TourAnchor =
  | "landing-folder-add"
  | "landing-workspace-summary"
  | "landing-terminal-switch"
  | "landing-send"
  | "landing-history"
  | "epic-sidebar-column"
  | "epic-sidebar-rail";

export type TourSurfaceScope =
  | { readonly kind: "draft"; readonly draftId: string }
  | { readonly kind: "epic"; readonly tabId: string };

/**
 * The plan's target filter: connected, `checkVisibility()` with the
 * `visibility` and `opacity` properties counted (display, visibility,
 * opacity, content-visibility - at least as strict as Joyride's own walk,
 * which rejects `visibility: hidden` that the default call lets through,
 * and so hands Joyride nothing it would wait on), a nonzero box, and no
 * inert or hidden ancestor. Deliberately NOT a viewport check - an
 * offscreen target is still a target, and Joyride scrolls to it.
 */
export function presentableElement(
  element: Element | null,
): HTMLElement | null {
  if (!(element instanceof HTMLElement) || !element.isConnected) return null;
  if (
    !element.checkVisibility({
      visibilityProperty: true,
      opacityProperty: true,
    })
  ) {
    return null;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (element.closest("[inert], [hidden]") !== null) return null;
  return element;
}

/**
 * The ids reach `querySelector` inside an attribute-value string. `CSS.escape`
 * where the runtime has it (every browser this app targets); jsdom has none,
 * so the two characters that would end the string early are escaped by hand
 * there (the ids are store-generated, never user text).
 */
export function cssAttributeValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[\\"]/g, (char) => `\\${char}`);
}

function surfaceRefSelector(scope: TourSurfaceScope): string {
  const ref =
    scope.kind === "draft"
      ? tabRefKey({ kind: "draft", id: scope.draftId })
      : tabRefKey({ kind: "epic", id: scope.tabId });
  return `[data-visible="true"][data-surface-ref="${cssAttributeValue(ref)}"]`;
}

/**
 * The root a lesson's anchors live under, or null when that surface is not
 * on screen (its tab is retained in the background, or it is gone). A split
 * with two visible panes resolves by the exact ref, never "the first visible
 * one".
 */
export function resolveSurfaceRoot(
  scope: TourSurfaceScope,
): HTMLElement | null {
  const surface = document.querySelector<HTMLElement>(
    surfaceRefSelector(scope),
  );
  if (surface === null) return null;
  const root =
    scope.kind === "draft"
      ? surface.querySelector<HTMLElement>(
          '[data-testid="landing-draft-surface"]',
        )
      : surface.querySelector<HTMLElement>(
          `[data-epic-surface="${cssAttributeValue(scope.tabId)}"]`,
        );
  return presentableElement(root);
}

/** The first PRESENTABLE anchor of that name inside the scope, or null. */
export function resolveAnchor(
  scope: TourSurfaceScope,
  anchor: TourAnchor,
): HTMLElement | null {
  const root = resolveSurfaceRoot(scope);
  if (root === null) return null;
  const candidates = root.querySelectorAll<HTMLElement>(
    `[data-tour="${anchor}"]`,
  );
  for (const candidate of candidates) {
    const presentable = presentableElement(candidate);
    if (presentable !== null) return presentable;
  }
  return null;
}

/**
 * The task-panels lesson: the visible sidebar column, else the rail it
 * collapses to. One or the other, never a union or a proxy node.
 */
export function resolvePanelTarget(
  scope: TourSurfaceScope,
): HTMLElement | null {
  return (
    resolveAnchor(scope, "epic-sidebar-column") ??
    resolveAnchor(scope, "epic-sidebar-rail")
  );
}

/**
 * The first mounted history row whose epic is one of `epicIds` (in the
 * order given): the history lesson's anchor. One row, never the list - the
 * list runs taller than the viewport, and a card placed against it lands
 * inside the cutout over the very rows it points at.
 */
export function resolveHistoryRow(
  scope: TourSurfaceScope,
  epicIds: ReadonlyArray<string>,
): HTMLElement | null {
  const container = resolveAnchor(scope, "landing-history");
  if (container === null) return null;
  for (const epicId of epicIds) {
    const row = container.querySelector<HTMLElement>(
      `[data-epic-id="${cssAttributeValue(epicId)}"]`,
    );
    const presentable = presentableElement(row);
    if (presentable !== null) return presentable;
  }
  return null;
}

/**
 * The epic of the FIRST presentable row in the scope's history list (the
 * list is most-recent first), or null when the list is not on screen or
 * empty: what "Open latest task" opens when the panels lesson has no task
 * bound and there is nothing imported to open.
 */
export function resolveLatestHistoryEpicId(
  scope: TourSurfaceScope,
): string | null {
  const container = resolveAnchor(scope, "landing-history");
  if (container === null) return null;
  for (const row of container.querySelectorAll<HTMLElement>("[data-epic-id]")) {
    if (presentableElement(row) === null) continue;
    const epicId = row.dataset.epicId;
    if (epicId !== undefined && epicId.length > 0) return epicId;
  }
  return null;
}

/**
 * Notifies `onChange` when anything that can change a resolution happens:
 * nodes mounting/unmounting anywhere (a rail replacing a column, a draft
 * becoming an epic), the visibility/collapse attributes the surfaces stamp,
 * and a window resize. Coarse on purpose - the caller re-resolves and only
 * reacts when the CHOSEN node actually changed, so a chatty observer costs a
 * querySelector, not a re-present.
 */
export function observeTourTargets(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "data-visible",
      "data-collapsed",
      "data-focused",
      "hidden",
      "inert",
      "style",
      "class",
    ],
  });
  window.addEventListener("resize", onChange);
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", onChange);
  };
}

// ── Target tracker ──────────────────────────────────────────────────────────

export interface TargetSnapshot {
  /** The lesson/context this snapshot was resolved for. */
  readonly key: string | null;
  readonly node: HTMLElement | null;
  /** Joyride refused `node` (its target wait timed out): shown centred. */
  readonly unanchored: boolean;
  /** Bumps whenever the renderer must be replaced (a `key` for Joyride). */
  readonly epoch: number;
}

export interface TargetTracker {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => TargetSnapshot;
  /**
   * Track one lesson: a new `key` starts fresh (new epoch); the same key
   * re-resolves in place. Resolves now and on every DOM change until the
   * returned stop runs.
   */
  readonly track: (
    key: string,
    resolve: () => HTMLElement | null,
  ) => () => void;
  /** Joyride's target wait timed out on the node: centred card, no cutout. */
  readonly markUnanchored: () => void;
  /** No lesson is being tracked. */
  readonly reset: () => void;
}

const EMPTY_SNAPSHOT: TargetSnapshot = {
  key: null,
  node: null,
  unanchored: false,
  epoch: 0,
};

/**
 * The controller's in-memory presentation state as an external store, so
 * the React side reads it with `useSyncExternalStore` and never sets state
 * from inside an effect. Owns the MutationObserver; the rules it encodes:
 *
 * - the chosen node changing (including to null) re-presents under a new
 *   epoch - Joyride does not move or drop the card on its own (spike F5);
 * - no node (missing at entry, or vanished since - stale hole included) is
 *   the unanchored card at once; the tracker keeps resolving underneath;
 * - `unanchored` marks a node Joyride itself refused (its target wait timed
 *   out, F4): the card stays centred until the CHOSEN node changes;
 * - a node that comes back re-anchors the same lesson; progress is never
 *   touched here.
 */
export function createTargetTracker(): TargetTracker {
  let snapshot: TargetSnapshot = EMPTY_SNAPSHOT;
  const listeners = new Set<() => void>();
  let stopObserving: (() => void) | null = null;

  const publish = (next: TargetSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const apply = (resolve: () => HTMLElement | null): void => {
    const node = resolve();
    const current = snapshot;
    if (node === current.node) return;
    publish({
      ...current,
      node,
      // A refusal was about the previous node; the new one gets its try.
      unanchored: false,
      epoch: current.epoch + 1,
    });
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    track: (key, resolve) => {
      stopObserving?.();
      if (snapshot.key !== key) {
        publish({
          key,
          node: null,
          unanchored: false,
          epoch: snapshot.epoch + 1,
        });
      }
      apply(resolve);
      const stop = observeTourTargets(() => {
        apply(resolve);
      });
      stopObserving = stop;
      return () => {
        if (stopObserving === stop) stopObserving = null;
        stop();
      };
    },
    markUnanchored: () => {
      if (snapshot.unanchored) return;
      publish({ ...snapshot, unanchored: true, epoch: snapshot.epoch + 1 });
    },
    reset: () => {
      stopObserving?.();
      stopObserving = null;
      if (snapshot.key === null) return;
      publish({ ...EMPTY_SNAPSHOT, epoch: snapshot.epoch + 1 });
    },
  };
}
