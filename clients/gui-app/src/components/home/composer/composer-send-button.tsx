import { ArrowUp, Square } from "lucide-react";
import { memo, useCallback, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import { cn } from "@/lib/utils";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";

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
}

function ComposerSendButtonImpl(props: ComposerSendButtonProps) {
  const {
    canSubmit,
    attachmentPending,
    onSubmit,
    activeTurnStatus,
    stopDisabled,
    onStopTurn,
    disabledHint,
  } = props;
  const stopMode = activeTurnStatus !== null;
  const disabled = stopMode
    ? stopDisabled || onStopTurn === null
    : !canSubmit || disabledHint !== null;
  const label = composerSendButtonLabel(activeTurnStatus);
  // Hint mode (e.g. no workspace) marks the button `aria-disabled` rather than
  // using the `disabled` attribute, so it stays focusable and the styled
  // TooltipWrapper's hint is reachable by hover and keyboard focus (a native
  // `title` is suppressed on a disabled <button>). Other disabled states keep
  // the real `disabled` attribute and the native Send/Stop title.
  const hintActive = !stopMode && disabledHint !== null;
  const buttonTitle = stopMode ? "Stop assistant turn" : "Send";
  const submitOrStopTurn = useCallback(() => {
    if (hintActive) return;
    if (!stopMode) {
      onSubmit();
      return;
    }
    if (onStopTurn === null) return;
    onStopTurn();
  }, [hintActive, onStopTurn, onSubmit, stopMode]);
  const buttonClassName = cn(
    "size-8 rounded-full disabled:bg-muted disabled:text-muted-foreground aria-disabled:cursor-not-allowed aria-disabled:bg-muted aria-disabled:text-muted-foreground aria-disabled:hover:bg-muted",
    stopMode
      ? "bg-muted text-foreground hover:bg-muted/80"
      : "bg-primary text-primary-foreground hover:bg-primary/90",
  );

  const button = (
    <Button
      type="button"
      size="icon"
      onClick={submitOrStopTurn}
      disabled={hintActive ? false : disabled}
      aria-disabled={hintActive || undefined}
      aria-label={label}
      title={hintActive ? undefined : buttonTitle}
      data-testid={stopMode ? "chat-stop-button" : undefined}
      className={buttonClassName}
    >
      {composerSendButtonIcon(attachmentPending, stopMode)}
    </Button>
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

export const ComposerSendButton = memo(ComposerSendButtonImpl);

function composerSendButtonIcon(
  attachmentPending: boolean,
  stopMode: boolean,
): ReactNode {
  if (attachmentPending && !stopMode) {
    return (
      <AgentSpinningDots
        className="text-current"
        testId="composer-attachment-pending"
        variant={undefined}
      />
    );
  }
  if (stopMode) return <Square className="size-3.5 fill-current" />;
  return <ArrowUp className="size-4" />;
}

function composerSendButtonLabel(
  activeTurnStatus: ChatActiveTurn["status"] | null,
): string {
  if (activeTurnStatus === null) return "Send";
  if (activeTurnStatus === "stopping") return "Stopping";
  return "Stop";
}
