import { Shimmer } from "@/components/ui/shimmer";
import { reasoningBlockLabel } from "@/components/chat/chat-activity-groups";
import { useLiveActivityPromote } from "./live-activity-promote-context";
import { cn } from "@/lib/utils";
import { TraycerMarkdown } from "@/markdown";
import { Brain, ChevronRight } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";

interface ReasoningSegmentProps {
  findUnitId: string | null;
  markdown: string;
  isStreaming: boolean;
  durationMs: number | null;
  /**
   * The container already caps this block's height and follows its tail, so it
   * must not add a `ReasoningTail` of its own - a second `overflow-y-auto`
   * nested inside the first would fight it for the wheel and give the reader
   * two scroll positions to reconcile. Set by the live activity window.
   *
   * Everything else is unchanged: the header row, the "Thinking" /
   * "Thought for Xs" label, the collapse on completion, the find anchor. The
   * window is a viewport onto exactly the rows the expanded group shows, not a
   * different rendering of them.
   */
  bodyBoundedByParent: boolean;
  /**
   * Render the trace with no header row of its own. Set when this is the
   * group's ONLY reasoning block, where the group header's thinking clause is
   * this block's label verbatim and the row simply said it twice.
   *
   * Headerless implies the body is always shown - with no header there is no
   * control to re-open it, so a hidden body would leave the row rendering
   * literally nothing. It does NOT imply the full trace: a streaming headerless
   * block still previews through `ReasoningTail`, or an open group would grow
   * an unbounded thought under the reader.
   *
   * This flips true -> false when a second segment joins a live run, and the
   * block then collapses to its header like every other completed one. That is
   * deliberate: showing the trace was a consequence of having nowhere else to
   * put it, NOT a disclosure the reader asked for, and carrying it across left
   * the first thought of every run permanently expanded. A trace the reader DID
   * open survives the flip on `expanded`, which is the only signal that means
   * intent.
   *
   * The flip NEVER runs the other way for a header the reader has SEEN, and
   * that is enforced by the caller rather than being a property of how runs
   * grow - runs shrink too. See `headedIds` on the activity-group open store:
   * without it a backgrounded command leaving the group would strip this header
   * again and unfold a completed trace nobody touched. A group that arrives
   * already reduced, having shown no header, is unheaded here and correctly so.
   */
  headerless: boolean;
  /**
   * Seeds the disclosure at mount, once: set for the row a live-window promote
   * asked to reveal, since opening it is what that click was for.
   */
  initiallyExpanded: boolean;
}

interface ReasoningContentProps {
  markdown: string;
  className: string;
  isStreaming: boolean;
}

// `.md-prose` pins the prose body/heading/bold colors to `--color-foreground`,
// so a wrapper `text-muted-foreground` can't reach the markdown. Re-point the
// prose color tokens (regular + `dark:prose-invert`) at the muted token so the
// thinking text reads as secondary, like a tool-call summary.
const MUTED_PROSE = cn(
  "[--tw-prose-body:var(--color-muted-foreground)]",
  "[--tw-prose-invert-body:var(--color-muted-foreground)]",
  "[--tw-prose-headings:var(--color-muted-foreground)]",
  "[--tw-prose-invert-headings:var(--color-muted-foreground)]",
  "[--tw-prose-bold:var(--color-muted-foreground)]",
  "[--tw-prose-invert-bold:var(--color-muted-foreground)]",
);

function ReasoningContent(props: ReasoningContentProps) {
  const { className, markdown, isStreaming } = props;
  return (
    <div className={className}>
      <TraycerMarkdown
        className={MUTED_PROSE}
        proseSize="compact"
        components={null}
        remarkPlugins={null}
        rehypePlugins={null}
        quotable={false}
        isStreaming={isStreaming}
      >
        {markdown}
      </TraycerMarkdown>
    </div>
  );
}

