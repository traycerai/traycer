import { ArrowUp, Square } from "lucide-react";
import { memo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import { cn } from "@/lib/utils";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";

/**
 * Where Stop lives while a turn runs.
 *
 * - `"replace"`: this button morphs into Stop. The desktop toolbar's choice -
 *   Enter still queues there, so Send needs no button of its own mid-turn.
 * - `"beside"`: Send stays put (tapping it queues) and Stop renders to its
 *   left. The phone toolbar's choice - Return is a newline on a soft keyboard,
 *   so this button is the only way to queue.
 */
export type ComposerStopPlacement = "replace" | "beside";

interface ComposerSendButtonProps {
  canSubmit: boolean;
  attachmentPending: boolean;
  onSubmit: () => void;
  activeTurnStatus: ChatActiveTurn["status"] | null;
  stopDisabled: boolean;
  onStopTurn: (() => void) | null;
  /**
   * When non-null (send mode only), the button is disabled and shows this
   * string as its tooltip - e.g. "Select a workspace folder to start." `null`
   * leaves the normal "Send" affordance.
   */
  disabledHint: string | null;
  stopPlacement: ComposerStopPlacement;
}

const BUTTON_CLASS_NAME =
  "size-8 rounded-full disabled:bg-foreground/8 disabled:text-muted-foreground aria-disabled:cursor-not-allowed aria-disabled:bg-foreground/8 aria-disabled:text-muted-foreground aria-disabled:hover:bg-foreground/8";

function ComposerSendButtonImpl(props: ComposerSendButtonProps) {
  const {
    canSubmit,
    attachmentPending,
    onSubmit,
    activeTurnStatus,
    stopDisabled,
    onStopTurn,
    disabledHint,
    stopPlacement,
  } = props;

  if (activeTurnStatus === null) {
    return (
      <SendButton
        canSubmit={canSubmit}
        attachmentPending={attachmentPending}
        onSubmit={onSubmit}
        disabledHint={disabledHint}
        queueing={false}
      />
    );
  }

  const stop = (
    <StopButton
      activeTurnStatus={activeTurnStatus}
      disabled={stopDisabled || onStopTurn === null}
      onStopTurn={onStopTurn}
    />
  );
  if (stopPlacement === "replace") return stop;
  return (
    <>
      {stop}
      <SendButton
        // The submit hook refuses sends while stopping; show it rather than
        // swallow the tap.
        canSubmit={activeTurnStatus === "stopping" ? false : canSubmit}
        attachmentPending={attachmentPending}
        onSubmit={onSubmit}
        disabledHint={disabledHint}
        queueing
      />
    </>
  );
}

export const ComposerSendButton = memo(ComposerSendButtonImpl);

interface SendButtonProps {
  canSubmit: boolean;
  attachmentPending: boolean;
  onSubmit: () => void;
  disabledHint: string | null;
  /** True while a turn runs and a press queues rather than sends. */
  queueing: boolean;
}

function SendButton(props: SendButtonProps) {
  const { canSubmit, attachmentPending, onSubmit, disabledHint, queueing } =
    props;
  // Hint mode (e.g. no workspace) marks the button `aria-disabled` rather than
  // using the `disabled` attribute, so it stays focusable and the styled
  // TooltipWrapper's hint is reachable by hover and keyboard focus (a native
  // `title` is suppressed on a disabled <button>). Other disabled states keep
  // the real `disabled` attribute and the native title.
  const hintActive = disabledHint !== null;
  const label = queueing ? "Queue" : "Send";

  const button = (
    <TooltipWrapper
      label={hintActive ? undefined : label}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="inline-flex">
        <Button
          type="button"
          size="icon"
          onClick={hintActive ? undefined : onSubmit}
          disabled={hintActive ? false : !canSubmit}
          aria-disabled={hintActive || undefined}
          aria-label={label}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          className={cn(
            BUTTON_CLASS_NAME,
            "bg-primary text-primary-foreground hover:bg-primary/90",
          )}
        >
          {sendButtonIcon(attachmentPending)}
        </Button>
      </span>
    </TooltipWrapper>
  );

  if (!hintActive) return button;

  return (
    <TooltipWrapper
      label={disabledHint}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="inline-flex">{button}</span>
    </TooltipWrapper>
  );
}

interface StopButtonProps {
  activeTurnStatus: ChatActiveTurn["status"];
  disabled: boolean;
  onStopTurn: (() => void) | null;
}

function StopButton(props: StopButtonProps) {
  const { activeTurnStatus, disabled, onStopTurn } = props;
  const label = activeTurnStatus === "stopping" ? "Stopping" : "Stop";
  return (
    <TooltipWrapper
      label="Stop assistant turn"
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="inline-flex">
        <Button
          type="button"
          size="icon"
          onClick={onStopTurn ?? undefined}
          disabled={disabled}
          aria-label={label}
          data-testid="chat-stop-button"
          className={cn(
            BUTTON_CLASS_NAME,
            "bg-foreground/8 text-foreground hover:bg-foreground/10",
          )}
        >
          <Square className="size-3.5 fill-current" />
        </Button>
      </span>
    </TooltipWrapper>
  );
}

function sendButtonIcon(attachmentPending: boolean): ReactNode {
  if (attachmentPending) {
    return (
      <AgentSpinningDots
        className="text-current"
        testId="composer-attachment-pending"
        variant={undefined}
      />
    );
  }
  return <ArrowUp className="size-4" />;
}
