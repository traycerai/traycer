import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Captions, Mic, MicOff, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostClient } from "@/lib/host";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { botTabIntent } from "@/lib/tab-navigation/intents";
import { cn } from "@/lib/utils";
import { useBotRail, type BotRail } from "@/stores/bots/bot-open-thread-store";
import { lookupBotTab, useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import {
  useVoiceSessionStore,
  type VoiceEndReason,
  type VoiceFocus,
  type VoicePhase,
} from "@/stores/voice/voice-session-store";

/** How much of a thread's opening post the focus line shows. */
const THREAD_LABEL_MAX_CHARS = 48;

/**
 * The session strip (V6): one row in the app chrome beneath the tab strip,
 * across every tab, while a voice session is live. It says the listening or
 * muted state, the destination the next post goes to with Change, the
 * Waiting slot (filled by a later ticket), Mute, End and the captions toggle.
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
      queueCount: s.queue.length,
      inputActive: s.activity.inputActiveUntil !== null,
      driver: s.driver,
    })),
  );
  const setCaptions = useVoiceSessionStore((s) => s.setCaptions);
  const clearEndReason = useVoiceSessionStore((s) => s.clearEndReason);

  if (state.phase === "idle") {
    if (state.endReason === null) return null;
    return (
      <output
        data-testid="voice-session-strip"
        data-state="ended"
        className="flex w-full items-center gap-2 border-b border-border bg-background px-3 py-1.5 text-ui-xs text-muted-foreground"
      >
        <span className="min-w-0 flex-1" data-testid="voice-strip-state">
          {endedLine(state.endReason)}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss"
          data-testid="voice-strip-dismiss"
          onClick={clearEndReason}
        >
          <X aria-hidden="true" />
        </Button>
      </output>
    );
  }

  const driver = state.driver;
  const listening =
    state.phase === "live" && !state.muted && !state.pausedForDictation;
  return (
    <output
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
          data-testid="voice-strip-state"
          className="shrink-0 font-medium text-foreground"
        >
          {stateLabel(state.phase, state.muted, state.pausedForDictation)}
        </span>
        {state.focus === null ? null : <FocusLine focus={state.focus} />}
        {state.queueCount > 0 ? (
          <span data-testid="voice-strip-waiting" className="shrink-0">
            Waiting · {state.queueCount}
          </span>
        ) : null}
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
    </output>
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

function endedLine(reason: VoiceEndReason): string {
  switch (reason) {
    case "credits":
      return "Voice ended: credits.";
    case "connection":
      return "Voice ended: connection lost.";
    case "locked":
      return "Voice ended: the screen locked.";
    case "microphone":
      return "Voice did not start: the microphone is not available.";
    case "unavailable":
      return "Voice did not start. Try again in a moment.";
    case "ended":
      return "Voice ended.";
  }
}

/**
 * Where the next post goes: environment › bot › thread, with Change, which
 * opens the bot's tab so the person can pick another channel or thread.
 */
function FocusLine(props: { readonly focus: VoiceFocus }): ReactNode {
  const { focus } = props;
  const navigate = useNavigate();
  const appHostId = useEffectiveHostId();
  const appClient = useHostClient();
  const botsSupported = useHostMethodSupport(appHostId, "bot.list") === true;
  const bots = useBotListQuery(appClient, botsSupported);
  const environments = useEnvironmentListQuery(appClient, botsSupported);
  const tabTitle = useBotTabsStore(
    (state) => lookupBotTab(state.tabs, focus.botId)?.title ?? null,
  );
  const rail = useBotRail(focus.botId);
  const bot = bots.data?.bots.find((row) => row.botId === focus.botId) ?? null;
  const environmentLabel =
    bot === null
      ? null
      : (environments.data?.environments.find(
          (row) => row.environmentId === bot.environmentId,
        )?.label ?? null);
  const botTitle = bot?.title ?? tabTitle ?? "Bot";
  const threadLabel = threadLabelOf(focus, rail);
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
        onClick={() =>
          navigateToTabIntent(navigate, botTabIntent(focus.botId), undefined)
        }
      >
        Change
      </Button>
    </span>
  );
}

/**
 * The thread's label: its opening post while the rail remembers the send
 * that opened it, else "Thread"; nothing at the channel's top level.
 */
function threadLabelOf(focus: VoiceFocus, rail: BotRail | null): string | null {
  if (focus.threadId === null) return null;
  if (rail !== null && rail.kind === "thread" && rail.sent !== null) {
    return truncate(rail.sent.text, THREAD_LABEL_MAX_CHARS);
  }
  return "Thread";
}

function truncate(text: string, maxChars: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 1)}…`;
}
