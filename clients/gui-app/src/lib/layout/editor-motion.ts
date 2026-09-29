import { flushSync } from "react-dom";
import { aNativeTileIsPresented } from "@/lib/browser-view/tiles/tile-rect-registry";
import type {
  LayoutDockMode,
  LayoutEditorEntryMethod,
} from "@/stores/layout/layout-editor-store";

/**
 * How the editor arrives and how it leaves (L-29, L-30, 5.2, section 6).
 *
 * Nothing here animates a width: the shell reflows beside the inspector in ONE
 * frame, and what glides is a pair of snapshots the browser composites for it,
 * so no text is ever scaled or re-laid-out mid flight (P2). The guarded
 * fallback is that single-frame snap plus the inspector's own slide, which is
 * the stylesheet's doing; what this module adds there is holding the session
 * open until the slide-out has played, because the inspector renders session
 * state that `endSession` clears.
 *
 * Both halves of the door come through `runLayoutEditorMotion`, which is also
 * the one place the L-30 guards are evaluated.
 */

/**
 * Set on `:root` for the life of a transition, so the stylesheet can name
 * exactly two groups and un-name them again. The names are deliberately not
 * permanent: a `view-transition-name` that outlives its transition joins every
 * LATER one, and the app column is on screen for the whole session.
 *
 * Two tokens, the phase and the dock side (L-66), because the exit's shell
 * snapshot grows where the entry's shrinks and the stylesheet has to be able to
 * treat them differently. Token-matched with `~=`, never `=`.
 */
const TRANSITION_ATTRIBUTE = "data-layout-transition";

/** The inspector, while its exit animation plays (fallback path only). */
const EXITING_ATTRIBUTE = "data-exiting";

/**
 * The inspector that arrived inside a view transition, whose snapshot has
 * already played the slide. Stamped before the new state is captured and never
 * taken off: the panel's own `layout-inspector-in` would otherwise start the
 * moment the transition ends and replay an arrival the user just watched
 * (G2-01).
 */
const ENTERED_ATTRIBUTE = "data-entered";

/**
 * `flushSync` with nothing of its own to do, which is how the fallback entry
 * lands the work the door has already scheduled before it begins the session:
 * `flushSync` flushes every pending root, not only what its callback writes.
 */
function noop(): void {
  return undefined;
}

/** The transition whose names `:root` is currently holding, if any. */
let runningTransition: ViewTransition | null = null;

/** The live inspector, handed over by the shell that renders it. */
let inspectorNode: HTMLElement | null = null;

export interface LayoutEditorMotionInput {
  readonly phase: "enter" | "exit";
  readonly entry: LayoutEditorEntryMethod;
  readonly dockMode: LayoutDockMode;
  /**
   * The session change itself - beginning or ending a session. It runs exactly
   * once on every path, inside the transition where there is one, so a guard
   * or a failed transition changes the motion and never the outcome.
   */
  readonly apply: () => void;
}

/**
 * The inspector's own ref callback (`layout-editor.tsx`).
 *
 * The panel is authored and styled in `components/layout-editor`, so this
 * module is HANDED the element rather than going looking for it: a selector
 * string here would be the same layering inversion G1-11 closed, written as a
 * pairing nothing type-checks.
 */
export function setLayoutInspectorNode(node: HTMLElement | null): void {
  inspectorNode = node;
}

/**
 * Both reduced-motion gates, which the editor honours together (section 6):
 * the OS media query, and the app's own "Panel animations" switch, which
 * `theme-applier.ts` mirrors onto `<html data-reduce-panel-motion>`.
 */
