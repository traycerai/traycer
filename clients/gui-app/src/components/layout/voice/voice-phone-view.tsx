import { useEffect, type KeyboardEvent, type ReactNode } from "react";
import { AudioLines, Captions, Mic, MicOff, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { CallDial } from "@/components/layout/voice/call-control";
import { VoiceOutcomeLine } from "@/components/layout/voice/voice-ended-line";
import { ResumeAfterDictation } from "@/components/layout/voice/voice-session-strip";
import { cn } from "@/lib/utils";
import { captionSpeaker } from "@/lib/voice/call";
import {
  useVoiceSessionStore,
  type VoicePhase,
  type VoiceSessionState,
} from "@/stores/voice/voice-session-store";

/** Which of its three states the phone's call view shows; `null` while it is down. */
type CallViewState = "dial" | "call" | "ended";

function callViewState(state: VoiceSessionState): CallViewState | null {
  if (!state.phoneViewOpen) return null;
  if (state.phase !== "idle") return "call";
  if (state.dial !== null) return "dial";
  if (state.endReason !== null || state.refusal !== null) return "ended";
  return null;
}

/**
 * The phone's call view (Call Tracy, VC3), full screen over the bot surface,
 * in three states. The dial: the bot whose header was tapped preselected,
 * every bot the person can call listed, and Call. The call: the bot's name
 * (tap it to see the channel behind, with the call still live), the talk
 * button (with the open microphone, the default, it mutes and unmutes:
 * "Listening · tap to mute"; under push-to-talk, the switch beneath it, the
 * microphone carries the person only while it is held), ✕ to end, and the
 * captions toggle. The end: why the call ended, until dismissed. No running
 * transcript is drawn unless the person turns captions on.
 *
 * The phone layout only; the desktop has the strip.
 */
export function VoicePhoneView(): ReactNode {
  const view = useVoiceSessionStore(callViewState);
  const state = useVoiceSessionStore(
    useShallow((s) => ({
      phase: s.phase,
      dial: s.dial,
      callTitle: s.callTitle,
      captions: s.captions,
      captionLines: s.captionLines,
      driver: s.driver,
    })),
  );
  const setPhoneViewOpen = useVoiceSessionStore((s) => s.setPhoneViewOpen);
  const setCaptions = useVoiceSessionStore((s) => s.setCaptions);
  const botTitle = state.callTitle ?? "the bot";
  const driver = state.driver;
  return (
    // The phone's back gesture (Escape) shows the channel behind; it never
    // ends a call, which stays on screen in the bar until ended. Backing out
    // of the dial or the end puts them away.
    <Sheet
      open={view !== null}
      onOpenChange={(next) => {
        if (next) return;
        const store = useVoiceSessionStore.getState();
        if (view === "dial") store.closeDial();
        else if (view === "ended") {
          store.clearEndReason();
          store.clearRefusal();
        } else setPhoneViewOpen(false);
      }}
    >
      <SheetContent
        side="bottom"
        showCloseButton={false}
        aria-describedby={undefined}
        data-testid="voice-phone-view"
        data-view={view ?? undefined}
        className="gap-0"
      >
        <SheetTitle className="sr-only">Call</SheetTitle>
        {/* The bottom sheet is as tall as its content: this column fills
          the window below the status bar, the home indicator cleared. */}
        <div className="flex h-safe-dvh min-h-0 flex-col pb-safe-bottom">
          {view === "dial" && state.dial !== null ? (
            <>
              <header className="flex min-w-0 items-center gap-2 px-2 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-touch"
                  aria-label="Close"
                  data-testid="voice-phone-dial-close"
                  onClick={() => useVoiceSessionStore.getState().closeDial()}
                >
                  <X aria-hidden="true" />
                </Button>
                <span className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground">
                  Call
                </span>
              </header>
              <div className="flex min-h-0 flex-1 flex-col justify-end overflow-y-auto px-4 pb-4">
                <CallDial
                  preselected={state.dial}
                  preselectedTitle={botTitle}
                  onDialed={() => undefined}
                />
              </div>
            </>
          ) : null}
          {view === "call" ? (
            <>
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
                <Button
                  type="button"
                  variant="ghost"
                  size="touch"
                  data-testid="voice-phone-bot"
                  className="min-w-0 flex-1 justify-start"
                  onClick={() => setPhoneViewOpen(false)}
                >
                  <span className="w-full truncate text-left text-ui-sm text-foreground">
                    {botTitle}
                  </span>
                </Button>
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
                          {captionSpeaker(line.direction, botTitle)}
                          {line.text}
                        </li>
                      ))
                    )}
                  </ul>
                ) : null}
              </div>
              <div className="flex flex-col items-center gap-3 px-4 pt-2 pb-4">
                <ResumeAfterDictation />
                <TalkButton botTitle={botTitle} />
                <TalkModeSwitch />
              </div>
            </>
          ) : null}
          {view === "ended" ? (
            <div
              data-testid="voice-phone-ended"
              className="flex min-h-0 flex-1 flex-col justify-center px-4"
            >
              <VoiceOutcomeLine surface="view" />
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The talk button. Open microphone: a tap mutes or unmutes. Push-to-talk:
 * the microphone is open while the button is held, by finger or by Space or
 * Enter, and closes on release, cancel or a finger sliding off.
 */
function TalkButton(props: { readonly botTitle: string }): ReactNode {
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
  // A button taken off screen mid-press never hears its release: the hold
  // goes with it.
  useEffect(() => () => setTalkHeld(false), [setTalkHeld]);
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
        {phaseWord(state.phase, props.botTitle)}
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
        {talkLine(state, props.botTitle)}
      </span>
    </div>
  );
}

/** The per-call switch between the open microphone and push-to-talk. */
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
 * The call on the phone while its view is down, and the line about how the
 * last one went afterwards: under the header, on every screen, so an open
 * microphone is never out of sight. Open brings the view back.
 */
export function VoicePhoneBar(): ReactNode {
  const state = useVoiceSessionStore(
    useShallow((s) => ({
      phase: s.phase,
      callTitle: s.callTitle,
      phoneViewOpen: s.phoneViewOpen,
      muted: s.muted,
      pushToTalk: s.pushToTalk,
      talkHeld: s.talkHeld,
      pausedForDictation: s.pausedForDictation,
      driver: s.driver,
    })),
  );
  const setPhoneViewOpen = useVoiceSessionStore((s) => s.setPhoneViewOpen);
  if (state.phoneViewOpen) return null;
  if (state.phase === "idle") return <VoiceOutcomeLine surface="bar" />;
  const driver = state.driver;
  const botTitle = state.callTitle ?? "the bot";
  return (
    <section
      aria-label="Call"
      data-testid="voice-phone-bar"
      className="flex w-full items-center gap-2 border-b border-border bg-background px-3 py-1.5 text-ui-xs text-muted-foreground"
    >
      <span
        role="status"
        data-testid="voice-phone-bar-state"
        className="shrink-0 font-medium text-foreground"
      >
        {talkLine(state, botTitle)}
      </span>
      <span className="min-w-0 flex-1 truncate">{botTitle}</span>
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

function phaseWord(phase: VoicePhase, botTitle: string): string {
  if (phase === "connecting") return `Calling ${botTitle}…`;
  if (phase === "ending") return "Ending…";
  return "Live";
}

/** What the microphone is doing, in the words under the talk button. */
function talkLine(
  state: {
    readonly phase: VoicePhase;
    readonly muted: boolean;
    readonly pushToTalk: boolean;
    readonly talkHeld: boolean;
    readonly pausedForDictation: boolean;
  },
  botTitle: string,
): string {
  if (state.phase === "connecting") return `Calling ${botTitle}…`;
  if (state.phase === "ending") return "Ending…";
  if (state.pausedForDictation) return "Call paused for dictation";
  if (state.pushToTalk) return state.talkHeld ? "Listening" : "Hold to talk";
  return state.muted ? "Muted · tap to listen" : "Listening · tap to mute";
}
