import {
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useIsMutating } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { AnimatePresence, m } from "motion/react";
import { traycerInfo } from "@traycer-clients/shared/platform/traycer-info";
import geistPixelSquareUrl from "@/assets/fonts/GeistPixel-Square.woff2?url";
import onboardingBackdropUrl from "@/assets/brand/gradient-bg.jpg?url";
import { BrandMark } from "@/components/auth/cinematic-backdrop";
import {
  actEyebrow,
  actUsesSoloStage,
  onboardingActsFor,
  type DesktopOnboardingActId,
  type OnboardingAct,
  type OnboardingActId,
} from "@/components/onboarding/onboarding-acts";
import {
  OnboardingAgentGuidePane,
  type OnboardingAgentGuideState,
} from "@/components/onboarding/onboarding-agent-guide-pane";
import { OnboardingDetectedAgents } from "@/components/onboarding/onboarding-detected-agents";
import { OnboardingDiorama } from "@/components/onboarding/onboarding-diorama";
import {
  OnboardingPhoneDiorama,
  type OnboardingPhoneSceneId,
} from "@/components/onboarding/onboarding-phone-diorama";
import { OnboardingLoginImportStage } from "@/components/onboarding/onboarding-login-import-stage";
import { OnboardingSessionImportStage } from "@/components/onboarding/onboarding-session-import-stage";
import { OnboardingThemePicker } from "@/components/onboarding/onboarding-theme-picker";
import { useAgentSelectionGuideGlobalOnboardingDraftQuery } from "@/hooks/agent/use-agent-selection-guide-global-onboarding-draft-query";
import { useAgentSelectionGuideSetGlobalMutation } from "@/hooks/agent/use-agent-selection-guide-set-global-mutation";
import { useLoginImportAvailable } from "@/hooks/browser/use-login-import-available";
import { useSessionImportAvailable } from "@/hooks/session-import/use-session-import-available";
import { browserMutationKeys } from "@/lib/query-keys";
import { getClientAppVersionLabel } from "@/lib/app-version";
import { shortcutHintsVisible } from "@/lib/keybindings/shortcut-hints";
import { useOpenLink } from "@/lib/links/open-link";
import { isMobileApp } from "@/lib/mobile-app";
import { readSafeAreaInsets } from "@/lib/safe-area-insets";
import {
  clampOnboardingStep,
  isLastOnboardingStep,
  useOnboardingStore,
} from "@/stores/onboarding/onboarding-store";
import { useOnboardingTourOpenStore } from "@/stores/onboarding/onboarding-tour-open-store";
import { cn } from "@/lib/utils";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { onMiddleClick } from "@/lib/dom/on-middle-click";