export function prefersReducedMotion(): boolean {
  return (
    document.documentElement.hasAttribute("data-reduce-panel-motion") ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Whether the door is mid-flight right now.
 *
 * Read by the gestures that must not start against a shell that is still
 * moving: during a View Transition the app column on screen is a SNAPSHOT, so
 * a drag armed against it would measure boxes that are not where the real
 * elements are about to be.
 */
export function layoutTransitionRunning(): boolean {
  return document.documentElement.hasAttribute(TRANSITION_ATTRIBUTE);
}

/** Enter or leave a session, with whatever motion this moment allows. */
export function runLayoutEditorMotion(input: LayoutEditorMotionInput): void {
  // A re-open inside the previous session's slide-out. `endSession` flushes
  // the pending teardown, so the new session begins in this same task and
  // React never unmounts the panel - which is still wearing the exit
  // attribute, and would sit at `translateX(100%)` for the rest of the
  // animation before sliding back in (G3-05). The pending `finish()` then
  // removes an attribute that is already gone.
  if (input.phase === "enter")
    inspectorNode?.removeAttribute(EXITING_ATTRIBUTE);
  const startViewTransition = viewTransitionStarter();
  if (startViewTransition === undefined || !shellTransitionAllowed(input)) {
    if (input.phase === "enter") {
      // Nothing is gliding here, so `apply` would otherwise run in the very
      // task the door called it from - ahead of the commit for the work the
      // door has already scheduled, which on the way in is the sample tab's
      // activation. `beginSession` fires `useLayoutRegion`'s subscription
      // synchronously, so against an uncommitted activation it reads the
      // OUTGOING surface's `visible` and registers that tab's instances for a
      // commit; a deep-link target then rings a node in the tab being hidden
      // (R2-05). Landing that commit first is what the transition path gets
      // for free by running a frame later.
      flushSync(noop);
      input.apply();
    } else slideInspectorOut(input.apply);
    return;
  }
  const root = document.documentElement;
  root.setAttribute(TRANSITION_ATTRIBUTE, `${input.phase} ${input.dockMode}`);
  const transition = startViewTransition(() => {
    // The old state is captured before this callback and the new state when it
    // returns, so the React commit has to land INSIDE it: without `flushSync`
    // the store write would render on a later task and both snapshots would be
    // the same picture.
    flushSync(input.apply);
    // That commit is what mounted the panel, so its node is in hand here - and
    // the stamp lands before the new state is captured, which is what keeps the
    // snapshot the panel at rest.
    if (input.phase === "enter") {
      inspectorNode?.setAttribute(ENTERED_ATTRIBUTE, "1");
    }
  });
  runningTransition = transition;
  // `finished` rejects when the update callback throws and fulfils when the
  // transition is skipped, and the names have to come off on both: a name left
  // behind would put the app column in the next transition's snapshot, and the
  // next transition may be the one that is guarded off.
  //
  // Only for the transition that is still the current one, though. Starting a
  // second one skips the first, so a close within the entry's own 220ms would
  // otherwise un-name the groups the close itself is about to capture.
  void transition.finished
    .catch(() => undefined)
    .finally(() => {
      if (runningTransition !== transition) return;
      runningTransition = null;
      root.removeAttribute(TRANSITION_ATTRIBUTE);
    });
}

/**
 * L-30's gate. A view transition is the app's own picture gliding, so it is
 * wrong exactly where that picture is not the whole truth or not wanted:
 *
 * - a presented native tile paints outside the page, so it would sit still
 *   while everything around it moved (C-18);
 * - either reduced-motion gate means the shell snaps and the inspector is the
 *   only thing that moves;
 * - keyboard entry is a deliberate, sightless gesture, and the fallback lands
 *   in a single frame;
 * - a floating inspector overlaps the canvas instead of reflowing it, so there
 *   is no shell change to glide (L-38, 5.4).
 */
function shellTransitionAllowed(input: LayoutEditorMotionInput): boolean {
  return (
    input.entry === "pointer" &&
    input.dockMode !== "float" &&
    !prefersReducedMotion() &&
    !aNativeTileIsPresented()
  );
}

/**
 * Hold the session open until the inspector has slid out, then hand over.
 *
 * The inspector's body is session state, so ending the session first and
 * animating afterwards would slide out an inspector that had already snapped
 * back to the empty index. The stylesheet decides whether there is anything to
 * wait for - under either reduced-motion gate the exit animation is `none`, so
 * there are no animations to collect and the teardown is immediate.
 */
function slideInspectorOut(apply: () => void): void {
  const inspector = inspectorNode;
  if (inspector === null) {
    apply();
    return;
  }
  inspector.setAttribute(EXITING_ATTRIBUTE, "1");
  const finish = (): void => {
    inspector.removeAttribute(EXITING_ATTRIBUTE);
    apply();
  };
  // Read after the attribute lands: `getAnimations()` flushes pending style,
  // so the exit animation the attribute just started is in the answer.
  const animations = elementAnimations(inspector);
  if (animations.length === 0) {
    finish();
    return;
  }
  // `allSettled`, because an animation cancelled by its node going away
  // rejects, and a cancelled exit still has to end the session.
  void Promise.allSettled(
    animations.map((animation) => animation.finished),
  ).then(finish);
}

/**
 * `Document.startViewTransition` and `Element.getAnimations` are typed as
 * always-present in `lib.dom.d.ts`, but jsdom implements neither and an older
 * webview implements the first only from Chrome 111. These shapes make the
 * runtime checks meaningful to the type checker instead of dead code, the same
 * way `profile-usage-sidecar-anchor-readiness.ts` does it.
 */
interface DocumentMaybeWithViewTransitions {
  readonly startViewTransition:
    | ((callback: () => void) => ViewTransition)
    | undefined;
}

interface ElementMaybeWithAnimations {
  readonly getAnimations: (() => ReadonlyArray<Animation>) | undefined;
}

function viewTransitionStarter():
  | ((callback: () => void) => ViewTransition)
  | undefined {
  const doc: DocumentMaybeWithViewTransitions = document;
  const start = doc.startViewTransition;
  return start === undefined ? undefined : start.bind(document);
}

function elementAnimations(element: HTMLElement): ReadonlyArray<Animation> {
  const node: ElementMaybeWithAnimations = element;
  return node.getAnimations?.() ?? [];
}
