import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, useIsPresent, type Transition } from "motion/react";
import * as m from "motion/react-m";
import { ChatDockCompactStripContext } from "@/components/chat/chat-dock-compact-context";
import {
  CHAT_DOCK_SECTION_NAME,
  type ChatDockSection,
} from "@/lib/chat/chat-dock-sections";
import { useMotionEnabled } from "@/lib/animation/use-motion-enabled";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  CHAT_DOCK_PANEL_DEFAULT_HEIGHT_RATIO,
  CHAT_DOCK_PANEL_MAX_HEIGHT_RATIO,
  CHAT_DOCK_PANEL_MIN_HEIGHT_RATIO,
  chatDockPanelHeightCss,
  chatDockPanelPaneHeight,
  clampChatDockPanelHeightRatio,
} from "@/lib/chat/chat-dock-panel-height";
import { cn } from "@/lib/utils";

/**
 * The node in the pill row that an OPEN pill's actions are portalled into.
 *
 * L-142 puts "Review all / Undo all" and "Stop all" at the right end of the
 * pill row rather than inside the panel, so the panel below the pills is pure
 * content. A portal rather than a prop because the
 * actions are made of the panel's own state - pending mutations, gates,
 * confirm dialogs - and lifting them into the strip would mean lifting all of
 * that with them, or duplicating it.
 *
 * `null` is "no strip on this surface", which is the landing composer and the
 * new-conversation modal; their panels never attach.
 */
const ChatDockPillActionsHostContext = createContext<HTMLElement | null>(null);

export const ChatDockPillActionsHostProvider =
  ChatDockPillActionsHostContext.Provider;

/**
 * True inside the copy of a panel that is fading out after a pill swap.
 *
 * The ghost is the previous render's element tree, still mounted - so it is
 * still reading live context and would re-render into whatever the dock now
 * says. Two things follow from that, and this flag is what both read.
 */
const ChatDockPanelLeavingContext = createContext(false);

/**
 * Holds the dock's answer still for a copy of a panel that is on its way out,
 * and marks that copy as leaving.
 *
 * It wraps twice, once around the slot and once around the content inside it,
 * because a panel leaves along two different paths - the pill was closed, so
 * the whole slot collapses; or another pill was clicked, so only the content
 * is replaced - and the copy that is fading looks identical from the outside
 * either way. The `leaving` flag is inherited rather than overwritten, so the
 * inner wrapper cannot un-mark a panel the collapsing slot already marked.
 *
 * The frozen answer matters because every panel decides its own SHAPE from
 * this one context (`useChatDockSectionAttached`): an attached panel drops
 * its collapsible header, a folded one grows one back. Without the freeze the
 * outgoing copy re-reads the dock's new answer and morphs into a collapsed
 * row half a frame before it fades - which is not a panel leaving, it is a
 * third state nobody asked for.
 */
