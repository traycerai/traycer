import { useMemo } from "react";
import { Joyride, type Styles } from "react-joyride";
import { OnboardingTourTooltip } from "@/components/onboarding/tour/onboarding-tour-tooltip";
import {
  TOUR_SCROLL_DURATION_MS,
  TOUR_SPOTLIGHT_PADDING_PX,
  TOUR_SPOTLIGHT_RADIUS_PX,
  TOUR_TARGET_WAIT_TIMEOUT_MS,
  TOUR_Z_INDEX,
} from "@/components/onboarding/tour/tour-steps";
import { useOnboardingTourController } from "@/components/onboarding/tour/use-onboarding-tour-controller";
import { useSafeAreaCollisionPadding } from "@/components/ui/safe-area-collision-padding";

/**
 * The one spotlight-tour renderer. Mounted once at shell level by the
 * onboarding flow host (ticket 4), OUTSIDE every epic surface / pane
 * provider: it spotlights surfaces, it does not live in one.
 *
 * Everything below is the react-joyride 3.2 configuration the spike
 * verified (`spotlight-tours/spike-evidence`), driven by
 * `useOnboardingTourController`. Nothing here is a second overlay, a second
 * positioner or a second copy of the flow's progress.
 */
export function OnboardingTour(): React.ReactElement | null {
  const controller = useOnboardingTourController();
  const safeArea = useSafeAreaCollisionPadding();
  const { reducedMotion } = controller;

  const styles = useMemo<Partial<Styles>>(
    () =>
      reducedMotion
        ? { floater: { transition: "none" }, overlay: { transition: "none" } }
        : {},
    [reducedMotion],
  );
  const floatingOptions = useMemo(
    () => ({
      flipOptions: { padding: safeArea },
      // `crossAxis`: a viewport-tall target (the sidebar column) in a narrow
      // window flips the card to top/bottom, and without cross-axis shift
      // it lands above the viewport (spike finding F7).
      shiftOptions: { padding: safeArea, crossAxis: true },
      // The card is a popover-toned panel; upstream's white arrow would sit
      // on it like a sticker (F9).
      hideArrow: true,
    }),
    [safeArea],
  );

  if (controller.steps.length === 0) return null;

  return (
    <>
      <div
        aria-live="polite"
        className="sr-only"
        data-testid="onboarding-tour-live"
      >
        {controller.announcement}
      </div>
      <Joyride
        key={controller.rendererKey}
        run={controller.run}
        stepIndex={controller.stepIndex}
        continuous
        scrollToFirstStep
        steps={controller.steps}
        onEvent={controller.onEvent}
        tooltipComponent={OnboardingTourTooltip}
        // No spinner either: the anchored step hides its overlay until the
        // card presents, and a lone spinner on an undimmed app would read
        // as the app loading.
        loaderComponent={null}
        styles={styles}
        floatingOptions={floatingOptions}
        options={{
          buttons: ["primary", "skip", "close"],
          skipBeacon: true,
          disableFocusTrap: true,
          // No dismissal on an outside click - and no click shield either:
          // `index.css` takes the dim's SVG path out of hit-testing, so the
          // app under it stays clickable (decision 7 is about the tour).
          overlayClickAction: false,
          blockTargetInteraction: false,
          dismissKeyAction: controller.modalSuspended ? false : "close",
          zIndex: TOUR_Z_INDEX,
          overlayColor: "var(--onboarding-tour-overlay)",
          spotlightPadding: TOUR_SPOTLIGHT_PADDING_PX,
          spotlightRadius: TOUR_SPOTLIGHT_RADIUS_PX,
          skipScroll: false,
          targetWaitTimeout: TOUR_TARGET_WAIT_TIMEOUT_MS,
          scrollDuration: reducedMotion ? 0 : TOUR_SCROLL_DURATION_MS,
        }}
      />
    </>
  );
}