const ACT_EASE = [0.32, 0.72, 0, 1] as const;
const ONBOARDING_FOOTER_LINKS = [
  { label: "Features", url: traycerInfo.mainWebsiteFeatures },
  { label: "Enterprise", url: traycerInfo.mainWebsiteEnterprise },
  { label: "Support", url: traycerInfo.mainWebsiteContactUs },
] as const;
const ONBOARDING_STYLE = `
@font-face {
  font-family: "Geist Pixel Square";
  src: url("${geistPixelSquareUrl}") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}

.onboarding-shell {
  --onboarding-shell-rows: 4.125rem minmax(0, 1fr) 4rem;
  --onboarding-section-x: 1.5rem;
  --onboarding-stage-pad: clamp(1.75rem, 3.3333vw, 3rem);
  --onboarding-stage-bottom-pad: clamp(5.25rem, 7vw, 6.5rem);
  --onboarding-stage-gap: 2rem;
  --onboarding-copy-rail-top: 3rem;
  --onboarding-copy-gap: 1.5rem;
  --onboarding-copy-inner-gap: 1rem;
  --onboarding-progress-height: 0.375rem;
  --onboarding-progress-width: min(16.5rem, 100%);
  --onboarding-eyebrow-size: 1rem;
  --onboarding-title-size: 1.5rem;
  --onboarding-title-leading: 1.25;
  --onboarding-body-size: 1.125rem;
  --onboarding-body-leading: 1.625rem;
  --onboarding-body-width: 17rem;
  --onboarding-addon-width: 28rem;
  --onboarding-diorama-width: min(100%, 44rem);
  --onboarding-diorama-max-height: min(48vh, 31rem);
  --onboarding-action-inset: clamp(1.75rem, 3.3333vw, 3rem);
}

.onboarding-stage-content {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  gap: var(--onboarding-stage-gap);
  padding: var(--onboarding-stage-pad);
  padding-bottom: var(--onboarding-stage-bottom-pad);
}

/* When the mini-app is dropped (providers act, and the mobile tour's agent
   guide), the addon owns the remaining space so long provider catalogs and the
   guide editor can scroll. */
.onboarding-stage-content--solo {
  grid-template-rows: minmax(0, 1fr);
}

.onboarding-stage-content--solo .onboarding-copy-rail {
  align-self: stretch;
  min-height: 0;
}

.onboarding-stage-content--solo .onboarding-copy-rail > :last-child {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.onboarding-stage-content--solo .onboarding-copy {
  min-height: 0;
  flex: 1 1 auto;
}

.onboarding-copy-rail {
  padding-top: var(--onboarding-copy-rail-top);
}

.onboarding-copy {
  gap: var(--onboarding-copy-gap);
}

.onboarding-copy-inner {
  gap: var(--onboarding-copy-inner-gap);
}

.onboarding-progress {
  height: var(--onboarding-progress-height);
  width: var(--onboarding-progress-width);
}

.onboarding-copy-kicker {
  font-size: var(--onboarding-eyebrow-size);
}

.onboarding-title {
  font-size: var(--onboarding-title-size);
  line-height: var(--onboarding-title-leading);
}

.onboarding-body {
  max-width: var(--onboarding-body-width);
  font-size: var(--onboarding-body-size);
  line-height: var(--onboarding-body-leading);
}

.onboarding-addon {
  max-width: var(--onboarding-addon-width);
}

.onboarding-diorama-wrap {
  max-width: var(--onboarding-diorama-width);
}

.onboarding-actions {
  right: var(--onboarding-action-inset);
  bottom: var(--onboarding-action-inset);
}

@media (min-width: 640px) {
  .onboarding-shell {
    --onboarding-title-size: 2.875rem;
    --onboarding-title-leading: 1.28;
    --onboarding-body-width: 39rem;
  }
}

@media (min-width: 1024px) {
  .onboarding-stage-content {
    grid-template-columns: minmax(18rem, 0.52fr) minmax(0, 1.48fr);
    grid-template-rows: minmax(0, 1fr);
  }

  /* An act with no miniature at all (mobile providers / agent guide) has one
     child, so it must not be held to the left track of the two-column grid on
     a wide phone or a tablet. */
  .onboarding-stage-content--no-miniature {
    grid-template-columns: minmax(0, 1fr);
  }

  .onboarding-shell {
    --onboarding-stage-gap: clamp(2rem, 3vw, 3rem);
    --onboarding-body-width: 34rem;
    --onboarding-diorama-width: 100%;
    --onboarding-diorama-max-height: min(64vh, 42rem);
  }
}

@media (min-height: 920px) {
  .onboarding-shell {
    --onboarding-stage-gap: 3rem;
    --onboarding-copy-rail-top: 7rem;
    --onboarding-copy-gap: 1.75rem;
    --onboarding-copy-inner-gap: 1.25rem;
    --onboarding-progress-height: 0.5rem;
    --onboarding-progress-width: min(19rem, 100%);
    --onboarding-eyebrow-size: 1.125rem;
    --onboarding-title-size: 3.5rem;
    --onboarding-title-leading: 1.2;
    --onboarding-body-size: 1.25rem;
    --onboarding-body-leading: 1.875rem;
    --onboarding-body-width: 36rem;
    --onboarding-addon-width: 34rem;
    --onboarding-diorama-max-height: min(66vh, 46rem);
  }
}

@media (max-width: 1023px) and (min-height: 920px) {
  .onboarding-shell {
    --onboarding-copy-rail-top: 3rem;
    --onboarding-title-size: 2.875rem;
    --onboarding-title-leading: 1.22;
    --onboarding-body-size: 1.125rem;
    --onboarding-body-leading: 1.625rem;
    --onboarding-diorama-max-height: min(40vh, 28rem);
  }
}

@media (max-height: 820px) {
  .onboarding-shell {
    --onboarding-shell-rows: 3.5rem minmax(0, 1fr) 3rem;
    --onboarding-stage-pad: 1.5rem;
    --onboarding-stage-bottom-pad: 4.75rem;
    --onboarding-stage-gap: 1.75rem;
    --onboarding-copy-rail-top: 1.5rem;
    --onboarding-copy-gap: 1rem;
    --onboarding-copy-inner-gap: 0.75rem;
    --onboarding-progress-width: min(14rem, 100%);
    --onboarding-eyebrow-size: 0.875rem;
    --onboarding-title-size: 2.25rem;
    --onboarding-title-leading: 1.18;
    --onboarding-body-size: 1rem;
    --onboarding-body-leading: 1.4rem;
    --onboarding-body-width: 34rem;
    --onboarding-addon-width: 25rem;
    --onboarding-diorama-max-height: min(72vh, 40rem);
    --onboarding-action-inset: 1.5rem;
  }
}

@media (max-height: 700px) {
  .onboarding-shell {
    --onboarding-shell-rows: 3.25rem minmax(0, 1fr) 2.75rem;
    --onboarding-stage-pad: 1rem;
    --onboarding-stage-bottom-pad: 4rem;
    --onboarding-stage-gap: 1rem;
    --onboarding-copy-rail-top: 0.75rem;
    --onboarding-copy-gap: 0.75rem;
    --onboarding-copy-inner-gap: 0.5rem;
    --onboarding-progress-height: 0.25rem;
    --onboarding-progress-width: min(12rem, 100%);
    --onboarding-eyebrow-size: 0.75rem;
    --onboarding-title-size: 1.875rem;
    --onboarding-body-size: 0.875rem;
    --onboarding-body-leading: 1.25rem;
    --onboarding-body-width: 30rem;
    --onboarding-addon-width: 22rem;
    --onboarding-diorama-max-height: min(70vh, 34rem);
    --onboarding-action-inset: 1rem;
  }
}

@media (max-width: 1023px) {
  .onboarding-stage-content {
    max-width: min(100%, 58rem);
  }

  /* Stacked layout: eyebrow + progress moved to the bottom bar, so the copy
     starts right under the stage padding. Sizing is fluid (clamp on the
     viewport) rather than stepped, so it shrinks to fit instead of scrolling. */
  .onboarding-shell {
    --onboarding-copy-rail-top: 0rem;
    --onboarding-stage-pad: clamp(0.75rem, 2.2vh, 1.5rem);
    --onboarding-stage-bottom-pad: clamp(3.5rem, 8vh, 4.5rem);
    --onboarding-stage-gap: clamp(0.75rem, 2vh, 1.5rem);
    --onboarding-copy-gap: clamp(0.5rem, 1.6vh, 1rem);
    --onboarding-copy-inner-gap: clamp(0.375rem, 1.2vh, 0.75rem);
    --onboarding-title-size: clamp(1.5rem, 4.6vw, 2.625rem);
    --onboarding-title-leading: 1.15;
    --onboarding-body-size: clamp(0.875rem, 1.6vw, 1.0625rem);
    --onboarding-body-leading: 1.4;
  }

  /* Actions become a full-width bottom bar so the progress bar can share the
     row (left) with Back / Continue (right). */
  .onboarding-actions {
    left: var(--onboarding-action-inset);
    right: var(--onboarding-action-inset);
  }
}

@media (max-width: 639px) {
  .onboarding-shell {
    --onboarding-section-x: 0.75rem;
    --onboarding-stage-pad: 1.125rem;
    --onboarding-stage-bottom-pad: 4.5rem;
    --onboarding-stage-gap: 1rem;
    --onboarding-copy-rail-top: 1rem;
    --onboarding-eyebrow-size: 0.75rem;
    --onboarding-title-size: 1.5rem;
    --onboarding-title-leading: 1.2;
    --onboarding-body-size: 0.9375rem;
    --onboarding-body-leading: 1.35rem;
    --onboarding-body-width: 100%;
    --onboarding-diorama-width: min(100%, 24rem);
  }
}

/* Installed mobile app only - the class is set off isMobileApp(), never the
   viewport, so a narrow desktop window keeps the exact desktop pixels. The
   tour claims the phone: the version footer goes and its grid row collapses,
   gutters tighten, and the freed height flows to the stage card so the
   miniature can breathe. Actions and progress drop low to hug the card's
   bottom edge. Declared after every media tier, so these win at any size. */
.onboarding-shell--mobile-app {
  --onboarding-shell-rows: 3.5rem minmax(0, 1fr) 0rem;
  --onboarding-section-x: 0.5rem;
  --onboarding-stage-pad: clamp(1rem, 2.4vh, 1.5rem);
  --onboarding-stage-bottom-pad: 4.25rem;
  --onboarding-stage-gap: clamp(0.875rem, 2vh, 1.25rem);
  --onboarding-copy-rail-top: 0.5rem;
  --onboarding-action-inset: 1rem;
  --onboarding-diorama-max-height: min(58vh, 36rem);
  --onboarding-body-width: 21rem;
}

.onboarding-shell--mobile-app footer {
  display: none;
}

/* Chrome-level polish scoped to the installed app: rounded hairline progress
   segments and softer button corners. Same-specificity utilities lose to the
   two-class selectors, which is the point - no component code branches. */
.onboarding-shell--mobile-app .onboarding-progress {
  gap: 0.25rem;
}

.onboarding-shell--mobile-app .onboarding-progress span {
  border-radius: 9999px;
}

.onboarding-shell--mobile-app .onboarding-actions button {
  border-radius: 0.625rem;
}

/* One orchestrated entrance per act: eyebrow band, then copy, then addon rise
   in turn. The act wrapper remounts per act (key=act.id), so the beat replays
   on every advance. */
@keyframes onboarding-copy-rise {
  from {
    opacity: 0;
    transform: translateY(0.5rem);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

.onboarding-shell--mobile-app .onboarding-copy > * {
  animation: onboarding-copy-rise 0.45s cubic-bezier(0.32, 0.72, 0, 1) both;
}

.onboarding-shell--mobile-app .onboarding-copy > :nth-child(2) {
  animation-delay: 80ms;
}

.onboarding-shell--mobile-app .onboarding-copy > :nth-child(3) {
  animation-delay: 160ms;
}

@media (prefers-reduced-motion: reduce) {
  .onboarding-shell--mobile-app .onboarding-copy > * {
    animation: none;
  }
}`;

