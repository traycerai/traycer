import { useState, type ReactNode } from "react";
import { DiffLineDeltas } from "@/components/chat/diff-line-deltas";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { DiffLineCounts } from "@/lib/file-change-diff-hunks";
import { cn } from "@/lib/utils";

interface ChatDockCompactChipProps {
  /** Icon only - the sentence a screen reader gets is `label`. */
  readonly icon: ReactNode;
  /** The short form: `3`, `2 · 1`. Never a sentence. */
  readonly text: ReactNode;
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
   * What the chip is standing in for, right now, as one comparable token. The
   * chip pulses once whenever it ARRIVES at a non-null value - including the
   * first render, which is the case that matters: a chip exists only while its
   * section has something to show, so "the first agent started" and "this chip
   * mounted" are the same instant.
   *
   * `null` is a resting state worth no eye-flick, so a count going 0 → 2 pulses
   * and 2 → 0 does not. A chip whose mere existence IS the news passes a
   * constant, which fires on arrival and never again.
   */
  readonly pulseToken: string | null;
  /** True while this chip's row is showing, so the chip reads as a toggle. */
  readonly expanded: boolean;
  readonly testId: string;
  readonly onClick: () => void;
}

interface PulseState {
  readonly token: string | null;
  readonly pulsing: boolean;
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
 */
export function ChatDockCompactChip(props: ChatDockCompactChipProps) {
  const [pulse, setPulse] = useState<PulseState>(() => ({
    token: props.pulseToken,
    pulsing: props.pulseToken !== null,
  }));
  // Adjust state during render rather than from an effect: the pulse belongs to
  // the same commit the new count paints in, and an effect would spend a second
  // commit to say so.
  if (pulse.token !== props.pulseToken) {
    setPulse({ token: props.pulseToken, pulsing: props.pulseToken !== null });
  }

  return (
    <TooltipWrapper
      label={props.label}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <button
        type="button"
        aria-label={props.label}
        aria-pressed={props.expanded}
        data-testid={props.testId}
        data-chat-dock-chip
        data-pulse={pulse.pulsing ? "true" : undefined}
        onAnimationEnd={() => {
          setPulse((current) => ({ token: current.token, pulsing: false }));
        }}
        onClick={props.onClick}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-ui-xs whitespace-nowrap outline-none transition-colors",
          "text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:bg-accent/50 focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
          props.expanded && "bg-accent/40 text-foreground",
        )}
      >
        {props.icon}
        <span
          className={cn(
            "font-mono text-code-xs tabular-nums",
            props.working && "text-primary",
          )}
        >
          {props.text}
        </span>
        {/* Gated here rather than inside the component: the panel's header
            and rows keep an empty counts span so their row geometry does not
            twitch as summaries land, but on a chip it would be a bare `gap-1`
            of nothing after the number. */}
        {props.lineDeltas === null ||
        (props.lineDeltas.additions === 0 &&
          props.lineDeltas.deletions === 0) ? null : (
          <DiffLineDeltas counts={props.lineDeltas} className="tabular-nums" />
        )}
      </button>
    </TooltipWrapper>
  );
}
