import { ArrowUp, Square } from "lucide-react";
import { memo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
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

const BUTTON_CLASS_NAME =
  "size-8 rounded-full disabled:bg-foreground/8 disabled:text-muted-foreground aria-disabled:cursor-not-allowed aria-disabled:bg-foreground/8 aria-disabled:text-muted-foreground aria-disabled:hover:bg-foreground/8";

/**
 * Invisible hit slop taking the 32px control to the 44px touch-target
 * guideline, the same `::after` shape `chat-message-user-body` uses. Visual
 * size and layout are untouched - `Button` renders no `::after` of its own, so
 * nothing merges with it.
 *
 * Applied ONLY to the side-by-side pair below. A 44px box is wider than the
 * control, so on a toolbar of flush 4px-apart neighbours it would swallow
 * their taps - which is why `home-touch-targets.css` keeps its slop
 * vertical-only. The pair earns horizontal slop by widening its own gap to
 * 12px: 32 + 12 = 44, so the two targets meet exactly and never overlap. Do
 * not lift this onto the rest of the toolbar without doing the same.
 */
const TOUCH_SLOP_CLASS_NAME =
  "relative after:absolute after:-inset-1.5 after:content-['']";

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
  // On a phone-width viewport Return inserts a newline (`chat-list-keymap`),
  // so this button is the only way to queue a message mid-turn: Stop renders
  // beside Send there instead of replacing it. Same VIEWPORT signal as the
  // keymap, so the two can never disagree.
  const stopBesideSend = useIsMobileViewport();

  if (activeTurnStatus === null) {
    return (
      <SendButton
        canSubmit={canSubmit}
        attachmentPending={attachmentPending}
        onSubmit={onSubmit}
        disabledHint={disabledHint}
        queueing={false}
        touchSlop={false}
      />
    );
  }

  const stop = (
    <StopButton
      activeTurnStatus={activeTurnStatus}
      disabled={stopDisabled || onStopTurn === null}
      onStopTurn={onStopTurn}
      touchSlop={stopBesideSend}
    />
  );
  if (!stopBesideSend) return stop;
  // Both spacings exist to hold the 44px targets apart, and both are needed.
  // `gap-3` separates Stop from Send: 32 + 12 = 44, so their targets meet
  // exactly. `ml-2` widens the toolbar's own gap-1 to 12px on the left, where
  // the mic button sits - without it Stop's slop would reach 2px across the
  // mic and take taps meant for it, which is the very failure being fixed.
  // Send needs no equivalent on the right; it is last, inside the row's
  // 10px padding.
  return (
    <span className="ml-2 flex items-center gap-3">
      {stop}
      <SendButton
        // The submit hook refuses sends while stopping; show it rather than
        // swallow the tap.
        canSubmit={activeTurnStatus === "stopping" ? false : canSubmit}
        attachmentPending={attachmentPending}
        onSubmit={onSubmit}
        disabledHint={disabledHint}
        queueing
        touchSlop
      />
    </span>
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
  /** Widen the hit area to 44px - only where the pair has room for it. */
  touchSlop: boolean;
}

function SendButton(props: SendButtonProps) {
  const {
    canSubmit,
    attachmentPending,
    onSubmit,
    disabledHint,
    queueing,
    touchSlop,
  } = props;
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
          className={cn(BUTTON_CLASS_NAME, touchSlop && TOUCH_SLOP_CLASS_NAME)}
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
  /** Widen the hit area to 44px - only where the pair has room for it. */
  touchSlop: boolean;
}

function StopButton(props: StopButtonProps) {
  const { activeTurnStatus, disabled, onStopTurn, touchSlop } = props;
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
            touchSlop && TOUCH_SLOP_CLASS_NAME,
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
        className={undefined}
        testId="composer-attachment-pending"
        variant={undefined}
      />
    );
  }
  return <ArrowUp className="size-4" />;
}
