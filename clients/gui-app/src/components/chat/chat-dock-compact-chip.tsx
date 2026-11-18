import { createContext, useContext, useState, type ReactNode } from "react";
import { DiffLineDeltas } from "@/components/chat/diff-line-deltas";
import { RollingNumber } from "@/components/ui/rolling-number";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { DiffLineCounts } from "@/lib/file-change-diff-hunks";
import { cn } from "@/lib/utils";

/**
 * The prefix on a `pulseToken` whose ARRIVAL is a failure, so the chip's ring
 * radiates the destructive role instead of the primary one.
 *
 * It rides the token rather than a second prop because the two are the same
 * fact: what the pill is standing in for right now, as one comparable value.
 * A separate flag could disagree with the token - a failure flavour set while
 * the token did not change would never ring at all, since the ring fires on
 * the token CHANGING. Prefixed rather than enumerated so the identity of the
 * failed thing stays inside the token, which is what makes a second failure
 * ring again.
 */
export const CHAT_DOCK_FAILURE_PULSE_PREFIX = "failed:";

/**
 * True while the surrounding strip is drawing its FIRST commit, so a chip that
 * exists only because a chat was opened does not ring for it.
 *
 * A context rather than a prop because the fact belongs to the strip and the
 * question is asked by every chip in it; the pictures in the layout editor
 * draw a chip with no strip at all and want the honest default, which is "this
 * chip's arrival is real news".
 *
 * Read once, in the chip's `useState` initializer: a chip that genuinely
 * arrives later is mounted after the strip has settled and sees `false`, and a
 * chip that was there at the first paint can never be un-suppressed by the
 * flip that follows, because the initializer does not run again.
 */
const ChipArrivalSuppressedContext = createContext(false);

export function ChatDockChipArrival(props: {
  readonly suppressed: boolean;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <ChipArrivalSuppressedContext.Provider value={props.suppressed}>
      {props.children}
    </ChipArrivalSuppressedContext.Provider>
  );
}

/**
 * The two lines above a pill's click affordance: what the member is called,
 * and what it counts (L-153).
 */
export interface ChatDockChipTooltipLines {
  /** The member's own name, from `CHAT_DOCK_SECTION_NAME`. */
  readonly name: string;
  /** Its counts: "3 files, +47 −9", "2 of 5 done", "2 running · 1 held". */
  readonly detail: string;
}

/**
 * The short forms whose numbers roll: one count (`3`), or two with a fixed
 * separator between them (`2 · 1`, `2/5`).
 *
 * Anything else is printed exactly as it stands. A roll is only correct when
 * the thing that changed IS the number and the rest of the string is
 * furniture, so `99+` and `+1 −2` fall through to plain text rather than being
 * parsed into pieces the caller never meant to expose.
 */
const CHIP_COUNTS = /^(\d+)(?:( · |\/)(\d+))?$/;

/**
 * The pill's count, rolling on a change, with the separator static between two
 * of them.
 */
function ChipCounts(props: { readonly text: string }): ReactNode {
  const match = CHIP_COUNTS.exec(props.text);
  if (match === null) return props.text;
  // The second half is one optional group, so both of these are absent for a
  // one-count pill. `at` rather than an index because indexing a capture array
  // is typed as always present, which is exactly what is not true here.
  const separator = match.at(2);
  const second = match.at(3);
  return (
    <>
      <RollingNumber
        value={Number(match[1])}
        className={undefined}
        testId={undefined}
      />
      {second === undefined ? null : (
        <>
          {separator}
          <RollingNumber
            value={Number(second)}
            className={undefined}
            testId={undefined}
          />
        </>
      )}
    </>
  );
}

/**
 * A pill's tooltip: what it is, what it counts, and what a click will do
 * (L-153).
 *
 * Three lines in one small block, in falling weight, because they answer three
 * different questions and only the first is always needed. The name is the
 * member's own, so someone who cannot tell the file-diff glyph from the
 * background one gets the word. The counts are the pill's own two
 * measurements, spelled the way the pill spells them. The affordance is last
 * and quietest - it is the least new information on screen once you have
 * hovered a pill twice - and it follows `aria-pressed` rather than restating
 * it, so the open pill offers to close and never the other way round.
 *
 * One flex column inside the tooltip rather than three children of it:
 * `TooltipContent` is a row (`inline-flex items-center`), so three siblings
 * would become three columns and each would wrap into a ribbon - the same
 * trap `git-watcher-status-notice.tsx` records. Toned against `background`
 * rather than `muted-foreground`, because this surface is INVERSE.
 */