export function ReasoningSegment(props: ReasoningSegmentProps) {
  const { findUnitId, markdown, isStreaming, durationMs, bodyBoundedByParent } =
    props;
  const { headerless, initiallyExpanded } = props;
  // `expanded` shows the full trace. Default (false) means the streaming tail
  // preview while thinking, or the collapsed "Thought for Xs" line once done. A
  // click toggles and sticks for the segment's lifetime.
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const promote = useLiveActivityPromote();
  const toggle = useCallback((): void => {
    // Inside the live window a disclosure would open into four line-heights, so
    // the click leaves the window instead: the group opens and this block is
    // the row it reveals, expanded.
    if (promote !== null) {
      promote();
      return;
    }
    setExpanded((current) => !current);
  }, [promote]);
  const bodyId = useId();

  // Make the body itself a click target so clicking anywhere on the block (not
  // just the header chevron) toggles - including a re-click to collapse. A
  // native listener (vs a JSX onClick) keeps the body a non-interactive,
  // selectable element: the header button is the keyboard/assistive-tech
  // control, and a click that ends a text selection (click-drag) must not
  // collapse the trace, so reasoning stays copyable.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bindBodyToggle = useCallback(
    (node: HTMLDivElement | null) => {
      bodyRef.current = node;
      if (node === null) return;
      const onClick = () => {
        const selection = window.getSelection();
        // Suppress the toggle only when the click ends a text selection *within
        // this block* (drag-to-copy); a stray selection elsewhere on the page
        // must not swallow the click.
        if (
          selection !== null &&
          !selection.isCollapsed &&
          selection.anchorNode !== null &&
          node.contains(selection.anchorNode)
        ) {
          return;
        }
        toggle();
      };
      node.addEventListener("click", onClick);
      return () => {
        node.removeEventListener("click", onClick);
        // Clear the ref too, or it keeps a detached node alive and the focus
        // handoff calls `.focus()` on an element that is no longer in the
        // document - a silent no-op that looks like a working rescue.
        if (bodyRef.current === node) bodyRef.current = null;
      };
    },
    [toggle],
  );

  // The tail preview is this block's OWN bounded scroller. Inside a container
  // that already bounds and pins it, that scroller is not just redundant but
  // harmful - two nested `overflow-y-auto`s fighting for one wheel - so the
  // body renders in full and the container does the capping.
  const showTail = isStreaming && !expanded && !bodyBoundedByParent;
  // `headerless` shows the body on its own terms, not through `expanded`: with
  // no header row there is nothing else to render, and a closed body would make
  // the block disappear from the transcript entirely. `showTail` above is
  // deliberately NOT given the same treatment - a headerless block still
  // previews rather than dumping a growing trace into an open group.
  const bodyShown = headerless || isStreaming || expanded;
  const label = reasoningBlockLabel(isStreaming, durationMs);

  let body: ReactNode = null;
  if (bodyShown) {
    body = (
      // NO rail of its own. Every container that renders reasoning already
      // draws one (`ml-5 border-l pl-3` on the live window's scroller and on
      // the expanded group's body), and adding a second put two vertical lines
      // side by side down the whole trace.
      //
      // `ml-6` puts the trace just past its own icon, so it reads as belonging
      // to this row rather than to the group - and lands in the same column
      // whether or not this block drew a header of its own.
      <div
        id={bodyId}
        ref={bindBodyToggle}
        // Focusable only programmatically, as the landing spot when the header
        // control disappears on completion. Not a tab stop - but it IS named and
        // ringed, because a caret arriving on an anonymous div announces nothing
        // and shows nothing, which is barely better than losing it.
        tabIndex={-1}
        role="group"
        aria-label={label}
        className={cn(
          "mt-0.5 ml-6 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          (showTail || promote !== null) && "cursor-pointer",
        )}
      >
        {showTail ? (
          <ReasoningTail markdown={markdown} />
        ) : (
          <ReasoningContent
            markdown={markdown}
            className="py-1 text-ui-sm leading-6 text-muted-foreground"
            isStreaming={isStreaming}
          />
        )}
      </div>
    );
  }

  // Dropping the header drops the block's ONLY button - the body is a
  // deliberately non-interactive div (see `bindBodyToggle`), so a pointer can
  // click it and a keyboard cannot reach it at all. Where there is still
  // something behind that click - a promote out of the live window, or a
  // streaming tail that hides the rest of the trace - the header stays in the
  // tree and is hidden visually instead, surfacing on focus.
  //
  // When there is nothing left to disclose (a finished headerless block already
  // shows its whole trace) there is no control to miss, and a focusable element
  // that does nothing is worse than none.
  //
  // `expanded && isStreaming` is in here because expanding is what REMOVES the
  // tail: without it the control destroyed itself on activation - the button
  // unmounted under the caret, focus fell to the body, the resulting
  // `aria-expanded` was never announced, and there was no way back to the
  // bounded preview. A disclosure has to survive its own disclosure.
  //
  // `isStreaming` is the other half. Once the block completes there is no tail
  // to collapse back to and a headerless body shows in full either way, so a
  // bare `expanded` left a button that announced `aria-expanded="true"`, changed
  // no pixels when pressed, and then deleted itself. A control has to survive
  // its disclosure AND be worth pressing.
  const headerActionable =
    promote !== null || showTail || (expanded && isStreaming);
  // When a HEADERLESS block completes, its hidden control legitimately
  // disappears - and it may be holding the caret, so focus would drop to
  // `document.body`, the top of the transcript. Hand it to the trace instead.
  //
  // `headerless &&` is load-bearing: a HEADED block keeps its button through the
  // same transition, and moving focus out of a control that is still sitting
  // there takes away the reader's Space/Enter route and relocates them for no
  // visible reason. Gate on the control actually going away, not on it becoming
  // inert.
  //
  // Tracked on focus/blur rather than read from `document.activeElement` after
  // the fact, because by then the button is gone and the answer is always
  // "body". The `activeElement` check below is the opposite guard: an effect
  // runs after commit, and if the reader moved focus somewhere deliberately in
  // between, that is theirs to keep.
  //
  // The blur only clears the latch when focus went somewhere REAL. Whether an
  // engine dispatches `blur` for an element removed while focused is not
  // settled - Chromium does, and jsdom does not - so clearing on every blur
  // would let removal cancel the handoff it is supposed to trigger, silently,
  // in the browser this actually ships in, with every test still green.
  // `relatedTarget` is what separates the two: a reader who tabbed or clicked
  // away hands focus to an element, removal hands it to nothing.
  const headerFocusedRef = useRef(false);
  const onHeaderFocus = useCallback((): void => {
    headerFocusedRef.current = true;
  }, []);
  const onHeaderBlur = useCallback(
    (event: FocusEvent<HTMLButtonElement>): void => {
      if (event.relatedTarget === null) return;
      headerFocusedRef.current = false;
    },
    [],
  );
  const controlRemoved = headerless && !headerActionable;
  useEffect(() => {
    if (!controlRemoved || !headerFocusedRef.current) return;
    headerFocusedRef.current = false;
    if (document.activeElement !== document.body) return;
    bodyRef.current?.focus({ preventScroll: true });
  }, [controlRemoved]);
  return (
    <div className="text-ui-sm text-muted-foreground">
      {headerless && !headerActionable ? null : (
        <ReasoningHeader
          findUnitId={findUnitId}
          label={label}
          isStreaming={isStreaming}
          expanded={expanded}
          controlsId={bodyShown ? bodyId : null}
          promotes={promote !== null}
          visuallyHidden={headerless}
          onToggle={toggle}
          onFocus={onHeaderFocus}
          onBlur={onHeaderBlur}
        />
      )}
      {body}
    </div>
  );
}