/**
 * How far a drag must travel sideways before it changes act. Absolute, like
 * every other touch threshold in this app: a thumb covers the same distance on
 * a small phone as on a tablet, so a fraction of the viewport would be a flick
 * on one and a haul on the other.
 */
const ACT_SWIPE_COMMIT_PX = 56;

/**
 * How decisively the horizontal travel must beat the vertical at the release.
 * The stage carries the tour's only scrolling surfaces - the provider catalog
 * and the agent-guide editor - so "mostly sideways" is not enough: a diagonal a
 * scroller could plausibly own stays with the scroller.
 */
const ACT_SWIPE_DOMINANCE = 1.5;

/**
 * Cross-axis travel that abandons the gesture, judged on every MOVE rather than
 * only at the release. A finger that has already scrolled the providers list is
 * not owed an act change because it happened to drift back to level on its way
 * out, and reading the endpoints alone cannot tell those two drags apart.
 */
const ACT_SWIPE_CROSS_FAIL_PX = 24;

/**
 * The strip at each side of the screen the platform's own back/forward swipes
 * own - the same 32px `use-edge-nav-swipe.ts` reserves, measured the same way
 * (from the app surface, so a landscape sensor housing moves the zone rather
 * than swallowing it). The platform's own navigation must keep working over
 * the tour, so the tour never answers a swipe that starts in its strip.
 */
const ACT_SWIPE_EDGE_ZONE_PX = 32;

/**
 * Targets a swipe is never taken from: the keyboard handler's guard
 * (`button, a, input, textarea, select`) plus `[contenteditable]`. The extra
 * arm is the agent-guide act, whose editor is a CodeMirror surface rather than
 * a `textarea` - a horizontal drag inside it is the caret being pulled through
 * the text, not a request for the next act.
 */
const ACT_SWIPE_EXEMPT_TARGETS =
  "button, a, input, textarea, select, [contenteditable]";

/**
 * What Skip / Back / Continue are worth in height on the shell they are playing
 * in: nothing on desktop, which keeps its own tiers, and iOS's 44pt floor on
 * the installed app, where 36px is under what a thumb can reliably hit.
 *
 * The tall-viewport tier is restated rather than left to cascade. A modern
 * phone clears `min-height: 920px` in portrait, and `tailwind-merge` only
 * displaces a class whose modifiers match - so without it exactly those phones
 * would fall through to the desktop's 40px bump.
 *
 * Resolved once and handed to all three buttons, rather than branched at each
 * of them: the page answers the platform question in one place per concern.
 */
function actionHeightClass(mobileApp: boolean): string {
  return mobileApp ? "h-11 [@media(min-height:920px)]:h-11" : "";
}

type ActSwipeDirection = "forward" | "back";

interface ActSwipeTracking {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  /** Set once the drag declares itself vertical. Never unset - direction lock. */
  abandoned: boolean;
}

/** Whether a touch landed in the strip the platform's navigation swipes own. */
function withinActSwipeEdgeZone(clientX: number): boolean {
  const insets = readSafeAreaInsets();
  if (clientX <= insets.left + ACT_SWIPE_EDGE_ZONE_PX) return true;
  return clientX >= window.innerWidth - insets.right - ACT_SWIPE_EDGE_ZONE_PX;
}

/**
 * Horizontal swipe across the stage: left for the next act, right for the
 * previous one. The tour teaches a swipe-native app, so it should answer one.
 *
 * It reports a DIRECTION and nothing else. What that leads to is the page's
 * business, and the page spends it on the very callbacks the Back and Continue
 * buttons call - so the agent-guide save gate, the finish-on-the-last-act
 * branch and the navigation analytics all hold with no second copy of any of
 * them. Nothing here is lower-level than the buttons.
 *
 * Mobile only, and inert rather than merely quiet on desktop: the effect
 * installs no listeners at all there. A narrow desktop window renders the same
 * stacked layout, and a horizontal drag in one is a trackpad scroll.
 *
 * The recognizer is deliberately small. It never calls `preventDefault`, so it
 * takes nothing from the scrollers underneath it and nothing from text
 * selection; the price is that it cannot reserve a gesture from the web view's
 * scroller the way the shell's edge swipe must, which it does not need to -
 * there is nothing on the stage that pans sideways to lose the race to.
 *
 * A pointer passes through two states. It is undecided until the release,
 * except that a move whose vertical travel dominates abandons it outright: that
 * is what keeps a scroll of the provider catalog from ending as an act change,
 * and it is judged while the drag is happening rather than from where it
 * finished.
 *
 * Down on the surface, move and release on the window, so a swipe that leaves
 * the stage mid-flight still completes rather than being stranded.
 */