function ChatDockChipTooltip(props: {
  readonly lines: ChatDockChipTooltipLines;
  readonly expanded: boolean;
}): ReactNode {
  return (
    <span className="flex w-full flex-col gap-0.5 text-left">
      <span className="font-medium">{props.lines.name}</span>
      <span className="text-background/70">{props.lines.detail}</span>
      <span className="text-background/55">
        {props.expanded ? "Click to close" : "Click to open"}
      </span>
    </span>
  );
}

interface ChatDockCompactChipProps {
  /** Icon only - the sentence a screen reader gets is `label`. */
  readonly icon: ReactNode;
  /** The short form: `3`, `2 · 1`. Never a sentence. */
  readonly text: string;
  /**
   * True while this section has something in flight. Here it tones the number
   * `primary`; the rest of the live treatment belongs to `icon`.
   *
   * Nothing is printed for it. A chip is `[icon] N` at every width - the word
   * that used to follow the number (`1 running`) is gone, along with the
   * container query that folded it away on a narrow composer. `label` is where
   * the state is still said in words.
   */
  readonly working: boolean;
  /**
   * Added and removed lines to print after the short form, in the same tones
   * the accumulated-changes panel gives them, or `null` for a chip that counts
   * one thing only. Drawn from the shared component, so the chip and the panel
   * it stands for can never disagree on a colour or on how a zero reads.
   */
  readonly lineDeltas: DiffLineCounts | null;
  /**
   * The whole sentence the short form stands for - what the row is, and what
   * its number means ("Active agents. 3 running."). It is the chip's accessible
   * name.
   *
   * Deliberately NOT "…Show the active agents.": this is a toggle, `expanded`
   * puts the state on `aria-pressed`, and a verb baked into the name would be
   * announced as "show" at the exact moment the next click hides. Name the
   * thing; let the button role and the pressed state carry the action.
   */
  readonly label: string;
  /**
   * The two lines above the click affordance in this chip's tooltip, or
   * `null` for a chip that has none.
   *
   * `null` is what the layout editor's form passes: it draws these chips as
   * PICTURES (`region-depiction.tsx`), with no strip behind them, no counts
   * and an `onClick` that does nothing, so a tooltip reading "Click to open"
   * under one would be a lie. Those chips keep the one-line accessible
   * sentence this component has always shown.
   */
  readonly tooltipLines: ChatDockChipTooltipLines | null;
  /**
   * What the chip is standing in for, right now, as one comparable token. The
   * chip pulses once whenever it ARRIVES at a non-null value - including the
   * first render, which is the case that matters: a chip exists only while its
   * section has something to show, so "the first agent started" and "this chip
   * mounted" are the same instant.
   *
   * `null` is a resting state worth no eye-flick, so a count going 0 → 2 pulses
   * and 2 → 0 does not. A chip whose mere existence IS the news passes a
   * constant, which fires on arrival and never again.
   *
   * A token beginning {@link CHAT_DOCK_FAILURE_PULSE_PREFIX} rings in the
   * destructive tone instead of the primary one.
   */
  readonly pulseToken: string | null;
  /**
   * True while this pill's panel is the one attached above the composer, so
   * the pill reads as selected.
   *
   * A pressed TOGGLE rather than a tab, deliberately. `role="tab"` promises a
   * set where exactly one member is always selected and arrow keys move
   * between them; this set can be fully closed (clicking the open pill closes
   * it), it sits in a composer where Tab order is precious, and it stands
   * beside FULL rows that are not tabs at all. `aria-pressed` says what is
   * true - this pill is on - and `controls` supplies the relationship a tab
   * strip would have carried.
   */
  readonly expanded: boolean;
  /** The attached panel's DOM id while this pill is open, else `null`. */
  readonly controls: string | null;
  readonly testId: string;
  readonly onClick: () => void;
}

interface PulseState {
  readonly token: string | null;
  readonly pulsing: boolean;
}

/**
 * The `data-pulse` value for this commit, or `undefined` for a chip at rest.
 *
 * The two literals live HERE and nowhere else: `dock-chip-ring-css.test.ts`
 * reads the values a chip can write out of this function and checks the
 * stylesheet animates every one of them, and a value no rule animates never
 * fires `animationend`, which is what takes the attribute back off.
 */
