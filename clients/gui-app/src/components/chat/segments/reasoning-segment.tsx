import { Shimmer } from "@/components/ui/shimmer";
import { useChatMeasuredBooleanToggle } from "@/components/chat/chat-measured-item-change-context";
import { formatClockDuration } from "@/lib/format-duration";
import { cn } from "@/lib/utils";
import { TraycerMarkdown } from "@/markdown";
import { Brain, ChevronRight } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface ReasoningSegmentProps {
  findUnitId: string | null;
  markdown: string;
  isStreaming: boolean;
  durationMs: number | null;
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
        isStreaming={isStreaming}
      >
        {markdown}
      </TraycerMarkdown>
    </div>
  );
}

export function ReasoningSegment(props: ReasoningSegmentProps) {
  const { findUnitId, markdown, isStreaming, durationMs } = props;
  // `expanded` shows the full trace. Default (false) means the streaming tail
  // preview while thinking, or the collapsed "Thought for Xs" line once done. A
  // click toggles and sticks for the segment's lifetime.
  const [expanded, setExpanded] = useState(false);
  const toggle = useChatMeasuredBooleanToggle(setExpanded);
  const bodyId = useId();

  // Make the body itself a click target so clicking anywhere on the block (not
  // just the header chevron) toggles - including a re-click to collapse. A
  // native listener (vs a JSX onClick) keeps the body a non-interactive,
  // selectable element: the header button is the keyboard/assistive-tech
  // control, and a click that ends a text selection (click-drag) must not
  // collapse the trace, so reasoning stays copyable.
  const bindBodyToggle = useCallback(
    (node: HTMLDivElement | null) => {
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
      return () => node.removeEventListener("click", onClick);
    },
    [toggle],
  );

  const showTail = isStreaming && !expanded;
  const bodyShown = isStreaming || expanded;
  const label = isStreaming ? "Thinking" : reasoningSummaryLabel(durationMs);

  let body: ReactNode = null;
  if (bodyShown) {
    body = (
      // Indented with a left rail, mirroring an expanded activity group's body
      // (`ml-5 border-l pl-3`), while the header title stays flush with the
      // other tool/activity titles above.
      <div
        id={bodyId}
        ref={bindBodyToggle}
        className={cn(
          "mt-0.5 ml-5 border-l border-border/35 pl-3",
          showTail && "cursor-pointer",
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

  return (
    <div className="text-ui-sm text-muted-foreground">
      <button
        type="button"
        data-find-include="true"
        data-chat-find-unit={findUnitId ?? undefined}
        onClick={toggle}
        aria-expanded={expanded}
        aria-controls={bodyShown ? bodyId : undefined}
        className={cn(
          "group/reasoning flex max-w-full items-center gap-2 overflow-hidden rounded-md py-1 pr-1 text-left text-ui-sm text-muted-foreground transition-colors",
          "hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
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
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 -translate-x-1 text-muted-foreground/65 opacity-0 transition-[opacity,transform,color]",
            "group-hover/reasoning:translate-x-0 group-hover/reasoning:text-foreground group-hover/reasoning:opacity-100",
            "group-focus-visible/reasoning:translate-x-0 group-focus-visible/reasoning:text-foreground group-focus-visible/reasoning:opacity-100",
            expanded && "translate-x-0 rotate-90 text-foreground opacity-100",
          )}
          aria-hidden
        />
      </button>
      {body}
    </div>
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

function reasoningSummaryLabel(durationMs: number | null): string {
  if (durationMs === null) return "Thought";
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return `Thought for ${formatClockDuration(seconds)}`;
}