function useActSwipe(
  surfaceRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  onSwipe: (direction: ActSwipeDirection) => void,
): void {
  // Read at event time, never closed over: the listeners are installed once and
  // must not be torn down and rebuilt on every act change.
  const onSwipeRef = useRef(onSwipe);
  useEffect(() => {
    onSwipeRef.current = onSwipe;
  });

  useEffect(() => {
    if (!enabled) return;
    const surface = surfaceRef.current;
    if (surface === null) return;
    let tracking: ActSwipeTracking | null = null;

    const handlePointerDown = (event: PointerEvent): void => {
      // A second finger is a pinch or a two-finger pan; the tracked pointer's
      // coordinates stop describing the gesture either way.
      tracking = null;
      if (!event.isPrimary) return;
      if (withinActSwipeEdgeZone(event.clientX)) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(ACT_SWIPE_EXEMPT_TARGETS) !== null
      ) {
        return;
      }
      tracking = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        abandoned: false,
      };
    };

    const handlePointerMove = (event: PointerEvent): void => {
      const started = tracking;
      if (started === null) return;
      if (event.pointerId !== started.pointerId) return;
      if (started.abandoned) return;
      const crossPx = Math.abs(event.clientY - started.startY);
      if (crossPx <= ACT_SWIPE_CROSS_FAIL_PX) return;
      if (crossPx >= Math.abs(event.clientX - started.startX)) {
        started.abandoned = true;
      }
    };

    const handlePointerUp = (event: PointerEvent): void => {
      const started = tracking;
      if (started === null) return;
      if (event.pointerId !== started.pointerId) return;
      tracking = null;
      if (started.abandoned) return;
      const travelPx = event.clientX - started.startX;
      const crossPx = Math.abs(event.clientY - started.startY);
      if (Math.abs(travelPx) < ACT_SWIPE_COMMIT_PX) return;
      if (Math.abs(travelPx) < crossPx * ACT_SWIPE_DOMINANCE) return;
      onSwipeRef.current(travelPx < 0 ? "forward" : "back");
    };

    const handlePointerCancel = (event: PointerEvent): void => {
      if (tracking === null) return;
      if (event.pointerId !== tracking.pointerId) return;
      tracking = null;
    };

    const options = { passive: true };
    surface.addEventListener("pointerdown", handlePointerDown, options);
    window.addEventListener("pointermove", handlePointerMove, options);
    window.addEventListener("pointerup", handlePointerUp, options);
    window.addEventListener("pointercancel", handlePointerCancel, options);
    return () => {
      surface.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, [enabled, surfaceRef]);
}

/** What an act puts in the stage's second column on the shell it plays in. */
type OnboardingMiniature =
  | { readonly kind: "desktop"; readonly actId: DesktopOnboardingActId }
  | { readonly kind: "phone"; readonly scene: OnboardingPhoneSceneId }
  | { readonly kind: "session-import" }
  | { readonly kind: "login-import" }
  | { readonly kind: "none" };

/**
 * The tour's ONE diorama branch (the act list itself is the other platform
 * read). Narrowing happens per case, so the desktop miniature only ever
 * receives an id it can draw - no cast, and a new act id fails to compile until
 * it says what it shows.
 *
 * The two acts that do real setup work drop the miniature on a phone: providers
 * already stacked to its list-only layout below `lg`, and the agent guide moves
 * its editor into the copy rail, where a phone keyboard can reach it. Session
 * import and login import are desktop-only (the mobile tour never lists
 * them), and show no miniature at all - their stages are the live wizard and
 * the live import flow.
 */
function miniatureForAct(actId: OnboardingActId): OnboardingMiniature {
  const mobile = isMobileApp();
  switch (actId) {
    case "task-tabs":
    case "navigation":
    case "command-theme":
      return { kind: "desktop", actId };
    case "task-context":
      return mobile
        ? { kind: "phone", scene: "story" }
        : { kind: "desktop", actId };
    case "providers":
    case "agent-guide":
      return mobile ? { kind: "none" } : { kind: "desktop", actId };
    case "session-import":
      return { kind: "session-import" };
    case "login-import":
      return { kind: "login-import" };
    case "mobile-tasks":
      return { kind: "phone", scene: "drawer" };
    case "mobile-switcher":
      return { kind: "phone", scene: "switcher" };
  }
}

/**
 * The stage's miniature column. The live miniature follows the user's real
 * theme on every act, so the preview always matches what the app looks like
 * for them - it renders with the same semantic tokens as the real shell.
 * Session import has no mock-up to preview: its window holds the real wizard,
 * reading the user's real machine.
 */
function OnboardingMiniatureColumn(props: {
  readonly actId: OnboardingActId;
  readonly addon: OnboardingAct["addon"];
  readonly miniature: OnboardingMiniature;
  readonly agentGuide: OnboardingAgentGuideState;
  readonly registerSessionImportSubmit: (submit: () => void) => void;
}) {
  const { actId, addon, miniature, agentGuide, registerSessionImportSubmit } =
    props;
  if (miniature.kind === "none") return null;
  const phone = miniature.kind === "phone";
  let content: ReactNode;
  if (miniature.kind === "phone") {
    content = <OnboardingPhoneDiorama scene={miniature.scene} />;
  } else if (miniature.kind === "session-import") {
    content = (
      <OnboardingSessionImportStage
        registerSubmit={registerSessionImportSubmit}
      />
    );
  } else if (miniature.kind === "login-import") {
    content = <OnboardingLoginImportStage />;
  } else {
    content = (
      <OnboardingDiorama actId={miniature.actId} agentGuide={agentGuide} />
    );
  }
  return (
    <div
      className={cn(
        "onboarding-diorama-wrap mx-auto w-full min-w-0 self-start lg:mx-0 lg:self-center",
        // The providers list carries the act on its own; drop the mini-app
        // when stacked. (Command-theme keeps its diorama, which itself shows
        // just the Cmd+K palette when stacked.)
        addon === "agents" && "max-lg:hidden",
        // The phone frame is container-led: the grid row it sits in is its
        // height budget, so it can never run under the actions bar the way a
        // viewport-led height could.
        phone && "h-full min-h-0 self-stretch",
      )}
    >
      {/* Fade the mini-app in place on each act so it never slides up from
          the bottom when reappearing (e.g. providers → handoff). */}
      <m.div
        key={actId}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.25, ease: ACT_EASE }}
        className={cn("w-full min-w-0", phone && "h-full min-h-0")}
      >
        {content}
      </m.div>
    </div>
  );
}