interface ReasoningHeaderProps {
  readonly findUnitId: string | null;
  readonly label: string;
  readonly isStreaming: boolean;
  readonly expanded: boolean;
  /** The body this button discloses, or null while there is no body to point at. */
  readonly controlsId: string | null;
  /**
   * The click leaves the live window instead of opening anything here, so the
   * button drops `aria-expanded` entirely rather than reporting a disclosure
   * state it does not control. `PromotingSegmentRow` makes the same call.
   */
  readonly promotes: boolean;
  /**
   * Present for keyboard and assistive tech, absent to the eye until focused.
   * Set for a headerless block, whose visible duplicate of the group label is
   * exactly what the row was dropped to avoid - but whose CONTROL still has to
   * exist, because the body cannot be one.
   */
  readonly visuallyHidden: boolean;
  readonly onToggle: () => void;
  readonly onFocus: () => void;
  readonly onBlur: (event: FocusEvent<HTMLButtonElement>) => void;
}

// State-AWARE, because this control toggles. Naming it "show the full
// reasoning" while it reported `aria-expanded="true"` described the opposite of
// what pressing it would do: collapse back to the bounded preview.
function hiddenHeaderActionLabel(
  label: string,
  promotes: boolean,
  expanded: boolean,
): string {
  if (promotes) return `${label} - open in the full activity view`;
  if (expanded) return `${label} - collapse to the preview`;
  return `${label} - show the full reasoning`;
}

