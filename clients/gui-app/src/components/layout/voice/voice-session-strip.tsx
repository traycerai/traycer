import { useEffect, useState, type ReactNode } from "react";
import { Captions, Mic, MicOff } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useVoiceFocusLabel } from "@/hooks/voice/use-voice-focus-label";
import { VoiceOutcomeLine } from "@/components/layout/voice/voice-ended-line";
import { VoiceWaitingControl } from "@/components/layout/voice/voice-waiting-control";
import { useOpenBotChannel } from "@/hooks/bots/use-open-bot-channel";
import { cn } from "@/lib/utils";
import { reportVoiceMiss } from "@/lib/voice/miss-report";
import {
  useVoiceSessionStore,
  type VoiceFocus,
  type VoicePhase,
} from "@/stores/voice/voice-session-store";

/**
 * The session strip (V6): where Talk is in the window's top row, across every
 * tab, while a voice session is live. It says the listening or muted state,
 * the destination the next post goes to with Change, the Waiting control, Mute,
 * End and the captions toggle, and Not what I meant after a page action ran.
 * No running transcript is ever drawn: captions, off by default, show the
 * last few lines said and heard, under the row and over the content, and
 * nothing is kept when they are off or the session ends. After a session the
 * strip stays one line to say how it went, then leaves.
 */