/**
 * Stacked screens: blur + fade the desktop mini-app's lower edge behind the
 * actions bar so it reads as a clean footer, not a cut-off pane. The phone
 * frame is height-contained by its grid row and never reaches this band, so
 * the band would only smear its bottom bezel - the desktop miniature and the
 * session-import wizard window only.
 */
function OnboardingStageEdgeFade(props: { readonly visible: boolean }) {
  if (!props.visible) return null;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 bottom-0 z-[5] h-[6rem] bg-gradient-to-t from-[#303b37] via-[#303b37]/75 to-transparent backdrop-blur-sm [mask-image:linear-gradient(to_top,black_55%,transparent)] lg:hidden"
    />
  );
}

function ActCopy(props: {
  readonly act: OnboardingAct;
  readonly eyebrow: string;
  readonly agentGuide: OnboardingAgentGuideState;
}) {
  const { act, eyebrow, agentGuide } = props;
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // Both addons that own the rest of the rail rather than sitting under the
  // body: the providers list, and the mobile tour's agent-guide editor.
  const isStretchedAddon = actUsesSoloStage(act);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <m.div
      data-testid="onboarding-act"
      data-act-id={act.id}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.28, ease: ACT_EASE }}
      className={cn(
        "onboarding-copy flex min-h-0 w-full flex-col items-center text-center lg:items-start lg:text-left",
        isStretchedAddon && "h-full",
      )}
    >
      <p className="onboarding-copy-kicker hidden font-mono leading-normal font-medium tracking-[0.07em] text-white/55 uppercase lg:block">
        {eyebrow}
      </p>
      <div className="onboarding-copy-inner flex w-full flex-col items-center lg:items-start">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="onboarding-title w-full min-w-0 max-w-full whitespace-pre-line break-words font-pixel font-normal tracking-normal text-white outline-none"
        >
          {act.title}
        </h1>
        <p className="onboarding-body w-full font-heading font-light text-white/70">
          {act.body}
        </p>
      </div>
      {act.addon === "agents" ? (
        <div className="onboarding-addon flex min-h-0 w-full flex-1 flex-col self-center overflow-hidden pt-1 text-left lg:self-start">
          <OnboardingDetectedAgents />
        </div>
      ) : null}
      {/* No `onboarding-addon` width cap here: the editor is the act on a
          phone, so it takes the rail's full width and whatever height the
          stretched layout leaves it. */}
      {act.addon === "agent-guide" ? (
        <div className="flex min-h-0 w-full flex-1 flex-col self-stretch overflow-hidden pt-1 text-left">
          <OnboardingAgentGuidePane agentGuide={agentGuide} />
        </div>
      ) : null}
      {act.addon === "theme" ? (
        <div className="onboarding-addon flex w-full flex-col items-center self-center pt-1 text-center lg:items-start lg:text-left">
          <OnboardingThemePicker />
        </div>
      ) : null}
    </m.div>
  );
}

function ProgressRail(props: {
  readonly acts: ReadonlyArray<OnboardingAct>;
  readonly activeIndex: number;
}) {
  const { acts, activeIndex } = props;
  return (
    <div
      aria-hidden="true"
      className="onboarding-progress flex items-center gap-0.5"
    >
      {acts.map((act, index) => (
        <span
          key={act.id}
          className={cn(
            "h-full min-w-0 flex-1 bg-white transition-opacity duration-300",
            index <= activeIndex ? "opacity-100" : "opacity-50",
          )}
        />
      ))}
    </div>
  );
}

// The intro's own key cap - tuned to the diorama's palette rather than the
// app's `components/ui/kbd`. It only ever advertises the tour's navigation
// chords, so the whole component gates rather than each of its call sites.
function Kbd(props: {
  readonly children: ReactNode;
  readonly tone: "light" | "dark";
}) {
  const { children, tone } = props;
  if (!shortcutHintsVisible()) return null;
  return (
    <kbd
      className={cn(
        "inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded border px-1 font-mono text-[0.625rem] leading-none [@media(min-height:920px)]:h-5 [@media(min-height:920px)]:min-w-5 [@media(min-height:920px)]:text-[0.6875rem]",
        tone === "light"
          ? "border-white/25 text-white/55"
          : "border-black/20 text-black/55",
      )}
    >
      {children}
    </kbd>
  );
}

function OnboardingWordmark() {
  return (
    <div className="flex h-[1.625rem] w-[6.375rem] items-center gap-3 [@media(min-height:920px)]:h-7 [@media(min-height:920px)]:w-[7rem]">
      <BrandMark className="h-5 w-auto [@media(min-height:920px)]:h-6" />
      <span className="font-heading text-[1.375rem] leading-5 font-medium tracking-normal text-white [@media(min-height:920px)]:text-[1.5rem] [@media(min-height:920px)]:leading-6">
        traycer
      </span>
    </div>
  );
}

