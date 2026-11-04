import type { ReactNode } from "react";
import { Captions, Mic, MicOff } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { VoiceOutcomeLine } from "@/components/layout/voice/voice-ended-line";
import { cn } from "@/lib/utils";
import { captionSpeaker } from "@/lib/voice/call";
import {
  useVoiceSessionStore,
  type VoicePhase,
} from "@/stores/voice/voice-session-store";

/**
 * The call strip (Call Tracy, VC3): in the window's top row, across every
 * tab, while a call runs. It says who the call is with and whether the
 * microphone is listening, with Mute, End and the captions toggle. No running
 * transcript is ever drawn: captions, off by default, show the last few lines
 * said and heard, under the row and over the content, and nothing is kept when
 * they are off or the call ends. After a call the strip stays one line to say
 * how it went, then leaves.
 */
export function VoiceSessionStrip(): ReactNode {
  const state = useVoiceSessionStore(
    useShallow((s) => ({
      phase: s.phase,
      callTitle: s.callTitle,
      muted: s.muted,
      pausedForDictation: s.pausedForDictation,
      captions: s.captions,
      captionLines: s.captionLines,
      inputActive: s.activity.inputActiveUntil !== null,
      driver: s.driver,
    })),
  );
  const setCaptions = useVoiceSessionStore((s) => s.setCaptions);

  if (state.phase === "idle") return <VoiceOutcomeLine surface="row" />;

  const driver = state.driver;
  const botTitle = state.callTitle ?? "the bot";
  const listening =
    state.phase === "live" && !state.muted && !state.pausedForDictation;
  // Only the state word is a live region: the strip holds the controls and
  // the captions, which change with every transcript delta and would be
  // re-announced whole from a live container.
  return (
    <section
      aria-label="Call"
      data-testid="voice-session-strip"
      data-state={state.phase}
      className="relative flex min-w-0 self-stretch text-ui-xs text-muted-foreground"
    >
      {/* The bot's name has no floor, so the state and the controls are this
          row's minimum width: the top row can take the name away, never a
          control. */}
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,max-content)_auto] items-center">
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
          <span
            role="status"
            data-testid="voice-strip-state"
            className="shrink-0 font-medium text-foreground"
          >
            {stateLabel(
              state.phase,
              state.muted,
              state.pausedForDictation,
              botTitle,
            )}
          </span>
          <ResumeAfterDictation />
        </div>
        <span
          data-testid="voice-strip-bot"
          className="min-w-0 truncate pl-3 text-foreground"
        >
          {state.phase === "connecting" ? null : botTitle}
        </span>
        <div className="flex items-center gap-3 pl-3">
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
                {captionSpeaker(line.direction, botTitle)}
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
  botTitle: string,
): string {
  if (phase === "connecting") return `Calling ${botTitle}…`;
  if (phase === "ending") return "Ending…";
  if (pausedForDictation) return "Call paused for dictation";
  return muted ? "Muted" : "Listening";
}