function pulseAttribute(
  pulsing: boolean,
  failure: boolean,
): string | undefined {
  if (!pulsing) return undefined;
  return failure ? "failure" : "true";
}

/**
 * The compact stand-in for one dock row, in the strip under the input.
 *
 * A row set to `compact` in Layout ▸ Composer is not gone - it is here, folded
 * to its icon and its number, and one click puts it back. That is why the chip
 * is a toggle rather than a link: the row it opens has no other door once it is
 * out of the dock, so the way back has to be the thing that opened it.
 *
 * The pulse is CSS. The attribute goes on when the token changes and comes off
 * on `animationend`, so a chip that is never looked at costs one class-name
 * flip and no timer - and the browser's reduced-motion collapse still ends the
 * animation, which is what clears the attribute.
 *
 * It fires on ARRIVAL, and opening a chat is not one: five pills reaching
 * their first paint together rang five rings at once beside the input, for
 * nothing that had happened. {@link ChatDockChipArrival} is how the strip says
 * "this commit is the chat opening"; every later arrival still rings.
 */
export function ChatDockCompactChip(props: ChatDockCompactChipProps) {
  const arrivalSuppressed = useContext(ChipArrivalSuppressedContext);
  const tooltipLines = props.tooltipLines;
  const [pulse, setPulse] = useState<PulseState>(() => ({
    token: props.pulseToken,
    pulsing: !arrivalSuppressed && props.pulseToken !== null,
  }));
  // Adjust state during render rather than from an effect: the pulse belongs to
  // the same commit the new count paints in, and an effect would spend a second
  // commit to say so.
  if (pulse.token !== props.pulseToken) {
    setPulse({ token: props.pulseToken, pulsing: props.pulseToken !== null });
  }
  const failurePulse =
    pulse.token !== null &&
    pulse.token.startsWith(CHAT_DOCK_FAILURE_PULSE_PREFIX);

  return (
    <TooltipWrapper
      label={
        tooltipLines === null ? (
          props.label
        ) : (
          <ChatDockChipTooltip lines={tooltipLines} expanded={props.expanded} />
        )
      }
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        aria-label={props.label}
        aria-pressed={props.expanded}
        aria-controls={props.controls ?? undefined}
        data-testid={props.testId}
        data-chat-dock-chip
        data-pulse={pulseAttribute(pulse.pulsing, failurePulse)}
        onAnimationEnd={() => {
          setPulse((current) => ({ token: current.token, pulsing: false }));
        }}
        onClick={props.onClick}
        className={cn(
          // The artifact's `.dchip` (A13), spelled in the same vocabulary the
          // composer toolbar's chips now use (`toolbar-buttons.tsx`): one
          // bordered material on the app's own background, `hover` and
          // `focus-visible` landing on `accent`, a `scale-97` press that
          // reduced motion cancels. A dock chip is the round one - it counts a
          // thing rather than opening a menu - so it is a pill, not a square.
          "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-border bg-background px-2.5 text-ui-xs whitespace-nowrap outline-none transition-[background-color,border-color,color,transform] duration-120 ease-out",
          "text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-97",
          "motion-reduce:transition-none motion-reduce:active:scale-100",
          // The pressed state has to read against a BORDER, not only against
          // the page: a fill alone is what made the borderless chip's toggle
          // legible, and on a bordered pill it reads as a hover that stuck.
          props.expanded && "border-foreground/25 bg-accent text-foreground",
        )}
      >
        {props.icon}
        <span
          data-chip-count
          className={cn(
            // The number is the chip's content, so it takes the foreground
            // while the glyph and the frame stay muted (`.dc-n`, A.1).
            "font-mono text-code-xs tabular-nums text-foreground",
            props.working && "text-primary",
          )}
        >
          {/* The tone is on this span and never on the rolling number, which
              carries no colour of its own: `color` inherits, and it inherits
              across the shadow boundary the animated element draws inside. */}
          <ChipCounts text={props.text} />
        </span>
        {/* Gated here rather than inside the component: the panel's header
            and rows keep an empty counts span so their row geometry does not
            twitch as summaries land, but on a chip it would be a bare `gap-1`
            of nothing after the number. */}
        {props.lineDeltas === null ||
        (props.lineDeltas.additions === 0 &&
          props.lineDeltas.deletions === 0) ? null : (
          <DiffLineDeltas
            counts={props.lineDeltas}
            className="tabular-nums"
            rolling
          />
        )}
      </button>
    </TooltipWrapper>
  );
}