export function OnboardingPage(props: { readonly replay: boolean }) {
  // Draft + provider-derived default live in one state object so the
  // query-sync effect mirrors them through a single trailing setState call
  // (React's effect-sync rule only permits the final statement to set state).
  const [agentGuide, setAgentGuide] = useState<{
    readonly draft: string | null;
    readonly default: string;
  }>({ draft: null, default: "" });
  const agentGuideDraft = agentGuide.draft;
  const agentGuideDefault = agentGuide.default;
  const agentGuideDraftRef = useRef<string | null>(null);
  const agentGuideDirtyRef = useRef(false);
  const agentGuideInitializedRef = useRef(false);
  const agentGuideAutoDefaultRef = useRef(false);
  const agentGuideLastDefaultRef = useRef("");
  // The live wizard's submit, handed over while the session-import act is on
  // screen. A ref rather than state: it changes on every render of a streaming
  // scan, and nothing renders off it - Continue only reads it when pressed.
  const sessionImportSubmitRef = useRef<(() => void) | null>(null);
  const registerSessionImportSubmit = useCallback((submit: () => void) => {
    sessionImportSubmitRef.current = submit;
  }, []);
  const stageRef = useRef<HTMLDivElement | null>(null);
  // The page's other platform read (`miniatureForAct` has the first): the
  // interaction polish the installed app gets and a desktop window must not -
  // swipe between acts, and controls a thumb can actually hit.
  const mobileApp = isMobileApp();
  const actionHeight = actionHeightClass(mobileApp);
  const navigate = useNavigate();
  const router = useRouter();
  const { replay } = props;
  // The tour this shell can run, not the full catalog: the installed app plays
  // the phone tour, a host that cannot scan sessions never reaches the
  // session-import act, whose stage is the live wizard, and a machine that
  // cannot import logins (no browser bridge, or saving off) never reaches the
  // login-import act, whose stage is the live import flow. Everything below
  // counts acts off this list, so an omitted act is unreachable rather than
  // merely blank.
  const sessionImportAvailable = useSessionImportAvailable();
  const loginImportAvailable = useLoginImportAvailable();
  const acts = useMemo(
    () => onboardingActsFor({ sessionImportAvailable, loginImportAvailable }),
    [loginImportAvailable, sessionImportAvailable],
  );
  // An import the login-import act started is a desktop write that may be
  // sitting on a keystore prompt; Continue holds until it settles so the
  // stage is there to show the outcome. Skip does not: the write finishes
  // either way, and the user can always leave.
  const loginImportPending =
    useIsMutating({ mutationKey: browserMutationKeys.importLogins() }) > 0;
  // Read the raw step and clamp here: negotiation can retire an act while the
  // user is already past its new end, and the clamp is what keeps the page on
  // a real act until the next move re-seats the store.
  const storedStep = useOnboardingStore((state) => state.step);
  const step = clampOnboardingStep(storedStep, acts.length);
  const isLastAct = isLastOnboardingStep(storedStep, acts.length);
  const advanceStep = useOnboardingStore((state) => state.advance);
  const retreat = useOnboardingStore((state) => state.retreat);
  const complete = useOnboardingStore((state) => state.complete);
  const restart = useOnboardingStore((state) => state.restart);
  const agentGuideQuery = useAgentSelectionGuideGlobalOnboardingDraftQuery();
  const agentGuideSetMutation = useAgentSelectionGuideSetGlobalMutation();
  const {
    isError: agentGuideSaveError,
    isPending: agentGuideSaving,
    mutateAsync: setAgentGuideGlobal,
    reset: resetAgentGuideSetMutation,
  } = agentGuideSetMutation;

  const act = acts[step];
  const miniature = miniatureForAct(act.id);
  const isAgentGuideAct = act.id === "agent-guide";
  const agentGuideQueryData = agentGuideQuery.data;
  const agentGuideWaitingForProviderSettlement =
    agentGuideQueryData !== undefined &&
    agentGuideQueryData.content === null &&
    !agentGuideQueryData.providersSettled;
  const agentGuideLoading =
    agentGuideQueryData === undefined || agentGuideWaitingForProviderSettlement;

  useLayoutEffect(() => {
    restart();
  }, [restart]);

  // Presence, for app-level ambient surfaces: while the tour has the screen,
  // the import-progress toast holds instead of floating over the stage.
  const setTourOpen = useOnboardingTourOpenStore((state) => state.setOpen);
  useEffect(() => {
    setTourOpen(true);
    return () => setTourOpen(false);
  }, [setTourOpen]);

  useEffect(() => {
    Analytics.getInstance().track(AnalyticsEvent.OnboardingStarted, {
      mode: replay ? "replay" : "first_run",
    });
  }, [replay]);

  useEffect(() => {
    const data = agentGuideQuery.data;
    if (data === undefined) return;
    const nextDefault = data.generatedDefaultContent;
    const current = agentGuideDraftRef.current;
    const previousDefault = agentGuideLastDefaultRef.current;
    const wasUntouchedDefault = current === previousDefault;
    let nextDraft: string;
    let clearDirty = false;

    if (!agentGuideInitializedRef.current) {
      agentGuideAutoDefaultRef.current = data.content === null;
      nextDraft = data.content ?? nextDefault;
      clearDirty = true;
    } else if (
      data.content !== null &&
      agentGuideAutoDefaultRef.current &&
      wasUntouchedDefault
    ) {
      agentGuideAutoDefaultRef.current = false;
      nextDraft = data.content;
      clearDirty = true;
    } else if (agentGuideAutoDefaultRef.current && wasUntouchedDefault) {
      nextDraft = nextDefault;
      clearDirty = true;
    } else if (current !== null) {
      nextDraft = current;
    } else {
      nextDraft = data.content ?? nextDefault;
      clearDirty = true;
    }

    agentGuideInitializedRef.current = true;
    agentGuideLastDefaultRef.current = nextDefault;
    agentGuideDraftRef.current = nextDraft;
    if (clearDirty) agentGuideDirtyRef.current = false;
    setAgentGuide({ draft: nextDraft, default: nextDefault });
  }, [agentGuideQuery.data]);

  const updateAgentGuideDraft = useCallback(
    (value: string): void => {
      resetAgentGuideSetMutation();
      agentGuideDirtyRef.current = value !== agentGuideDefault;
      agentGuideDraftRef.current = value;
      setAgentGuide((prev) => ({ ...prev, draft: value }));
    },
    [agentGuideDefault, resetAgentGuideSetMutation],
  );

  const revertAgentGuideDraft = useCallback((): void => {
    resetAgentGuideSetMutation();
    agentGuideDirtyRef.current = false;
    agentGuideDraftRef.current = agentGuideDefault;
    setAgentGuide((prev) => ({ ...prev, draft: prev.default }));
  }, [agentGuideDefault, resetAgentGuideSetMutation]);

  const saveAgentGuideDraft = useCallback(async (): Promise<boolean> => {
    if (agentGuideSaving) return false;
    // The guide is optional. When it has not loaded, or still reflects an
    // in-flight generated default with no saved content yet, there is no
    // stable draft to persist. Report success so Skip/Escape and the final
    // action can always leave onboarding; the host can seed the fully
    // resolved default later. An existing saved guide the user edited must
    // still persist even while providers are still settling.
    if (
      agentGuideQueryData === undefined ||
      agentGuideWaitingForProviderSettlement
    ) {
      return true;
    }
    const content = agentGuideDraft ?? agentGuideDefault;
    return setAgentGuideGlobal({ content }).then(
      (result) => {
        Analytics.getInstance().track(AnalyticsEvent.AgentGuideSaved, {
          customized: result.content !== result.generatedDefaultContent,
        });
        agentGuideDraftRef.current = result.content;
        setAgentGuide({
          draft: result.content,
          default: result.generatedDefaultContent,
        });
        agentGuideDirtyRef.current =
          result.content !== result.generatedDefaultContent;
        return true;
      },
      () => false,
    );
  }, [
    agentGuideDefault,
    agentGuideDraft,
    agentGuideQueryData,
    agentGuideSaving,
    agentGuideWaitingForProviderSettlement,
    setAgentGuideGlobal,
  ]);

  const agentGuideState: OnboardingAgentGuideState = {
    value: agentGuideDraft ?? agentGuideDefault,
    generatedDefaultContent: agentGuideDefault,
    loading: agentGuideLoading,
    saving: agentGuideSaving,
    error: agentGuideSaveError || agentGuideQuery.isError,
    onValueChange: updateAgentGuideDraft,
    onRevertToDefault: revertAgentGuideDraft,
  };
  const advanceDisabled =
    ((isAgentGuideAct || isLastAct) && agentGuideSaving) || loginImportPending;

  // Finishing the tour must never leave the app on the tabless landing.
  // Replay-from-settings sets `?replay=true` (and pushed /onboarding onto the
  // per-window history), so going back returns to the exact route the user came
  // from. A first-run (entered via a `replace` redirect from "/", no flag) has
  // no real back target, so we open a fresh draft tab. Either way the user
  // lands on a real tab. The /onboarding + / route guards bounce a completed
  // user onward as needed.
  const finish = useCallback(
    (outcome: "completed" | "skipped"): void => {
      void saveAgentGuideDraft().then((saved) => {
        if (!saved) return;
        Analytics.getInstance().track(
          outcome === "completed"
            ? AnalyticsEvent.OnboardingCompleted
            : AnalyticsEvent.OnboardingSkipped,
          { last_step: act.id },
        );
        complete();
        if (replay) {
          router.history.back();
          return;
        }
        void navigate({ to: "/draft/new", replace: true });
      });
    },
    [act.id, complete, navigate, replay, router, saveAgentGuideDraft],
  );

  const retreatWithAnalytics = useCallback((): void => {
    const destination = acts[Math.max(0, step - 1)] ?? act;
    retreat(acts.length);
    Analytics.getInstance().track(AnalyticsEvent.OnboardingNavigated, {
      direction: "back",
      step: destination.id,
    });
  }, [act, acts, retreat, step]);

  const advance = useCallback((): void => {
    if (advanceDisabled) return;
    // The session-import act has one forward control, and it does both jobs:
    // start the import for whatever is ticked (nothing ticked is a no-op), then
    // move on. The run is owned by the app-wide controller, so it outlives this
    // act and keeps going while the user finishes the tour.
    if (act.addon === "session-import") sessionImportSubmitRef.current?.();
    const advancePastCurrent = (): void => {
      if (isLastAct) {
        finish("completed");
        return;
      }
      const destination = acts[step + 1] ?? act;
      advanceStep(acts.length);
      Analytics.getInstance().track(AnalyticsEvent.OnboardingNavigated, {
        direction: "continue",
        step: destination.id,
      });
    };
    advancePastCurrent();
  }, [act, acts, advanceDisabled, advanceStep, finish, isLastAct, step]);
  const handleKeyboardAdvance = useEffectEvent((): void => advance());
  const handleKeyboardRetreat = useEffectEvent((): void =>
    retreatWithAnalytics(),
  );
  const handleKeyboardFinish = useEffectEvent((): void => finish("skipped"));

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("button, a, input, textarea, select") !== null
      ) {
        return;
      }
      if (event.key === "ArrowRight" || event.key === "Enter") {
        event.preventDefault();
        handleKeyboardAdvance();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        handleKeyboardRetreat();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        handleKeyboardFinish();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // The same two callbacks the Back and Continue buttons are wired to, so a
  // swipe is those buttons - save gate, finish branch and analytics included -
  // rather than a second route into the store.
  useActSwipe(stageRef, mobileApp, (direction) => {
    if (direction === "forward") {
      advance();
      return;
    }
    retreatWithAnalytics();
  });

  return (
    // h-full, not h-svh: the standalone shell owns the viewport height and
    // reserves the Windows title-bar band above this page.
    <main
      className={cn(
        "onboarding-shell relative isolate flex h-full flex-1 overflow-hidden bg-[#0f1917] text-white",
        mobileApp && "onboarding-shell--mobile-app",
      )}
    >
      <style>{ONBOARDING_STYLE}</style>
      <div
        className="pointer-events-none absolute inset-0 bg-cover bg-center opacity-40"
        style={{ backgroundImage: `url(${onboardingBackdropUrl})` }}
      />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(14,27,24,0.88),rgba(14,27,24,0.88)),radial-gradient(120%_90%_at_50%_-18%,rgba(95,125,113,0.18),transparent_58%)]" />

      {/* The content layer of a full-bleed surface, so it carries every inset
          the standalone shell deliberately does not. The shell is `fixed`, so
          it escapes ALL THREE of `#root`'s reservations at once - the status
          bar and both landscape sides - and the backdrop siblings above are
          meant to keep that. Everything the user reads or taps hangs off this
          grid: the Skip control in the header row, the stage, the progress and
          action rails, and the footer links.
          The bottom is this surface's own call rather than something `#root`
          gave up, and it is taken: the last grid row centres its footer line
          box, so the row's height stands the ROW off the screen edge while
          leaving the text inside it much closer. Padding the grid moves the
          whole band instead, and the flexible middle row absorbs it. */}
      <div className="relative z-10 grid h-full w-full grid-rows-[var(--onboarding-shell-rows)] overflow-hidden pt-safe-top pr-safe-right pb-safe-bottom pl-safe-left">
        <header className="relative z-10">
          <div className="relative flex h-full items-center justify-center px-10 max-sm:px-5">
            <OnboardingWordmark />
            <button
              type="button"
              data-testid="onboarding-skip"
              onClick={() => finish("skipped")}
              disabled={agentGuideSaving}
              className={cn(
                "absolute right-10 flex h-9 items-center justify-center gap-2 rounded px-2 font-heading text-[0.875rem] leading-[1.125rem] font-normal tracking-normal text-white transition-colors hover:bg-white/10 disabled:pointer-events-none disabled:opacity-55 [@media(min-height:920px)]:h-10 [@media(min-height:920px)]:text-[0.9375rem] max-sm:right-5",
                actionHeight,
              )}
            >
              <span>Skip intro</span>
              <Kbd tone="light">Esc</Kbd>
            </button>
          </div>
        </header>

        <section className="min-h-0 px-[var(--onboarding-section-x)]">
          <div
            ref={stageRef}
            className="relative h-full min-h-0 overflow-hidden rounded-[0.875rem] bg-[#303b37] bg-cover bg-center shadow-[0_2rem_6rem_rgba(0,0,0,0.34),inset_0_1px_0_rgba(255,255,255,0.05)]"
            style={{ backgroundImage: `url(${onboardingBackdropUrl})` }}
          >
            <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(0deg,rgba(48,59,55,0.72),rgba(48,59,55,0.72)),linear-gradient(135deg,rgba(12,30,26,0)_27%,rgba(188,205,197,0.13)_53%,rgba(12,30,26,0)_72%)]" />
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(82%_68%_at_47%_87%,rgba(16,40,36,0.82),transparent_68%)]" />
            <div
              className={cn(
                "onboarding-stage-content relative mx-auto grid h-full min-h-0 w-full max-w-[104rem] items-start overflow-hidden",
                // The providers act - and the mobile tour's agent guide - need a
                // stretched copy rail so their addon can scroll.
                actUsesSoloStage(act) && "onboarding-stage-content--solo",
                miniature.kind === "none" &&
                  "onboarding-stage-content--no-miniature",
              )}
            >
              <div className="onboarding-copy-rail flex min-h-0 min-w-0 flex-col items-center lg:items-start">
                <div className="hidden w-full justify-center lg:flex lg:justify-start">
                  <ProgressRail acts={acts} activeIndex={step} />
                </div>

                <div className="mt-7 w-full min-w-0">
                  <AnimatePresence mode="wait" initial={false}>
                    <ActCopy
                      key={act.id}
                      act={act}
                      eyebrow={actEyebrow(act, step)}
                      agentGuide={agentGuideState}
                    />
                  </AnimatePresence>
                </div>
              </div>

              <OnboardingMiniatureColumn
                actId={act.id}
                addon={act.addon}
                miniature={miniature}
                agentGuide={agentGuideState}
                registerSessionImportSubmit={registerSessionImportSubmit}
              />
            </div>
            <OnboardingStageEdgeFade
              visible={
                miniature.kind === "desktop" ||
                miniature.kind === "session-import" ||
                miniature.kind === "login-import"
              }
            />
            <div className="onboarding-actions absolute z-10 flex items-center justify-end gap-3">
              <div className="mr-auto flex min-w-0 max-w-[14rem] flex-1 flex-col gap-1.5 lg:hidden">
                <p className="truncate font-mono text-[0.6875rem] leading-none font-medium tracking-[0.07em] text-white/55 uppercase">
                  {actEyebrow(act, step)}
                </p>
                <ProgressRail acts={acts} activeIndex={step} />
              </div>
              {step > 0 ? (
                <button
                  type="button"
                  onClick={retreatWithAnalytics}
                  className={cn(
                    "flex h-9 items-center justify-center gap-2 rounded px-3 font-heading text-[0.875rem] leading-[1.125rem] font-medium text-white transition-colors hover:bg-white/10 [@media(min-height:920px)]:h-10 [@media(min-height:920px)]:px-4 [@media(min-height:920px)]:text-[0.9375rem]",
                    actionHeight,
                  )}
                >
                  <Kbd tone="light">←</Kbd>
                  <span>Back</span>
                </button>
              ) : null}
              <button
                type="button"
                data-testid="onboarding-advance"
                onClick={advance}
                disabled={advanceDisabled}
                className={cn(
                  "flex h-9 items-center justify-center gap-2 rounded bg-white px-3 font-heading text-[0.875rem] leading-[1.125rem] font-medium text-black transition-opacity hover:opacity-85 disabled:pointer-events-none disabled:opacity-55 [@media(min-height:920px)]:h-10 [@media(min-height:920px)]:px-4 [@media(min-height:920px)]:text-[0.9375rem]",
                  actionHeight,
                )}
              >
                <span>{isLastAct ? "Start building" : "Continue"}</span>
                <Kbd tone="dark">→</Kbd>
              </button>
            </div>
          </div>
        </section>

        <footer className="flex items-center justify-between gap-4 px-10 font-heading text-[0.75rem] leading-none text-white/75 [@media(min-height:920px)]:text-[0.8125rem] max-sm:px-5">
          <span>{getClientAppVersionLabel()}</span>
          <OnboardingFooterLinks />
        </footer>
      </div>
    </main>
  );
}

function OnboardingFooterLinks() {
  const openLink = useOpenLink();

  const openFooterLink = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, url: string) => {
      event.preventDefault();
      void openLink(url, "docs", event);
    },
    [openLink],
  );

  return (
    <nav aria-label="Traycer footer links" className="hidden sm:block">
      <ul className="flex items-center gap-8">
        {ONBOARDING_FOOTER_LINKS.map((link) => (
          <li key={link.label}>
            <a
              href={link.url}
              onClick={(event) => openFooterLink(event, link.url)}
              onAuxClick={onMiddleClick((event) =>
                openFooterLink(event, link.url),
              )}
              className="transition-colors hover:text-white/80"
            >
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