export function VoiceSessionStrip(): ReactNode {
  const state = useVoiceSessionStore(
    useShallow((s) => ({
      phase: s.phase,
      focus: s.focus,
      muted: s.muted,
      pausedForDictation: s.pausedForDictation,
      captions: s.captions,
      captionLines: s.captionLines,
      inputActive: s.activity.inputActiveUntil !== null,
      driver: s.driver,
    })),
  );
  const setCaptions = useVoiceSessionStore((s) => s.setCaptions);

  const [focusLine, setFocusLine] = useState<HTMLElement | null>(null);
  const focusLineShown = useHasWidth(focusLine);

  if (state.phase === "idle") return <VoiceOutcomeLine surface="row" />;

  const driver = state.driver;
  const listening =
    state.phase === "live" && !state.muted && !state.pausedForDictation;
  // Only the state word is a live region: the strip holds the controls and
  // the captions, which change with every transcript delta and would be
  // re-announced whole from a live container.
  return (
    <section
      aria-label="Voice session"
      data-testid="voice-session-strip"
      data-state={state.phase}
      className="relative flex min-w-0 self-stretch text-ui-xs text-muted-foreground"
    >
      {/* The middle column has no floor, so the state and the controls are this
          grid's minimum width, with Waiting's glyph: the top row can take the focus
          line and Waiting's name away, and never a control. */}
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,max-content)_auto_auto] items-center">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            data-testid="voice-strip-pulse"
            className={cn(
              "size-2 shrink-0 rounded-full",
              listening ? "bg-success" : "bg-muted-foreground/40",
              listening && state.inputActive && "animate-pulse",
            )}
          />
          <StateWord
            word={stateLabel(
              state.phase,
              state.muted,
              state.pausedForDictation,
            )}
            focus={state.focus}
            focusLineShown={focusLineShown}
          />
          <ResumeAfterDictation />
        </div>
        <div className="flex min-w-0 items-center gap-3 overflow-hidden not-empty:pl-3">
          {state.focus === null ? null : (
            <FocusLine focus={state.focus} lineNode={setFocusLine} />
          )}
        </div>
        <div className="grid items-center not-empty:pl-3">
          <VoiceWaitingControl />
        </div>
        <div className="flex items-center gap-3 pl-3">
          <NotWhatIMeant />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-pressed={state.muted}
            data-testid="voice-strip-mute"
            disabled={driver === null || state.phase !== "live"}
            onClick={() => driver?.setMuted(!state.muted)}
          >
            {state.muted ? (
              <MicOff aria-hidden="true" />
            ) : (
              <Mic aria-hidden="true" />
            )}
            {state.muted ? "Unmute" : "Mute"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-pressed={state.captions}
            aria-label="Captions"
            data-testid="voice-strip-captions"
            onClick={() => setCaptions(!state.captions)}
          >
            <Captions aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            data-testid="voice-strip-end"
            disabled={driver === null || state.phase === "ending"}
            onClick={() => driver?.end()}
          >
            End
          </Button>
        </div>
      </div>
      {state.captions ? (
        <ul
          data-testid="voice-strip-captions-lines"
          aria-label="Captions"
          className="absolute inset-x-0 top-full z-30 flex flex-col gap-0.5 rounded-b-md border border-t-0 border-border bg-popover px-3 py-1.5"
        >
          {state.captionLines.length === 0 ? (
            <li className="italic">Nothing said yet.</li>
          ) : (
            state.captionLines.map((line) => (
              <li
                key={line.id}
                data-direction={line.direction}
                className={cn(
                  "truncate",
                  line.direction === "output" && "text-foreground",
                )}
              >
                {line.direction === "input" ? "You: " : "Tracy: "}
                {line.text}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * After a page action the voice carried out, until the person's next request:
 * files that action as not what they meant, and goes. Nothing is said and
 * nothing is undone.
 */
function NotWhatIMeant(): ReactNode {
  const executedAct = useVoiceSessionStore((s) => s.executedAct);
  const setExecutedAct = useVoiceSessionStore((s) => s.setExecutedAct);
  if (executedAct === null) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      data-testid="voice-strip-not-meant"
      onClick={() => {
        reportVoiceMiss("not-meant", "chosen-act", executedAct, null);
        setExecutedAct(null);
      }}
    >
      Not what I meant
    </Button>
  );
}

/**
 * Resume, while the voice is paused for dictation. Explicit: dictation
 * ending never resumes the voice. Disabled while dictation still holds the
 * microphone.
 */
export function ResumeAfterDictation(): ReactNode {
  const paused = useVoiceSessionStore((s) => s.pausedForDictation);
  const dictating = useVoiceSessionStore((s) => s.dictationHolds.size > 0);
  const resume = useVoiceSessionStore((s) => s.resumeFromDictation);
  if (!paused) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      data-testid="voice-strip-resume"
      disabled={dictating}
      onClick={resume}
    >
      Resume
    </Button>
  );
}

function stateLabel(
  phase: VoicePhase,
  muted: boolean,
  pausedForDictation: boolean,
): string {
  if (phase === "connecting") return "Connecting…";
  if (phase === "ending") return "Ending…";
  if (pausedForDictation) return "Voice paused for dictation";
  return muted ? "Muted" : "Listening";
}

/** Whether the element takes any width. Only a state read, so it moves no layout. */
function useHasWidth(element: HTMLElement | null): boolean {
  const [hasWidth, setHasWidth] = useState(false);
  useEffect(() => {
    if (element === null) return undefined;
    const read = (): void => {
      setHasWidth(element.getBoundingClientRect().width > 0);
    };
    // A box that lays out to nothing gets no first delivery, so the answer is
    // read here and never inherited from the element before it.
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => {
      observer.disconnect();
      setHasWidth(false);
    };
  }, [element]);
  return element !== null && hasWidth;
}

function destinationLine(
  environmentLabel: string | null,
  botTitle: string,
  threadLabel: string | null,
): string {
  return [environmentLabel, botTitle, threadLabel]
    .filter((part) => part !== null)
    .join(" › ");
}

/**
 * The state word. While the focus line is hidden, the first thing the top row
 * takes away, its tooltip keeps the destination reachable. The tooltip is always
 * mounted and only its opening is gated: this span is the strip's live region,
 * and a new node would be announced again.
 */
function StateWord(props: {
  readonly word: string;
  readonly focus: VoiceFocus | null;
  readonly focusLineShown: boolean;
}): ReactNode {
  const { focus } = props;
  const [wantsOpen, setWantsOpen] = useState(false);
  const open = wantsOpen && focus !== null && !props.focusLineShown;
  return (
    <TooltipWrapper
      label={<DestinationLabel focus={focus} />}
      side="bottom"
      sideOffset={undefined}
      align={undefined}
      open={open}
      onOpenChange={setWantsOpen}
    >
      <span
        role="status"
        data-testid="voice-strip-state"
        className="shrink-0 font-medium text-foreground"
      >
        {props.word}
      </span>
    </TooltipWrapper>
  );
}

function DestinationLabel(props: {
  readonly focus: VoiceFocus | null;
}): ReactNode {
  return props.focus === null ? null : <FocusDestination focus={props.focus} />;
}

function FocusDestination(props: { readonly focus: VoiceFocus }): ReactNode {
  const { environmentLabel, botTitle, threadLabel } = useVoiceFocusLabel(
    props.focus,
  );
  return destinationLine(environmentLabel, botTitle, threadLabel);
}

/**
 * Where the next post goes: environment › bot › thread, with Change, which
 * opens the bot's tab so the person can pick another channel or thread.
 */
function FocusLine(props: {
  readonly focus: VoiceFocus;
  readonly lineNode: (node: HTMLElement | null) => void;
}): ReactNode {
  const { focus, lineNode } = props;
  const openBotChannel = useOpenBotChannel();
  const { environmentLabel, botTitle, threadLabel } = useVoiceFocusLabel(focus);
  // The first thing the strip gives up when the top row is short of room, so
  // the tabs keep theirs; the tooltip still names the whole destination.
  const destination = destinationLine(environmentLabel, botTitle, threadLabel);
  return (
    <TooltipWrapper
      label={destination}
      side="bottom"
      sideOffset={undefined}
      align={undefined}
    >
      <span
        ref={lineNode}
        data-testid="voice-strip-focus"
        className="flex min-w-0 items-center gap-1 truncate"
      >
        {environmentLabel === null ? null : (
          <>
            <span className="truncate">{environmentLabel}</span>
            <span aria-hidden="true">›</span>
          </>
        )}
        <span className="truncate text-foreground">{botTitle}</span>
        {threadLabel === null ? null : (
          <>
            <span aria-hidden="true">›</span>
            <span className="truncate text-foreground">{threadLabel}</span>
          </>
        )}
        <Button
          type="button"
          variant="link"
          size="inline"
          data-testid="voice-strip-change"
          onClick={() => openBotChannel(focus.botId, null)}
        >
          Change
        </Button>
      </span>
    </TooltipWrapper>
  );
}
