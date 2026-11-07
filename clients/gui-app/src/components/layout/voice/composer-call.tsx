import type { ReactNode } from "react";
import { Captions, Mic, MicOff, Phone } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { VoiceOutcomeLine } from "@/components/layout/voice/voice-ended-line";
import { useMobileHeaderActive } from "@/components/layout/header/use-mobile-header-active";
import { callPlacedFrom } from "@/components/layout/voice/use-composer-call";
import { cn } from "@/lib/utils";
import { captionSpeaker } from "@/lib/voice/call";
import {
  useVoiceSessionStore,
  type CallTarget,
  type VoicePhase,
} from "@/stores/voice/voice-session-store";

/**
 * A call from a bot's message box (Call Tracy, VC3 rule 7): Call sits beside
 * Send on every box that has a place for one, the channel's (a call that
 * opens a new thread with the first thing said) and an opened thread's (a
 * call that continues it). While the call placed from a box runs, the box
 * swaps its field for the call bar; its line about how the call went stays
 * there until dismissed. On the phone, Call opens the call view instead.
 */

/**
 * Call, beside Send. Hidden until the server says this deployment offers
 * voice, and before the controller that owns the call is mounted.
 */
export function ComposerCallButton(props: {
  /** `null` for a box with no call to place: nothing is drawn. */
  readonly target: CallTarget | null;
  readonly botTitle: string;
  readonly testId: string;
}): ReactNode {
  const { target, botTitle, testId } = props;
  const phoneLayout = useMobileHeaderActive();
  const availability = useVoiceSessionStore((state) => state.availability);
  const phase = useVoiceSessionStore((state) => state.phase);
  const driver = useVoiceSessionStore((state) => state.driver);
  // Drawn only once the server has said it offers voice: before that answer
  // a Call would open the microphone to learn there is nothing to call.
  if (target === null || availability !== "live" || driver === null) {
    return null;
  }
  return (
    <TooltipWrapper
      label={`Call ${botTitle}. Costs credits while on.`}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Call ${botTitle}`}
        data-testid={`${testId}-call`}
        disabled={phase === "ending"}
        onClick={() => {
          const store = useVoiceSessionStore.getState();
          if (
            phoneLayout &&
            callPlacedFrom(store, target) &&
            phase !== "idle"
          ) {
            store.setPhoneViewOpen(true);
            return;
          }
          // One bot per call: another call running ends before this one.
          if (store.phase !== "idle") driver.end();
          if (phoneLayout) store.openDial(target, botTitle);
          else driver.start(target);
        }}
      >
        <Phone aria-hidden="true" />
      </Button>
    </TooltipWrapper>
  );
}

/**
 * The box's field and its actions (`children`), or, while `shown`, the call
 * bar in their place. The field is only hidden: the draft comes back with it.
 */
export function ComposerCallSwap(props: {
  readonly shown: boolean;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return props.shown ? (
    <ComposerCallBar testId={props.testId} />
  ) : (
    props.children
  );
}

/**
 * The call bar, in the box in place of its field: how loud the person is
 * heard, who the call is with and what it is doing, then Mute, Captions and
 * End. After the call, the line about how it went, until dismissed.
 */
function ComposerCallBar(props: { readonly testId: string }): ReactNode {
  const state = useVoiceSessionStore(
    useShallow((s) => ({
      phase: s.phase,
      callTitle: s.callTitle,
      muted: s.muted,
      pausedForDictation: s.pausedForDictation,
      captions: s.captions,
      inputActive: s.activity.inputActiveUntil !== null,
      driver: s.driver,
    })),
  );
  const setCaptions = useVoiceSessionStore((s) => s.setCaptions);
  if (state.phase === "idle") {
    return (
      <div className="col-span-2 flex min-h-10 items-center px-3 py-1.5">
        <VoiceOutcomeLine surface="composer" />
      </div>
    );
  }
  const driver = state.driver;
  const botTitle = state.callTitle ?? "the bot";
  const listening =
    state.phase === "live" && !state.muted && !state.pausedForDictation;
  return (
    <section
      aria-label="Call"
      data-testid={`${props.testId}-call-bar`}
      data-state={state.phase}
      className="col-span-2 flex min-h-10 min-w-0 items-center gap-3 px-3 py-1.5 text-ui-xs text-muted-foreground"
    >
      <span
        aria-hidden="true"
        data-testid={`${props.testId}-call-level`}
        className={cn(
          "size-2.5 shrink-0 rounded-full",
          listening ? "bg-success" : "bg-muted-foreground/40",
          listening && state.inputActive && "animate-pulse",
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui-sm font-medium text-foreground">
          {botTitle}
        </span>
        <span
          role="status"
          data-testid={`${props.testId}-call-state`}
          className="truncate"
        >
          {stateWord(state.phase, state.muted, state.pausedForDictation)}
        </span>
      </div>
      <ResumeAfterDictation />
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-pressed={state.muted}
        data-testid={`${props.testId}-call-mute`}
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
        data-testid={`${props.testId}-call-captions`}
        onClick={() => setCaptions(!state.captions)}
      >
        <Captions aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="xs"
        data-testid={`${props.testId}-call-end`}
        disabled={driver === null || state.phase === "ending"}
        onClick={() => driver?.end()}
      >
        End
      </Button>
    </section>
  );
}

/**
 * The call's captions, above the box while they are on: the last few lines
 * said and heard. Nothing is kept when they are off or the call ends.
 */
export function ComposerCallCaptions(props: {
  /** Whether the box draws the call bar: captions go with it. */
  readonly shown: boolean;
  readonly testId: string;
}): ReactNode {
  const state = useVoiceSessionStore(
    useShallow((s) => ({
      phase: s.phase,
      captions: s.captions,
      captionLines: s.captionLines,
      callTitle: s.callTitle,
    })),
  );
  if (!props.shown || state.phase === "idle" || !state.captions) return null;
  const botTitle = state.callTitle ?? "the bot";
  return (
    <ul
      data-testid={`${props.testId}-call-captions-lines`}
      aria-label="Captions"
      className="flex flex-col gap-0.5 px-1 text-ui-xs text-muted-foreground"
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
            {captionSpeaker(line.direction, botTitle)}
            {line.text}
          </li>
        ))
      )}
    </ul>
  );
}

/**
 * Resume, while the call is paused for dictation. Explicit: dictation ending
 * never resumes the call. Disabled while dictation still holds the microphone.
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
      data-testid="voice-call-resume"
      disabled={dictating}
      onClick={resume}
    >
      Resume
    </Button>
  );
}

function stateWord(
  phase: VoicePhase,
  muted: boolean,
  pausedForDictation: boolean,
): string {
  if (phase === "connecting") return "Calling…";
  if (phase === "ending") return "Ending…";
  if (pausedForDictation) return "Call paused for dictation";
  return muted ? "Muted" : "Listening";
}
