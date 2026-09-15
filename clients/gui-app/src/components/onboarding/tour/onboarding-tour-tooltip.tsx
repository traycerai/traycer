import { useEffect, useRef, type MouseEvent } from "react";
import { XIcon } from "lucide-react";
import type { TooltipRenderProps } from "react-joyride";
import {
  armFocusNextCard,
  consumeFocusNextCard,
} from "@/components/onboarding/tour/tour-activation";
import { tourStepAction } from "@/components/onboarding/tour/tour-steps";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";

/**
 * The spotlight card. A plain popover-toned panel composed from the shadcn
 * Button / Kbd primitives - not a Dialog, not a Popover, so there is no
 * second positioner under Joyride's floater.
 *
 * Accessibility is set by hand: `role="dialog"` with `aria-modal={false}`,
 * labelled by its own title and described by its own body. Joyride's
 * `tooltipProps` are deliberately NOT spread - upstream declares
 * `alertdialog` / `aria-modal: true`, which would tell assistive tech the
 * app behind the card is unreachable when the whole point of the tour is
 * that it is not (`disableFocusTrap`, click-through cutout).
 *
 * Buttons: Next (or Finish on the last step), Skip, and an icon close
 * labelled "Pause tour" - never Back. Each hands its click to Joyride's own
 * handler; the app's flow store then reacts to the resulting event in the
 * controller, so nothing here advances twice. A step may carry one extra
 * action of its own (`tourStepAction`: "Open latest task" on an unbound
 * panels lesson), which touches the app, never the flow.
 */

export const TOUR_TOOLTIP_TITLE_ID = "onboarding-tour-title";
export const TOUR_TOOLTIP_BODY_ID = "onboarding-tour-body";

export function OnboardingTourTooltip(
  props: TooltipRenderProps,
): React.ReactElement {
  const { closeProps, index, isLastStep, primaryProps, size, skipProps, step } =
    props;
  const cardRef = useRef<HTMLDivElement>(null);
  const action = tourStepAction(step);

  // Keyboard Next moves focus into the NEXT card (a mouse click leaves focus
  // where the pointer put it). A click with `detail === 0` is a keyboard
  // activation; the intent is scoped to the current activation and is never
  // armed by a final Finish (see `tour-activation.ts`).
  useEffect(() => {
    if (!consumeFocusNextCard()) return;
    cardRef.current?.focus({ preventScroll: true });
  }, []);

  const handlePrimary = (event: MouseEvent<HTMLElement>): void => {
    if (event.detail === 0 && !isLastStep) armFocusNextCard();
    primaryProps.onClick(event);
  };

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-modal={false}
      aria-labelledby={TOUR_TOOLTIP_TITLE_ID}
      aria-describedby={TOUR_TOOLTIP_BODY_ID}
      tabIndex={-1}
      data-testid="onboarding-tour-card"
      data-tour-step={step.id}
      className="w-full max-w-[min(24rem,var(--safe-area-width))] rounded-xl bg-popover p-4 text-popover-foreground ring-1 ring-foreground/10 outline-none"
    >
      <div className="flex items-start justify-between gap-2">
        <h2
          id={TOUR_TOOLTIP_TITLE_ID}
          className="font-heading text-ui leading-tight font-medium"
        >
          {step.title}
        </h2>
        <Button
          variant="ghost"
          size="icon-xs"
          className="-mt-1 -mr-1 shrink-0"
          aria-label="Pause tour"
          data-action="close"
          onClick={closeProps.onClick}
        >
          <XIcon />
        </Button>
      </div>
      <p
        id={TOUR_TOOLTIP_BODY_ID}
        className="mt-1 text-ui-sm text-muted-foreground"
      >
        {step.content}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span
          className="text-ui-xs text-muted-foreground"
          data-testid="onboarding-tour-step-count"
        >
          {index + 1} of {size}
        </span>
        <span className="ml-auto inline-flex items-center gap-1 text-ui-xs text-muted-foreground">
          <Kbd>Esc</Kbd> pause
        </span>
        {action === null ? null : (
          <Button
            variant="secondary"
            size="sm"
            data-action="step-action"
            onClick={action.run}
          >
            {action.label}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          data-action="skip"
          onClick={skipProps.onClick}
        >
          Skip
        </Button>
        <Button size="sm" data-action="primary" onClick={handlePrimary}>
          {isLastStep ? "Finish" : "Next"}
        </Button>
      </div>
    </div>
  );
}
