import { useState, type ReactNode } from "react";
import { Phone, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useCallHotkey } from "@/hooks/composer/use-dictation-hotkey";
import { useVoiceDirectory } from "@/hooks/voice/use-voice-directory";
import { cn } from "@/lib/utils";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import {
  callToggleAction,
  useVoiceSessionStore,
  type CallTarget,
} from "@/stores/voice/voice-session-store";

/**
 * How Call is drawn: the glyph with its name (`label`, a desktop header), or
 * the glyph alone in a box a finger can find (`touch`, the phone's header).
 * On the phone a tap opens the call view's dial; on desktop it opens the dial
 * beside the control.
 */
export type CallControlForm = "label" | "touch";

const CALL_CONTROL_SIZE = {
  label: "xs",
  touch: "icon-sm",
} as const satisfies Record<CallControlForm, string>;

/** Whether the call running now is the one this control would place. */
function isThisCall(
  focus: { readonly botId: string; readonly threadId: string | null } | null,
  target: CallTarget,
): boolean {
  return (
    focus !== null &&
    focus.botId === target.botId &&
    (target.threadId === null || focus.threadId === target.threadId)
  );
}

/**
 * The chord on a bot surface (Call Tracy, P15): ends the call that is live,
 * else calls `target` at once. Dictation is a separate owner of the chord and
 * is never touched here.
 */
function toggleCall(target: CallTarget): void {
  const state = useVoiceSessionStore.getState();
  const action = callToggleAction(state);
  if (action === "end") state.driver?.end();
  else if (action === "start") state.driver?.start(target);
}

/**
 * The Call control of a bot surface: the bot thread panel's header (a call
 * that continues that thread) and the bot's channel header on the Tracy tab
 * (a call that opens a new thread with the first thing said). While this
 * call is live it ends it. Hidden until the server says this deployment
 * offers voice, and before the controller that owns the call is mounted.
 * It also binds the composer microphone's chord to the call while its
 * surface owns the keyboard.
 */
export function CallControl(props: {
  readonly target: CallTarget;
  readonly botTitle: string;
  /** The glyph alone on `touch`; the label stays its name. */
  readonly form: CallControlForm;
}): ReactNode {
  const { target, botTitle, form } = props;
  const availability = useVoiceSessionStore((state) => state.availability);
  const phase = useVoiceSessionStore((state) => state.phase);
  const driver = useVoiceSessionStore((state) => state.driver);
  const thisCall = useVoiceSessionStore((state) =>
    isThisCall(state.focus, target),
  );
  const offered = availability === "live" && driver !== null;
  useCallHotkey({
    enabled: offered,
    thread: target.threadId !== null,
    toggle: () => toggleCall(target),
  });
  const [dialOpen, setDialOpen] = useState(false);
  // Drawn only once the server has said it offers voice: before that answer
  // a Call would open the microphone to learn there is nothing to call.
  if (availability !== "live" || driver === null) return null;
  const live = phase !== "idle" && thisCall;
  const label = live
    ? "End the call"
    : `Call ${botTitle}. Costs credits while on.`;
  const button = (
    <Button
      type="button"
      variant={live ? "success-ghost" : "ghost"}
      size={CALL_CONTROL_SIZE[form]}
      aria-label={live ? "End the call" : "Call"}
      aria-pressed={live}
      data-testid="call-control"
      data-state={live ? phase : "idle"}
      disabled={phase === "ending"}
      onClick={(event) => {
        if (live) {
          event.preventDefault();
          driver.end();
          return;
        }
        // One bot per call: another call running ends before this one.
        if (phase !== "idle") driver.end();
        if (form === "touch") {
          event.preventDefault();
          useVoiceSessionStore.getState().openDial(target, botTitle);
        }
      }}
      className="shrink-0 self-center [-webkit-app-region:no-drag]"
    >
      {live ? <PhoneOff aria-hidden="true" /> : <Phone aria-hidden="true" />}
      {form === "label" ? "Call" : null}
    </Button>
  );
  if (form === "touch" || live) {
    return (
      <TooltipWrapper
        label={label}
        side="bottom"
        sideOffset={undefined}
        align={undefined}
      >
        {button}
      </TooltipWrapper>
    );
  }
  return (
    <Popover open={dialOpen} onOpenChange={setDialOpen}>
      <TooltipWrapper
        label={label}
        side="bottom"
        sideOffset={undefined}
        align={undefined}
      >
        <PopoverTrigger asChild>{button}</PopoverTrigger>
      </TooltipWrapper>
      <PopoverContent
        align="end"
        layout="padded"
        data-testid="call-dial-popover"
      >
        <CallDial
          preselected={target}
          preselectedTitle={botTitle}
          onDialed={() => setDialOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The dial (Call Tracy, P11): the bot whose surface the dial came from is
 * preselected, and every bot the person can call is listed to pick another.
 * Call places it; a bot other than the preselected one gets a new thread.
 */
export function CallDial(props: {
  readonly preselected: CallTarget;
  readonly preselectedTitle: string;
  readonly onDialed: () => void;
}): ReactNode {
  const { preselected, preselectedTitle, onDialed } = props;
  const surfaceHostId = useTracySurfaceStore((state) =>
    state.open ? state.hostId : null,
  );
  const client = useHostClientForHostId(surfaceHostId);
  const listed = useVoiceDirectory(client, surfaceHostId, true);
  const bots =
    listed.length > 0
      ? listed
      : [
          {
            botId: preselected.botId,
            title: preselectedTitle,
            environmentId: "",
            environmentLabel: "",
          },
        ];
  const [selected, setSelected] = useState(preselected.botId);
  const driver = useVoiceSessionStore((state) => state.driver);
  const phase = useVoiceSessionStore((state) => state.phase);
  return (
    <div className="flex w-full flex-col gap-3" data-testid="call-dial">
      <RadioGroup
        aria-label="Bot to call"
        value={selected}
        onValueChange={setSelected}
      >
        {bots.map((bot) => (
          <label
            key={bot.botId}
            data-testid="call-dial-bot"
            data-selected={bot.botId === selected ? "" : undefined}
            className={cn(
              "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-ui-sm",
              bot.botId === selected && "bg-foreground/8",
            )}
          >
            <RadioGroupItem value={bot.botId} />
            <span className="min-w-0 flex-1 truncate text-foreground">
              {bot.title}
            </span>
            {bot.environmentLabel.length === 0 ? null : (
              <span className="shrink-0 truncate text-ui-xs text-muted-foreground">
                {bot.environmentLabel}
              </span>
            )}
          </label>
        ))}
      </RadioGroup>
      <Button
        type="button"
        size="sm"
        data-testid="call-dial-call"
        disabled={driver === null || phase !== "idle"}
        onClick={() => {
          driver?.start({
            botId: selected,
            threadId:
              selected === preselected.botId ? preselected.threadId : null,
          });
          onDialed();
        }}
      >
        <Phone aria-hidden="true" />
        Call
      </Button>
    </div>
  );
}
