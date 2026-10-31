import type { KeyboardEvent, ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AudioLines, Captions, Mic, MicOff, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { VoiceEndedLine } from "@/components/layout/voice/voice-ended-line";
import { ResumeAfterDictation } from "@/components/layout/voice/voice-session-strip";
import { VoiceWaitingControl } from "@/components/layout/voice/voice-waiting-control";
import { useVoiceFocusLabel } from "@/hooks/voice/use-voice-focus-label";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { botTabIntent } from "@/lib/tab-navigation/intents";
import { cn } from "@/lib/utils";
import {
  useVoiceSessionStore,
  type VoiceFocus,
  type VoicePhase,
} from "@/stores/voice/voice-session-store";

/**
 * The phone's voice session (V5, boards V-C to V-E): a full-screen view over
 * the bot channel the session started in. The focus line at the top (tap it
 * to see the channel behind, with the session still live), the Waiting
 * control, and the talk button: with the open microphone, the default, it
 * mutes and unmutes ("Listening · tap to mute"); under push-to-talk, the
 * per-session switch beneath it, the microphone carries the person only
 * while it is held. ✕ ends the session. No running transcript is drawn
 * unless the person turns captions on (V6).
 *
 * The phone layout only; the desktop has the strip.
 */
export function VoicePhoneView(): ReactNode {
  const state = useVoiceSessionStore(
    useShallow((s) => ({
      phase: s.phase,
      focus: s.focus,
      phoneViewOpen: s.phoneViewOpen,
      captions: s.captions,
      captionLines: s.captionLines,
      driver: s.driver,
    })),
  );
  const setPhoneViewOpen = useVoiceSessionStore((s) => s.setPhoneViewOpen);
  const setCaptions = useVoiceSessionStore((s) => s.setCaptions);
  const open = state.phase !== "idle" && state.phoneViewOpen;
  const driver = state.driver;
  return (
    // The phone's back gesture (Escape) shows the channel behind; it never
    // ends the session, which stays on screen in the bar until ended.
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) setPhoneViewOpen(false);
      }}
    >
      <SheetContent
        side="bottom"
        showCloseButton={false}
        aria-describedby={undefined}
        data-testid="voice-phone-view"
        className="gap-0"
      >
        <SheetTitle className="sr-only">Voice session</SheetTitle>
        {/* The bottom sheet is as tall as its content: this column fills
          the window below the status bar, the home indicator cleared. */}
        <div className="flex h-safe-dvh min-h-0 flex-col pb-safe-bottom">
          <header className="flex min-w-0 items-center gap-2 px-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-touch"
              aria-label="End"
              data-testid="voice-phone-end"
              disabled={driver === null || state.phase === "ending"}
              onClick={() => driver?.end()}
            >
              <X aria-hidden="true" />
            </Button>
            {state.focus === null ? (
              <span className="min-w-0 flex-1" />
            ) : (
              <PhoneFocusLine
                focus={state.focus}
                onOpened={() => setPhoneViewOpen(false)}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-touch"
              aria-label="Captions"
              aria-pressed={state.captions}
              data-testid="voice-phone-captions"
              onClick={() => setCaptions(!state.captions)}
            >
              <Captions aria-hidden="true" />
            </Button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col justify-end overflow-y-auto px-4">
            {state.captions ? (
              <ul
                data-testid="voice-phone-captions-lines"
                aria-label="Captions"
                className="flex w-full flex-col gap-2 py-3 text-ui-sm"
              >
                {state.captionLines.length === 0 ? (
                  <li className="text-muted-foreground italic">
                    Nothing said yet.
                  </li>
                ) : (
                  state.captionLines.map((line) => (
                    <li
                      key={line.id}
                      data-direction={line.direction}
                      className={cn(
                        line.direction === "output"
                          ? "text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {line.direction === "input" ? "You: " : "Tracy: "}
                      {line.text}
                    </li>
                  ))
                )}
              </ul>
            ) : null}
          </div>
          <div className="flex flex-col items-center gap-3 px-4 pt-2 pb-4">
            <div className="flex w-full items-center justify-between gap-2">
              <VoiceWaitingControl />
              <ResumeAfterDictation />
            </div>
            <TalkButton />
            <TalkModeSwitch />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Where the next post goes, as one button: tapping it shows the channel
 * behind the view, the session still live.
 */
function PhoneFocusLine(props: {
  readonly focus: VoiceFocus;
  readonly onOpened: () => void;
}): ReactNode {
  const { focus, onOpened } = props;
  const navigate = useNavigate();
  const { environmentLabel, botTitle, threadLabel } = useVoiceFocusLabel(focus);
  return (
    <Button
      type="button"
      variant="ghost"
      size="touch"
      data-testid="voice-phone-focus"
      className="min-w-0 flex-1 flex-col items-start"
      onClick={() => {
        onOpened();
        navigateToTabIntent(navigate, botTabIntent(focus.botId), undefined);
      }}
    >
      <span className="w-full truncate text-left text-ui-sm text-foreground">
        {botTitle}
      </span>
      <span className="w-full truncate text-left text-muted-foreground">
        {threadLabel ?? environmentLabel ?? "Channel"}
      </span>
    </Button>
  );
}

/**
 * The talk button. Open microphone: a tap mutes or unmutes. Push-to-talk:
 * the microphone is open while the button is held, by finger or by Space or
 * Enter, and closes on release, cancel or a finger sliding off.
 */
function TalkButton(): ReactNode {
  const state = useVoiceSessionStore(
    useShallow((s) => ({
      phase: s.phase,
      muted: s.muted,
      pushToTalk: s.pushToTalk,
      talkHeld: s.talkHeld,
      pausedForDictation: s.pausedForDictation,
      driver: s.driver,
    })),
  );
  const setTalkHeld = useVoiceSessionStore((s) => s.setTalkHeld);
  const live = state.phase === "live";
  const disabled = !live || state.driver === null || state.pausedForDictation;
  const listening = state.pushToTalk ? state.talkHeld : !state.muted;
  const hold = (held: boolean): void => {
    if (state.pushToTalk) setTalkHeld(held);
  };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, held: boolean) => {
    if (!state.pushToTalk || (event.key !== " " && event.key !== "Enter")) {
      return;
    }
    event.preventDefault();
    if (held && event.repeat) return;
    setTalkHeld(held);
  };
  let icon = <AudioLines aria-hidden="true" className="size-8" />;
  if (!state.pushToTalk) {
    icon = state.muted ? (
      <MicOff aria-hidden="true" className="size-8" />
    ) : (
      <Mic aria-hidden="true" className="size-8" />
    );
  }
  return (
    <div className="flex flex-col items-center gap-2">
      <span className="flex items-center gap-1.5 text-ui-xs text-muted-foreground">
        <span
          aria-hidden="true"
          data-testid="voice-phone-pulse"
          className={cn(
            "size-2 shrink-0 rounded-full",
            live && listening && !state.pausedForDictation
              ? "bg-success"
              : "bg-muted-foreground/40",
          )}
        />
        {phaseWord(state.phase)}
      </span>
      <Button
        type="button"
        variant={listening && live ? "default" : "outline"}
        size="icon-lg"
        aria-label={state.pushToTalk ? "Hold to talk" : "Mute"}
        aria-pressed={state.pushToTalk ? state.talkHeld : state.muted}
        data-testid="voice-phone-talk"
        disabled={disabled}
        className="size-20 touch-none rounded-full"
        onClick={() => {
          if (!state.pushToTalk) state.driver?.setMuted(!state.muted);
        }}
        onPointerDown={(event) => {
          if (!state.pushToTalk) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          hold(true);
        }}
        onPointerUp={() => hold(false)}
        onPointerCancel={() => hold(false)}
        onLostPointerCapture={() => hold(false)}
        onKeyDown={(event) => onKey(event, true)}
        onKeyUp={(event) => onKey(event, false)}
        onBlur={() => hold(false)}
        onContextMenu={(event) => event.preventDefault()}
      >
        {icon}
      </Button>
      <span
        role="status"
        data-testid="voice-phone-talk-state"
        className="text-ui-sm text-foreground"
      >
        {talkLine(state)}
      </span>
    </div>
  );
}

/** The per-session switch between the open microphone and push-to-talk. */
function TalkModeSwitch(): ReactNode {
  const pushToTalk = useVoiceSessionStore((s) => s.pushToTalk);
  const setPushToTalk = useVoiceSessionStore((s) => s.setPushToTalk);
  return (
    <div
      role="group"
      aria-label="Microphone"
      className="flex items-center gap-1"
      data-testid="voice-phone-mode"
    >
      <Button
        type="button"
        variant={pushToTalk ? "secondary" : "ghost"}
        size="sm"
        aria-pressed={pushToTalk}
        data-testid="voice-phone-mode-push-to-talk"
        onClick={() => setPushToTalk(true)}
      >
        Push to talk
      </Button>
      <Button
        type="button"
        variant={pushToTalk ? "ghost" : "secondary"}
        size="sm"
        aria-pressed={!pushToTalk}
        data-testid="voice-phone-mode-open-mic"
        onClick={() => setPushToTalk(false)}
      >
        Open mic
      </Button>
    </div>
  );
}

/**
 * The session on the phone while its view is down, and the line about the
 * last end afterwards: under the header, on every screen, so an open
 * microphone is never out of sight. Open brings the view back.
 */
export function VoicePhoneBar(): ReactNode {
  const state = useVoiceSessionStore(
    useShallow((s) => ({
      phase: s.phase,
      endReason: s.endReason,
      focus: s.focus,
      phoneViewOpen: s.phoneViewOpen,
      muted: s.muted,
      pushToTalk: s.pushToTalk,
      talkHeld: s.talkHeld,
      pausedForDictation: s.pausedForDictation,
      driver: s.driver,
    })),
  );
  const clearEndReason = useVoiceSessionStore((s) => s.clearEndReason);
  const setPhoneViewOpen = useVoiceSessionStore((s) => s.setPhoneViewOpen);
  if (state.phase === "idle") {
    if (state.endReason === null) return null;
    return (
      <VoiceEndedLine reason={state.endReason} onDismiss={clearEndReason} />
    );
  }
  if (state.phoneViewOpen) return null;
  const driver = state.driver;
  return (
    <section
      aria-label="Voice session"
      data-testid="voice-phone-bar"
      className="flex w-full items-center gap-2 border-b border-border bg-background px-3 py-1.5 text-ui-xs text-muted-foreground"
    >
      <span
        role="status"
        data-testid="voice-phone-bar-state"
        className="shrink-0 font-medium text-foreground"
      >
        {talkLine(state)}
      </span>
      {state.focus === null ? (
        <span className="min-w-0 flex-1" />
      ) : (
        <PhoneBarFocus focus={state.focus} />
      )}
      <Button
        type="button"
        variant="outline"
        size="xs"
        data-testid="voice-phone-bar-open"
        onClick={() => setPhoneViewOpen(true)}
      >
        Open
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        data-testid="voice-phone-bar-end"
        disabled={driver === null || state.phase === "ending"}
        onClick={() => driver?.end()}
      >
        End
      </Button>
    </section>
  );
}

function PhoneBarFocus(props: { readonly focus: VoiceFocus }): ReactNode {
  const { botTitle } = useVoiceFocusLabel(props.focus);
  return <span className="min-w-0 flex-1 truncate">{botTitle}</span>;
}

function phaseWord(phase: VoicePhase): string {
  if (phase === "connecting") return "Connecting…";
  if (phase === "ending") return "Ending…";
  return "Live";
}

/** What the microphone is doing, in the words under the talk button. */
function talkLine(state: {
  readonly phase: VoicePhase;
  readonly muted: boolean;
  readonly pushToTalk: boolean;
  readonly talkHeld: boolean;
  readonly pausedForDictation: boolean;
}): string {
  if (state.phase === "connecting") return "Connecting…";
  if (state.phase === "ending") return "Ending…";
  if (state.pausedForDictation) return "Voice paused for dictation";
  if (state.pushToTalk) return state.talkHeld ? "Listening" : "Hold to talk";
  return state.muted ? "Muted · tap to listen" : "Listening · tap to mute";
}
