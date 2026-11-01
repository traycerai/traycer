import type { ReactNode } from "react";
import { Captions, Mic, MicOff } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { useVoiceFocusLabel } from "@/hooks/voice/use-voice-focus-label";
import { VoiceEndedLine } from "@/components/layout/voice/voice-ended-line";
import { VoiceWaitingControl } from "@/components/layout/voice/voice-waiting-control";
import { useOpenBotChannel } from "@/hooks/bots/use-open-bot-channel";
import { cn } from "@/lib/utils";
import {
  useVoiceSessionStore,
  type VoiceFocus,
  type VoicePhase,
} from "@/stores/voice/voice-session-store";

/**
 * The session strip (V6): one row in the app chrome beneath the tab strip,
 * across every tab, while a voice session is live. It says the listening or
 * muted state, the destination the next post goes to with Change, the
 * Waiting control, Mute, End and the captions toggle.
 * No running transcript is ever drawn: captions, off by default, show the
 * last few lines said and heard, and nothing is kept when they are off or the
 * session ends. After an end the strip stays one line to say why, then
 * leaves.
 */
export function VoiceSessionStrip(): ReactNode {
  const state = useVoiceSessionStore(
    useShallow((s) => ({
      phase: s.phase,
      endReason: s.endReason,
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
  const clearEndReason = useVoiceSessionStore((s) => s.clearEndReason);

  if (state.phase === "idle") {
    if (state.endReason === null) return null;
    return (
      <VoiceEndedLine reason={state.endReason} onDismiss={clearEndReason} />
    );
  }

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
      className="flex w-full flex-col border-b border-border bg-background text-ui-xs text-muted-foreground"
    >
      <div className="flex w-full items-center gap-3 px-3 py-1.5">
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
          {stateLabel(state.phase, state.muted, state.pausedForDictation)}
        </span>
        <ResumeAfterDictation />
        {state.focus === null ? null : <FocusLine focus={state.focus} />}
        <VoiceWaitingControl />
        <span className="min-w-0 flex-1" />
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
      {state.captions ? (
        <ul
          data-testid="voice-strip-captions-lines"
          aria-label="Captions"
          className="flex w-full flex-col gap-0.5 px-3 pb-1.5"
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

/**
 * Where the next post goes: environment › bot › thread, with Change, which
 * opens the bot's tab so the person can pick another channel or thread.
 */
function FocusLine(props: { readonly focus: VoiceFocus }): ReactNode {
  const { focus } = props;
  const openBotChannel = useOpenBotChannel();
  const { environmentLabel, botTitle, threadLabel } = useVoiceFocusLabel(focus);
  return (
    <span
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
  );
}