function ReasoningHeader(props: ReasoningHeaderProps) {
  const { findUnitId, label, isStreaming, expanded, controlsId } = props;
  const { visuallyHidden, promotes } = props;
  return (
    <button
      type="button"
      data-activity-row-trigger=""
      // A visually hidden header is not a find anchor: the projection already
      // skips the unit for it (`hidesSoleReasoningHeader`, shared), and a match
      // painted onto an `sr-only` element would highlight nothing. Its text is
      // in the index once, on the group summary that repeats it.
      data-find-include={visuallyHidden ? undefined : "true"}
      data-find-skip={visuallyHidden ? "" : undefined}
      data-chat-find-unit={findUnitId ?? undefined}
      onClick={props.onToggle}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      // A hidden control sits next to the group's own trigger, which carries the
      // SAME label - so on name alone a screen reader hears "Thinking, button"
      // twice with nothing to tell them apart, and this one deliberately has no
      // `aria-expanded` to hint at what it does. Spell the action out. A visible
      // header needs none of this: it is where it is, next to what it opens.
      aria-label={
        visuallyHidden
          ? hiddenHeaderActionLabel(label, promotes, expanded)
          : undefined
      }
      // Both dropped together in promotion mode, for one reason: this click
      // leaves the live window rather than disclosing anything here. Keeping
      // `aria-controls` while dropping `aria-expanded` was half a claim - it
      // named an element as this button's disclosure target and then declined
      // to report its state, so assistive tech was pointed at a body whose
      // visibility the button does not own.
      aria-expanded={promotes ? undefined : expanded}
      aria-controls={promotes ? undefined : (controlsId ?? undefined)}
      className={cn(
        "group/reasoning flex max-w-full items-center gap-2 overflow-hidden rounded-md px-1 py-1 text-left text-ui-sm text-muted-foreground transition-colors",
        "hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        visuallyHidden && "sr-only focus:not-sr-only",
      )}
    >
      {/* No leading glyph, and `px-1` to match `SegmentRow`: every row in a
          group - thinking, tool, command - now starts its icon in the same
          column, with the caret trailing on hover. `SegmentRow` owns the other
          half of that pairing; change the two together or the lists drift out
          of line again. */}
      <Brain className="size-3.5 shrink-0 transition-colors" aria-hidden />
      {isStreaming ? (
        <Shimmer
          as="span"
          className={cn(
            "min-w-0 truncate font-medium",
            "[--shimmer-text-color:var(--color-muted-foreground)]",
            "group-hover/reasoning:[--shimmer-text-color:var(--color-foreground)]",
            "group-focus-visible/reasoning:[--shimmer-text-color:var(--color-foreground)]",
            expanded && "[--shimmer-text-color:var(--color-foreground)]",
          )}
          duration={1.35}
          spread={1}
        >
          {label}
        </Shimmer>
      ) : (
        <span className="min-w-0 truncate font-medium transition-colors">
          {label}
        </span>
      )}
      {/* Trailing, and hidden until the row is hovered/focused/open - the
          leading always-on caret it replaces sat next to the Brain icon and
          read as two glyphs competing to be the row's marker. */}
      <ChevronRight
        // Named so the alignment tests can find it without walking
        // `lastElementChild`, which any new wrapper or sibling silently breaks.
        data-row-caret=""
        className={cn(
          "size-3.5 shrink-0 -translate-x-1 text-muted-foreground/65 opacity-0 transition-[opacity,transform,color]",
          "group-hover/reasoning:translate-x-0 group-hover/reasoning:text-foreground group-hover/reasoning:opacity-100",
          "group-focus-visible/reasoning:translate-x-0 group-focus-visible/reasoning:text-foreground group-focus-visible/reasoning:opacity-100",
          expanded && "translate-x-0 rotate-90 text-foreground opacity-100",
        )}
        aria-hidden
      />
    </button>
  );
}

/**
 * Fixed-height window that shows the last few lines of reasoning and stays
 * pinned to the newest text as deltas stream in - a calm "tail" preview rather
 * than the whole growing trace. The top edge fades so older lines dissolve
 * upward instead of hard-clipping.
 */
function ReasoningTail({ markdown }: { readonly markdown: string }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Stays true while the window hugs the newest text; a manual scroll up (to
  // read an earlier line) suspends auto-pinning until the user returns to the
  // bottom.
  const pinnedRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
  }, []);

  // Live external sync (browser scroll position ↔ streaming text): keep the
  // clipped window pinned to the bottom as new reasoning arrives, unless the
  // user scrolled up to read. The top-fade is gated on a measured `overflowing`
  // data attribute (set imperatively, not via state, so the measurement doesn't
  // force an extra render) - otherwise the gradient would dim the first line of
  // a short or just-started reasoning into near-invisibility.
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    el.dataset.overflowing = String(el.scrollHeight - el.clientHeight > 1);
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [markdown]);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      data-testid="reasoning-tail"
      className={cn(
        "max-h-[7.5rem] overflow-y-auto py-1 text-ui-sm leading-6 text-muted-foreground",
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        "data-[overflowing=true]:[-webkit-mask-image:linear-gradient(to_bottom,transparent,black_1.25rem)]",
        "data-[overflowing=true]:[mask-image:linear-gradient(to_bottom,transparent,black_1.25rem)]",
      )}
    >
      {/* The tail preview only renders while the reasoning streams. */}
      <ReasoningContent markdown={markdown} className="" isStreaming />
    </div>
  );
}