function ChatDockAttachedPanelSection(props: {
  readonly section: ChatDockSection;
  readonly leaving: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const strip = useContext(ChatDockCompactStripContext);
  const inheritedLeaving = useContext(ChatDockPanelLeavingContext);
  const leaving = props.leaving || inheritedLeaving;
  const marked = (
    <ChatDockPanelLeavingContext.Provider value={leaving}>
      {props.children}
    </ChatDockPanelLeavingContext.Provider>
  );
  if (!leaving || strip === null) return marked;
  return (
    <ChatDockCompactStripContext.Provider
      value={{ ...strip, openSection: props.section }}
    >
      {marked}
    </ChatDockCompactStripContext.Provider>
  );
}

/**
 * One attached panel's actions, drawn at the right end of the pill row.
 *
 * Renders nothing until the strip's host node exists, which is the same commit
 * the strip first paints in - so an attached panel's actions arrive with it
 * rather than a frame later.
 */
export function ChatDockPillActions(props: {
  readonly children: ReactNode;
}): ReactNode {
  const host = useContext(ChatDockPillActionsHostContext);
  const leaving = useContext(ChatDockPanelLeavingContext);
  // A panel that is fading out portals nothing. Its rows are behind `inert`
  // inside the ghost, but the actions are PORTALLED into the pill row - out
  // of that subtree, and therefore live and clickable - so a swap would put
  // two sets of header actions side by side for the length of the crossfade,
  // one of them belonging to a panel that is no longer open. The actions
  // follow the panel being DRAWN (L-150).
  if (host === null || leaving) return null;
  return createPortal(props.children, host);
}

/** One arrow press, ~2% of the chat pane - fine enough to land on a row. */
const KEYBOARD_STEP = 0.02;

/**
 * Grow and collapse (L-152), on the app's own drawer curve
 * (`--ease-spring`, the Ionic `cubic-bezier(0.32, 0.72, 0, 1)` `index.css`
 * already names): fast out of the gate, long settle. Under the 250ms ceiling
 * the ruling sets, and the way out is a touch quicker than the way in - the
 * same asymmetry the pill strip beside it already keeps (140ms in, 110ms out).
 */
const PANEL_ENTER_TRANSITION = {
  duration: 0.22,
  ease: [0.32, 0.72, 0, 1],
} satisfies Transition;
const PANEL_EXIT_TRANSITION = {
  duration: 0.18,
  ease: [0.32, 0.72, 0, 1],
} satisfies Transition;

/** Motion, asked for and refused: the value change lands in the frame it is made. */
const INSTANT_TRANSITION = { duration: 0 } as const;

/**
 * Closed, which is where the panel both starts and ends: no height and no
 * opacity. `height: 0` rather than a transform, and `0` rather than the 0.96
 * the pills enter from, because this box is a CLIP - the content inside it
 * keeps its own size throughout and is revealed, never scaled.
 */
const PANEL_COLLAPSED = { height: 0, opacity: 0 } as const;

/**
 * The open state before the content has been measured, which is the one or two
 * renders between mounting and the layout effect below reporting a height.
 *
 * Deliberately carries no `height` key at all rather than a zero: with motion
 * silent about height the box is `height: auto` and draws its content at full
 * size, so a chat opening with a pill already remembered paints the panel
 * rather than growing into it. When the measurement lands, motion resolves the
 * animation's origin from the element's own computed height, which is already
 * the value it is being sent to - so that first update moves nothing.
 */
const PANEL_SHOWN_UNMEASURED = { opacity: 1 } as const;

/**
 * The swap between two pills (L-152): the old content out, the new one in,
 * over the same 150ms, with a 2px blur bridging them.
 *
 * The blur is the part that earns its place. Two panels crossfading at equal
 * opacity read as two legible lists stacked on each other for 75ms; blurred,
 * they read as one surface changing its mind. Kept at 2px - it is a bridge,
 * not an effect, and a heavy blur is expensive.
 */
const PANEL_CONTENT_HIDDEN = { opacity: 0, filter: "blur(2px)" } as const;
const PANEL_CONTENT_SHOWN = { opacity: 1, filter: "blur(0px)" } as const;
const PANEL_CONTENT_TRANSITION = { duration: 0.15, ease: "easeOut" } as const;

/** Collapsing on the way out. */
const PANEL_EXIT = {
  ...PANEL_COLLAPSED,
  transition: PANEL_EXIT_TRANSITION,
} as const;

/**
 * What leaves with motion turned off: the same path at zero length.
 *
 * The presence root itself stays mounted whatever the gate says - it is the
 * VALUE that is switched, never the element, which is the pattern
 * `chat-dock-compact-strip.tsx` already keeps. A conditional
 * `AnimatePresence` would reconcile a different element type at that
 * position every time `useMotionEnabled` flipped, and it flips on pane
 * VISIBILITY: `TopLevelTabHost` keeps inactive panes mounted under
 * `display: none`, so switching tabs and back would destroy the open panel
 * and everything it held - its scroll position and its expanded rows.
 */
const PANEL_EXIT_INSTANT = {
  ...PANEL_COLLAPSED,
  transition: INSTANT_TRANSITION,
} as const;
const PANEL_CONTENT_EXIT_INSTANT = {
  opacity: 0,
  transition: INSTANT_TRANSITION,
} as const;

/** The marker a panel body carries, so the slot can find the one being DRAWN. */
const PANEL_BODY_ATTRIBUTE = "data-dock-panel-body";
/** The marker on the wrapper of a copy that is fading out. */
const PANEL_LEAVING_ATTRIBUTE = "data-panel-leaving";

interface AttachedPanelBox {
  /** The in-flow child's drawn height - what the slot animates to. */
  readonly height: number;
  /**
   * True while the body is showing less than it holds, which is the only
   * state in which the cap is doing anything (L-164). It is read from the
   * body rather than computed, because the cap is a CSS `min()` of `cqh`
   * that no JavaScript here can resolve.
   */
  readonly scrollable: boolean;
}

const EMPTY_PANEL_BOX: AttachedPanelBox = { height: 0, scrollable: false };

/**
 * The body of the panel being DRAWN, never a crossfade ghost's copy.
 *
 * A ghost is out of flow and on its way out, so its scroll state says nothing
 * about the panel the handle would resize.
 */
function livePanelBody(wrapper: Element): Element | null {
  for (const node of wrapper.querySelectorAll(`[${PANEL_BODY_ATTRIBUTE}]`)) {
    if (node.closest(`[${PANEL_LEAVING_ATTRIBUTE}]`) === null) return node;
  }
  return null;
}

/**
 * ONE ResizeObserver over the slot's single in-flow child, reporting both
 * numbers the slot needs from it.
 *
 * The height has to be measured rather than computed: the content decides it
 * now (L-151) and the cap clamping it is a CSS `min()` of `cqh`. The scroll
 * state rides the same callback rather than a second observer, because the
 * only way for the body to start or stop scrolling is for its own height to
 * change, and the body's height IS this wrapper's height minus fixed chrome -
 * so every crossing fires this callback. Content growing while the body is
 * already at the cap does not resize the wrapper and does not fire, which is
 * correct: it was scrolling before and it is scrolling after.
 *
 * A non-positive reading is a detached or hidden box rather than a collapsed
 * one, so the last known height stands - the same rule
 * `use-measured-element-height.ts` keeps, and the reason this is a local hook
 * rather than that one: the shared hook reports a number, and the scroll
 * state has to come from the same observation to stay in step with it.
 */
function usePanelBox(): {
  readonly setElement: (node: HTMLDivElement | null) => void;
  readonly box: AttachedPanelBox;
} {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState<AttachedPanelBox>(EMPTY_PANEL_BOX);
  useLayoutEffect(() => {
    if (element === null) return;
    const read = (): void => {
      const measured = Math.ceil(element.getBoundingClientRect().height);
      const body = livePanelBody(element);
      const scrollable = body !== null && body.scrollHeight > body.clientHeight;
      setBox((current) => {
        const height = measured > 0 ? measured : current.height;
        if (current.height === height && current.scrollable === scrollable) {
          return current;
        }
        return { height, scrollable };
      });
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [element]);
  return { setElement, box };
}

/**
 * What the slot's drawn height belongs to, and whether reaching it is one of
 * the three moves L-152 eases (L-165).
 *
 * `armed` is the whole point. A section change and the measurement that
 * follows it land in DIFFERENT commits - the observer cannot report the new
 * panel's height until React has drawn it - so "the section changed" has to
 * survive the render in between or the ease is spent on nothing and the move
 * that matters goes instant.
 */
/** How a height change is reached: eased over 220ms, or in the frame. */
type PanelMove = "ease" | "instant";

interface PanelEaseState {
  readonly section: ChatDockSection;
  readonly height: number;
  readonly armed: boolean;
  /**
   * How the height was last actually MOVED, which is the only form of this
   * decision a test can read after the fact: the render that hands motion a
   * new height is followed immediately by one that has nothing left to do, so
   * an attribute describing only the current render would report "instant"
   * for every ease a moment after it started.
   */
  readonly lastMove: PanelMove;
}

/**
 * The attached panel's body: the scrolling box one open pill fills.
 *
 * It takes its height from its CONTENT and caps it (L-151). The stored share
 * is a `max-height`, so five todo rows draw five todo rows and a long file
 * list stops at the cap and scrolls - which is what the owner asked for after
 * the live pass, where "even though the actual content is less, the panel
 * opens quite big".
 *
 * The cap itself is a share of the CHAT PANE rather than of the window
 * (L-145): on a canvas with several tiles a chat is a third of the window
 * tall, and a window-relative third of it would leave no transcript at all.
 * The pane is a size container (`chat-tile.tsx`), so the share is a plain
 * `cqh` and nothing here observes or measures while the window resizes.
 *
 * Everything around the body - the region, the resize handle, the height
 * custom property, the enter and exit motion - belongs to the SLOT above,
 * which is one box shared by every pill. This component is what a panel
 * renders when its pill is the open one, and it is deliberately the smallest
 * thing that can be: a panel swapping in must not bring a second handle, a
 * second region or a second drag with it.
 */
export function ChatDockAttachedPanelBody(props: {
  readonly section: ChatDockSection;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  // A crossfade puts two of these in the document for 150ms, so the copy on
  // its way out answers to a different name. Both test ids are suffixed, not
  // just the outer one: `getByTestId` throws on two matches, and the six
  // older call sites that ask for a bare `accumulated-changes-list` have no
  // reason to learn about ghosts.
  const leaving = useContext(ChatDockPanelLeavingContext);
  const suffix = leaving ? "-leaving" : "";
  return (
    <div
      data-testid={`chat-dock-attached-panel${suffix}`}
      data-dock-section={props.section}
      className="@container flex min-w-0 flex-col"
    >
      <div
        data-testid={`${props.testId}${suffix}`}
        {...{ [PANEL_BODY_ATTRIBUTE]: "" }}
        data-native-scrollbar="true"
        className="max-h-[var(--chat-dock-panel-height)] min-h-0 w-full overflow-y-auto"
      >
        {props.children}
      </div>
    </div>
  );
}

/**
 * One open pill's content, crossfaded against the pill that was open before.
 *
 * A component of its own so it can ask `useIsPresent`, which decides the two
 * things a leaving copy needs.
 *
 * It goes OUT OF FLOW, which is what makes this a crossfade rather than a
 * stack: the incoming panel is then the only thing the measured wrapper
 * above reports, so the slot's height eases straight to the new content's
 * while the two contents fade through each other. This is `popLayout` by
 * hand, deliberately - motion's own `popLayout` measures the child through a
 * ref it clones onto it, and the child here is a component rather than a
 * `m.div`, so the ref never lands and the ghost is dropped in the same frame.
 *
 * And it goes INERT, because for 150ms it is a second copy of a dock panel -
 * with rows, buttons and an accessible name - lying over the real one. One
 * attribute takes it out of the pointer's way, out of the tab order and out
 * of the accessibility tree. `data-panel-leaving` is how a test tells the two
 * apart without waiting on a frame.
 */
function ChatDockAttachedPanelContent(props: {
  readonly section: ChatDockSection;
  readonly motionEnabled: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const present = useIsPresent();
  return (
    <m.div
      inert={!present}
      {...{ [PANEL_LEAVING_ATTRIBUTE]: present ? undefined : "true" }}
      className={cn("min-w-0", present ? null : "absolute inset-x-0 top-0")}
      initial={props.motionEnabled ? PANEL_CONTENT_HIDDEN : false}
      animate={PANEL_CONTENT_SHOWN}
      exit={
        props.motionEnabled ? PANEL_CONTENT_HIDDEN : PANEL_CONTENT_EXIT_INSTANT
      }
      transition={
        props.motionEnabled ? PANEL_CONTENT_TRANSITION : INSTANT_TRANSITION
      }
    >
      <ChatDockAttachedPanelSection section={props.section} leaving={!present}>
        {props.children}
      </ChatDockAttachedPanelSection>
    </m.div>
  );
}

/**
 * THE slot the pills switch over: one box above the composer, with the resize
 * handle on its top edge and whichever pill is open inside it (L-142).
 *
 * One slot rather than one box per panel is what makes L-152 possible at all.
 * A switch keeps this element mounted and eases its height from the old
 * content's to the new one's while the two contents crossfade inside it; if
 * every panel brought its own animated box, a switch would collapse one to
 * nothing and grow the other from nothing, which is the jumpy swap the owner
 * reported. It also means one drag state, one `aria-controls` target and one
 * `role="region"` - rather than a second copy of each arriving mid-crossfade,
 * with the same `id` on both.
 *
 * `height` is the one non-compositor property in the file and it is confined
 * to this container. There is no transform that does this job: the panel has
 * to make ROOM, and the stack it sits in is bottom-anchored (the chat pane's
 * lower surfaces are an `absolute inset-x-0 bottom-0` overlay,
 * `chat-tile.tsx`), so growing this box moves the pill row up and leaves the
 * composer exactly where it is. A transform would slide the panel OVER the
 * composer instead, which is the one element on screen whose position must
 * not move. One element's height, for 220ms, transient, is the trade the
 * accordion case has always made.
 *
 * ONLY those three ease (L-165). Every other cause of a height change - a row
 * arriving mid-turn, an Arrow keypress on the handle, the window or the tile
 * being resized - lands in the frame it is made. Easing them all was a
 * frequency defect rather than a taste one: a turn touching twelve files
 * would have restarted a 220ms tween twelve times and never let the frame
 * settle, which is the band L-148 and `motion-opportunities.md` R5 and R7
 * already ruled out by name.
 */
/**
 * L-165: how the slot is reaching the height it is drawing, and how it last
 * actually moved.
 *
 * Adjusted during render rather than from an effect, the same way the chip
 * beside it adjusts its pulse: the decision belongs to the commit that hands
 * motion the new value, and an effect would spend a second commit to say so.
 */
function usePanelEase(
  section: ChatDockSection,
  height: number,
  motionEnabled: boolean,
): { readonly applied: PanelMove; readonly lastMove: PanelMove } {
  const [eased, setEased] = useState<PanelEaseState>(() => ({
    section,
    height: 0,
    armed: true,
    lastMove: "ease",
  }));
  const sectionChanged = eased.section !== section;
  const heightChanged = eased.height !== height;
  const easing = sectionChanged || eased.armed;
  const applied: PanelMove = motionEnabled && easing ? "ease" : "instant";
  if (sectionChanged || heightChanged) {
    setEased({
      section,
      height,
      // The ease is spent the moment the height actually moves. A section
      // change with no measurement yet keeps it armed for the move it is
      // about to cause.
      armed: sectionChanged && !heightChanged,
      lastMove: heightChanged ? applied : eased.lastMove,
    });
  }
  return { applied, lastMove: heightChanged ? applied : eased.lastMove };
}

export function ChatDockAttachedPanelSlot(props: {
  readonly section: ChatDockSection;
  readonly panelId: string;
  /**
   * A full dock row follows this panel inside the frame, so the panel draws
   * the rule between them on its own bottom edge.
   *
   * The divider follows the panel being DRAWN (L-150), and during a collapse
   * that is still this panel - a rule owned by the row below would drop a
   * frame before the panel above it finished going. It doubles as the frame's
   * tuck payback: with no row below, the panel is the frame's last child and
   * `DOCK_FRAME_CLASS`'s `-mb-px` puts its final pixel row under the
   * composer's own background, so it pays a hairline instead of a border.
   */
  readonly separated: boolean;
  /**
   * The dock has drawn once over settled data, so an attach is news rather
   * than hydration.
   *
   * `AnimatePresence initial={false}` covers a panel present at the presence
   * root's own first render; this covers the one that is not. A chat whose
   * background pill puts the dock on screen before the snapshot arrives mounts its
   * remembered panel one commit later, and a panel that was merely RESTORED
   * must not grow - the same fact, and the same reason, as the five rings
   * L-148 removed from the pill strip.
   */
  readonly settled: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const motionEnabled = useMotionEnabled();
  const present = useIsPresent();
  const storedRatio = useSettingsStore((state) => state.chatDockPanelHeight);
  const setStoredRatio = useSettingsStore(
    (state) => state.setChatDockPanelHeight,
  );
  // The drag stays transient until release: a store write per pointermove
  // would put a `localStorage` round trip inside the drag loop, and Escape
  // would have nothing to restore to.
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const dragStart = useRef<{
    clientY: number;
    ratio: number;
    paneHeight: number;
  } | null>(null);
  // Kept so the handle cannot vanish under a pointer or a caret that is still
  // on it: raising the cap past the content is exactly the gesture that makes
  // the body stop scrolling, and L-164 takes the handle away when it does.
  const [handleFocused, setHandleFocused] = useState(false);
  // A `popLayout` ghost is out of flow, so a swap reports the INCOMING
  // panel's height the moment it commits, which is exactly the target the
  // swap should ease to.
  const { setElement, box } = usePanelBox();
  const ratio = clampChatDockPanelHeightRatio(dragRatio ?? storedRatio);
  const percent = Math.round(ratio * 100);
  const dragging = dragRatio !== null;
  // L-164: the cap is only doing something while the body is showing less
  // than it holds, so that is when the handle is offered. Five todo rows have
  // nothing to resize, and a handle that wrote `aria-valuenow`, the store and
  // `localStorage` without moving a pixel was an affordance that lied.
  const resizable = box.scrollable || dragging || handleFocused;
  const { applied, lastMove } = usePanelEase(
    props.section,
    box.height,
    motionEnabled,
  );
  const height = box.height;

  const ratioAtPointer = (clientY: number): number => {
    const start = dragStart.current;
    if (start === null) return ratio;
    if (start.paneHeight <= 0) return ratio;
    // The panel grows UPWARD: its top edge is the handle, so dragging up adds
    // height. 1:1 with the pointer, offset from where the handle was grabbed,
    // against the pane the drawn share is a share of.
    return clampChatDockPanelHeightRatio(
      start.ratio + (start.clientY - clientY) / start.paneHeight,
    );
  };
  const endDrag = (): void => {
    dragStart.current = null;
    setDragRatio(null);
  };
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    // The one layout read of the whole gesture.
    dragStart.current = {
      clientY: event.clientY,
      ratio,
      paneHeight: chatDockPanelPaneHeight(event.currentTarget),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragRatio(ratio);
  };
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (dragStart.current === null) return;
    setDragRatio(ratioAtPointer(event.clientY));
  };
  const handlePointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (dragStart.current === null) return;
    const next = ratioAtPointer(event.clientY);
    endDrag();
    setStoredRatio(next);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      endDrag();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setStoredRatio(clampChatDockPanelHeightRatio(ratio + KEYBOARD_STEP));
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setStoredRatio(clampChatDockPanelHeightRatio(ratio - KEYBOARD_STEP));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setStoredRatio(CHAT_DOCK_PANEL_MAX_HEIGHT_RATIO);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setStoredRatio(CHAT_DOCK_PANEL_MIN_HEIGHT_RATIO);
    }
  };

  const sectionName = CHAT_DOCK_SECTION_NAME[props.section];
  // Spelled out rather than keyed by `CHAT_DOCK_PANEL_HEIGHT_PROPERTY`, the
  // same way the class below spells it: a computed key is a style object the
  // design linter cannot read, and `chat-dock-panel-pane-height.test.tsx`
  // checks both spellings against that constant. Set here rather than on the
  // body, because the handle that moves it lives here and the property
  // inherits down to whichever panel is inside.
  const capStyle = {
    "--chat-dock-panel-height": chatDockPanelHeightCss(percent),
  } as CSSProperties;
  return (
    <m.div
      id={props.panelId}
      role="region"
      aria-label={sectionName}
      data-testid="chat-dock-attached-panel-slot"
      data-panel-leaving={present ? undefined : "true"}
      // The two decisions this component makes about motion, drawn where a
      // test can read them: jsdom lays nothing out, so the transition objects
      // themselves are invisible, but the choices behind them are the whole
      // of L-165 and of the presence gate.
      data-panel-motion={lastMove}
      data-panel-exit={motionEnabled ? "ease" : "instant"}
      style={capStyle}
      // `overflow-hidden` because the animated height is a CLIP: the content
      // inside keeps its own size throughout and is revealed by it.
      className="flex min-w-0 flex-col overflow-hidden"
      initial={motionEnabled && props.settled ? PANEL_COLLAPSED : false}
      animate={height > 0 ? { height, opacity: 1 } : PANEL_SHOWN_UNMEASURED}
      exit={motionEnabled ? PANEL_EXIT : PANEL_EXIT_INSTANT}
      transition={
        applied === "ease" ? PANEL_ENTER_TRANSITION : INSTANT_TRANSITION
      }
    >
      <ChatDockAttachedPanelSection section={props.section} leaving={!present}>
        {/* `shrink-0` because this child is what DECIDES the box's height:
            the observer reads it, the slot animates to what it read, and a
            child the animated box could shrink would make the measurement
            chase the animation down. */}
        <div
          ref={setElement}
          className={cn(
            "flex min-w-0 shrink-0 flex-col",
            // The rule under the panel, drawn by the panel, so it collapses
            // with it - or, with nothing below, the one pixel the frame's
            // `-mb-px` tuck takes from the panel's last row.
            props.separated ? "border-b border-border/50" : "pb-px",
          )}
        >
          {resizable ? (
            <div
              role="separator"
              tabIndex={0}
              aria-orientation="horizontal"
              aria-label={`Resize the ${sectionName} panel`}
              aria-valuemin={Math.round(CHAT_DOCK_PANEL_MIN_HEIGHT_RATIO * 100)}
              aria-valuemax={Math.round(CHAT_DOCK_PANEL_MAX_HEIGHT_RATIO * 100)}
              aria-valuenow={percent}
              aria-valuetext={`${percent}% of the chat pane`}
              data-testid="chat-dock-attached-panel-resize"
              onDoubleClick={() => {
                setStoredRatio(CHAT_DOCK_PANEL_DEFAULT_HEIGHT_RATIO);
              }}
              onKeyDown={handleKeyDown}
              onPointerCancel={endDrag}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onFocus={() => {
                setHandleFocused(true);
              }}
              onBlur={() => {
                setHandleFocused(false);
              }}
              className={cn(
                "group/dock-resize flex h-2 shrink-0 cursor-row-resize touch-none items-center justify-center outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring/60",
              )}
            >
              {/* The grip is a child rather than a border on the grab strip, so
                  the 8px target stays a target while the mark stays a hairline. */}
              <span
                aria-hidden
                className={cn(
                  "h-px w-8 rounded-full bg-foreground/20 transition-colors duration-120 ease-out",
                  "group-hover/dock-resize:bg-foreground/40 group-focus-visible/dock-resize:bg-foreground/40",
                )}
              />
            </div>
          ) : null}
          {/* The crossfade stage: `relative` so a leaving panel can lie over
              the one that replaced it, and nothing else - its height is the
              INCOMING panel's, which is what the slot eases to.

              `initial={false}` so the pill a chat remembers paints rather than
              crossfades. No `layout` prop anywhere: this box is above the
              composer, and a layout animation here would move the input. The
              presence root is mounted whatever the motion gate says and only
              its exit VALUE is switched, so a pane going invisible cannot
              reconcile a different element here and destroy the open panel. */}
          <div className="relative min-w-0">
            <AnimatePresence initial={false}>
              <ChatDockAttachedPanelContent
                key={props.section}
                section={props.section}
                motionEnabled={motionEnabled}
              >
                {props.children}
              </ChatDockAttachedPanelContent>
            </AnimatePresence>
          </div>
        </div>
      </ChatDockAttachedPanelSection>
    </m.div>
  );
}
