import { useFeatureAnnouncementsStore } from "@/stores/settings/feature-announcements-store";
import {
  Fragment,
  use,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  AnimatePresence,
  useReducedMotion,
  type TargetAndTransition,
  type Transition,
} from "motion/react";
import * as m from "motion/react-m";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { BrandMark } from "@/components/auth/cinematic-backdrop";
import {
  onboardingStepsFor,
  type OnboardingStep,
} from "@/components/onboarding/onboarding-steps";
import { OnboardingProviderPrefetch } from "@/components/onboarding/onboarding-provider-discovery";
import { OnboardingDetectedAgents } from "@/components/onboarding/onboarding-detected-agents";
import {
  onboardingHostIsUsable,
  type OnboardingHostPicker,
} from "@/components/onboarding/onboarding-host-picker-model";
import {
  OnboardingHostPickerBar,
  OnboardingHostUnavailableNotice,
} from "@/components/onboarding/onboarding-host-picker";
import { OnboardingSessionImportStage } from "@/components/onboarding/onboarding-session-import-stage";
import { OnboardingWorkspaceIllustration } from "@/components/onboarding/onboarding-workspace-illustration";
import { useOnboardingSwipe } from "@/components/onboarding/use-onboarding-swipe";
import { useSessionImportScan } from "@/components/session-import/use-session-import-scan";
import { useSessionImportAvailable } from "@/hooks/session-import/use-session-import-available";
import { HostRuntimeContext, useHostBinding } from "@/lib/host";
import {
  useHostScopeFor,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import { useScopedStreamBinding } from "@/components/settings/host-scope/use-scoped-stream-binding";
import { isMobileApp } from "@/lib/mobile-app";
import {
  clampOnboardingStep,
  isLastOnboardingStep,
  useOnboardingStore,
} from "@/stores/onboarding/onboarding-store";
import { useOnboardingTourOpenStore } from "@/stores/onboarding/onboarding-tour-open-store";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";
import {
  StreamRuntimeContext,
  useStreamHostId,
  useStreamRuntimeBinding,
} from "@/lib/host/stream-runtime-context";
import {
  sessionImportIsRunning,
  useSessionImportRun,
} from "@/stores/session-import/session-import-run-store";
import { cn } from "@/lib/utils";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import "@/styles/auth-arrival.css";
import "./onboarding.css";

type CubicBezier = [number, number, number, number];

/** The stage's strong ease-out, as motion's cubic-bezier control points. */
const ONBOARDING_EASE: CubicBezier = [0.23, 1, 0.32, 1];
/** Both halves of an act swap carry this, so they read as one movement. */
const STEP_ENTER_SECONDS = 0.26;
const STEP_EXIT_SECONDS = 0.16;
const STEP_TRAVEL_PX = 8;

interface StepMotion {
  readonly initial: TargetAndTransition;
  readonly animate: TargetAndTransition;
  readonly exit: TargetAndTransition;
  readonly transition: Transition;
}

/**
 * The act → act swap, shared by the copy block and the panel's contents.
 *
 * `direction` is the vertical sign: forward enters from below and leaves
 * upward, Back mirrors it. Keyboard navigation (`animated: false`) keeps the
 * page's long-standing no-motion behaviour, and reduced motion keeps the
 * crossfade while dropping the travel, the scale and the blur.
 */
function stepMotion(
  direction: number,
  animated: boolean,
  reduced: boolean,
): StepMotion {
  const travel = reduced ? 0 : STEP_TRAVEL_PX * direction;
  const scale = reduced ? 1 : 0.985;
  const blur = reduced ? "blur(0px)" : "blur(2px)";
  return {
    initial: {
      opacity: 0,
      transform: `translateY(${travel}px) scale(${scale})`,
      filter: blur,
    },
    animate: {
      opacity: 1,
      transform: "translateY(0px) scale(1)",
      filter: "blur(0px)",
    },
    exit: {
      opacity: 0,
      transform: `translateY(${-travel}px) scale(1)`,
      filter: blur,
      transition: {
        duration: animated ? STEP_EXIT_SECONDS : 0,
        ease: ONBOARDING_EASE,
      },
    },
    transition: {
      duration: animated ? STEP_ENTER_SECONDS : 0,
      ease: ONBOARDING_EASE,
    },
  };
}

export function OnboardingPage(props: { readonly replay: boolean }) {
  const [scopedHostId, setScopedHostId] = useState<string | null>(null);
  const scope = useHostScopeFor({ scopedHostId, setScopedHostId });
  // The ambient capability fixes the tour's shape. The import stage checks
  // the picked host again before offering its live wizard.
  const sessionImportAvailable = useSessionImportAvailable();
  const steps = onboardingStepsFor(sessionImportAvailable);
  const scopedBinding = useScopedHostBinding(scope);
  const ambientBinding = useHostBinding();
  const scopedStreamBinding = useScopedStreamBinding(scope);
  const ambientStreamBinding = use(StreamRuntimeContext);
  return (
    <HostRuntimeContext.Provider value={scopedBinding ?? ambientBinding}>
      <StreamRuntimeContext.Provider
        value={scopedStreamBinding ?? ambientStreamBinding}
      >
        <OnboardingTour
          replay={props.replay}
          steps={steps}
          scope={scope}
          scopedHostId={scopedHostId}
          setScopedHostId={setScopedHostId}
        />
      </StreamRuntimeContext.Provider>
    </HostRuntimeContext.Provider>
  );
}

function OnboardingTour(props: {
  readonly replay: boolean;
  readonly steps: ReadonlyArray<OnboardingStep>;
  readonly scope: HostScope;
  readonly scopedHostId: string | null;
  readonly setScopedHostId: (hostId: string) => void;
}) {
  const { steps, scope, scopedHostId, setScopedHostId, replay } = props;
  const [animateChanges, setAnimateChanges] = useState(true);
  const [stepDirection, setStepDirection] = useState(1);
  const reducedMotion = useReducedMotion() === true;
  const pointerNavigationRef = useRef(true);
  const [welcomePhase, setWelcomePhase] = useState<
    "welcome" | "leaving" | "ready"
  >("welcome");
  useEffect(() => {
    if (welcomePhase === "ready") return;
    const reducedMotionQuery = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const duration = reducedMotionQuery
      ? { welcome: 300, leaving: 150 }[welcomePhase]
      : { welcome: 1800, leaving: 320 }[welcomePhase];
    const timer = window.setTimeout(
      () => setWelcomePhase(welcomePhase === "welcome" ? "leaving" : "ready"),
      duration,
    );
    return () => window.clearTimeout(timer);
  }, [welcomePhase]);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const mobileApp = isMobileApp();
  const navigate = useNavigate();
  const router = useRouter();
  const storedStep = useOnboardingStore((state) => state.step);
  const index = clampOnboardingStep(storedStep, steps.length);
  const isLastStep = isLastOnboardingStep(storedStep, steps.length);
  const advanceStep = useOnboardingStore((state) => state.advance);
  const retreat = useOnboardingStore((state) => state.retreat);
  const complete = useOnboardingStore((state) => state.complete);
  const restart = useOnboardingStore((state) => state.restart);
  const step = steps[index];
  const streamBinding = useStreamRuntimeBinding();
  const streamHostId = useStreamHostId();
  const run = useSessionImportRun(streamHostId);
  const skipImport = step.id === "session-import" && run.status === "idle";
  const sessionImportScan = useSessionImportScan(
    steps.some((entry) => entry.id === "session-import") &&
      !sessionImportIsRunning(run),
  );
  const hostPicker = useMemo<OnboardingHostPicker>(
    () => ({
      scope,
      onSelectHost: setScopedHostId,
      hasExplicitPick: scopedHostId !== null,
      streamOnPickedHost:
        streamBinding !== null && streamBinding.hostId === scope.hostId,
    }),
    [scope, setScopedHostId, scopedHostId, streamBinding],
  );

  useLayoutEffect(() => {
    restart();
    if (!replay) {
      useFirstTaskGuideStore.getState().prepare();
      // Browser setup stays in Getting started instead of interrupting the first task.
      useFeatureAnnouncementsStore.getState().consume("login-import");
    }
  }, [restart, replay]);

  useEffect(() => {
    if (welcomePhase !== "ready") return;
    headingRef.current?.focus({ preventScroll: true });
    stageRef.current?.scrollTo({ top: 0 });
  }, [step.id, welcomePhase]);

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

  const finish = useCallback(
    (outcome: "completed" | "skipped"): void => {
      Analytics.getInstance().track(
        outcome === "completed"
          ? AnalyticsEvent.OnboardingCompleted
          : AnalyticsEvent.OnboardingSkipped,
        { last_step: step.id },
      );
      if (!replay) {
        const guide = useFirstTaskGuideStore.getState();
        if (outcome === "completed") guide.activate();
        else guide.dismiss();
      }
      complete();
      if (replay) {
        router.history.back();
        return;
      }
      void navigate({ to: "/draft/new", replace: true });
    },
    [step.id, complete, navigate, replay, router],
  );

  const back = useCallback((): void => {
    if (index === 0) return;
    setAnimateChanges(pointerNavigationRef.current);
    setStepDirection(-1);
    retreat(steps.length);
    Analytics.getInstance().track(AnalyticsEvent.OnboardingNavigated, {
      direction: "back",
      step: steps[index - 1].id,
    });
  }, [index, retreat, steps]);

  const advance = useCallback((): void => {
    if (isLastStep) {
      finish("completed");
      return;
    }
    setAnimateChanges(pointerNavigationRef.current);
    setStepDirection(1);
    advanceStep(steps.length);
    Analytics.getInstance().track(AnalyticsEvent.OnboardingNavigated, {
      direction: "continue",
      step: steps[index + 1].id,
    });
  }, [advanceStep, finish, index, isLastStep, steps]);

  const handleKeyboard = useEffectEvent((event: KeyboardEvent): void => {
    pointerNavigationRef.current = false;
    if (welcomePhase !== "ready") return;
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    )
      return;
    if (
      event.target instanceof Element &&
      event.target.closest(
        'button, a, input, textarea, select, [contenteditable], [role="dialog"], [role="menu"], [role="listbox"]',
      ) !== null
    )
      return;
    if (event.key === "ArrowRight" || event.key === "Enter") {
      event.preventDefault();
      advance();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      back();
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish("skipped");
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => handleKeyboard(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  useOnboardingSwipe(
    stageRef,
    mobileApp && welcomePhase === "ready",
    (direction) => {
      if (direction === "forward") advance();
      else back();
    },
  );

  const motionProps = stepMotion(stepDirection, animateChanges, reducedMotion);

  return (
    <main
      data-motion={animateChanges}
      onPointerDownCapture={() => {
        pointerNavigationRef.current = true;
      }}
      onKeyDownCapture={() => {
        pointerNavigationRef.current = false;
      }}
      className="onboarding-shell relative isolate flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background font-heading text-foreground"
    >
      <div
        aria-hidden="true"
        className="onboarding-glow pointer-events-none absolute"
      />
      <div
        aria-hidden="true"
        className="onboarding-dot-grid pointer-events-none absolute inset-0"
      />
      <div
        aria-hidden="true"
        className="onboarding-grain pointer-events-none absolute inset-0"
      />
      {step.id !== "providers" && onboardingHostIsUsable(hostPicker) ? (
        <OnboardingProviderPrefetch key={scope.hostId} />
      ) : null}
      {welcomePhase !== "ready" ? (
        <section
          aria-label="Welcome to Traycer"
          data-leaving={welcomePhase === "leaving"}
          className="onboarding-welcome absolute inset-0 z-20 flex flex-col items-center justify-center gap-[clamp(1.2rem,2.8vh,2rem)] pt-safe-top pr-safe-right pb-safe-bottom pl-safe-left"
        >
          <m.div layoutId={reducedMotion ? undefined : "onboarding-brand-mark"}>
            <BrandMark className="brand-entrance-mark h-auto w-[clamp(3.75rem,8vw,5.4rem)] text-foreground [&_g>path]:fill-current" />
          </m.div>
          <h1 className="brand-entrance-copy text-3xl font-medium tracking-tight">
            Welcome to Traycer.
          </h1>
          <button
            type="button"
            data-testid="onboarding-welcome-skip"
            onClick={() => setWelcomePhase("leaving")}
            className="onboarding-button onboarding-button--quiet absolute bottom-[max(1.5rem,var(--safe-area-inset-bottom))] text-xs"
          >
            Skip welcome
          </button>
        </section>
      ) : null}
      <div
        inert={welcomePhase !== "ready"}
        aria-hidden={welcomePhase !== "ready"}
        data-welcoming={welcomePhase !== "ready"}
        className="onboarding-tour-layer relative z-10 flex h-full min-h-0 w-full flex-col pt-safe-top pr-safe-right pb-safe-bottom pl-safe-left"
      >
        <header className="onboarding-header flex shrink-0 items-center justify-between gap-4">
          <div className="onboarding-brand flex items-center gap-2.5">
            {welcomePhase === "ready" ? (
              <m.div
                layoutId={reducedMotion ? undefined : "onboarding-brand-mark"}
                transition={{ type: "spring", duration: 0.55, bounce: 0 }}
                className="flex"
              >
                <BrandMark className="h-6 w-auto text-foreground [&_g>path]:fill-current" />
              </m.div>
            ) : null}
            <span className="onboarding-wordmark text-xl font-medium tracking-tight">
              traycer
            </span>
          </div>
          <div className="onboarding-header-aside flex items-center gap-4">
            <ProgressRail steps={steps} activeIndex={index} />
            <button
              type="button"
              data-testid="onboarding-skip"
              onClick={() => finish("skipped")}
              className="onboarding-button onboarding-button--quiet"
            >
              Skip intro
            </button>
          </div>
        </header>
        <section
          aria-label="Welcome to Traycer"
          className="onboarding-stage relative flex min-h-0 w-full flex-1 flex-col"
        >
          <AnimatePresence mode="wait" initial={false}>
            <m.div
              key={step.id}
              data-testid="onboarding-step"
              data-step-id={step.id}
              initial={motionProps.initial}
              animate={motionProps.animate}
              exit={motionProps.exit}
              transition={motionProps.transition}
              className="onboarding-copy min-w-0 shrink-0"
            >
              <p className="onboarding-eyebrow text-muted-foreground">
                {step.label} · {index + 1} of {steps.length}
              </p>
              <h1
                ref={headingRef}
                tabIndex={-1}
                className="onboarding-title outline-none"
              >
                {step.title.split(" ").map((word, wordIndex) => (
                  // Titles are curated copy; a word is unique within one.
                  <Fragment key={word}>
                    {wordIndex === 0 ? null : " "}
                    <span
                      className="onboarding-title-word"
                      style={{ animationDelay: `${wordIndex * 30}ms` }}
                    >
                      {word}
                    </span>
                  </Fragment>
                ))}
              </h1>
              <p className="onboarding-subtitle text-muted-foreground">
                {step.subtitle}
              </p>
            </m.div>
          </AnimatePresence>
          <div data-step={step.id} className="onboarding-panel flex min-h-0">
            <div
              ref={stageRef}
              className="onboarding-stage-scroll flex min-h-0 w-full flex-1 flex-col overflow-y-auto overscroll-contain"
            >
              <AnimatePresence mode="wait" initial={false}>
                <m.div
                  key={step.id}
                  initial={motionProps.initial}
                  animate={motionProps.animate}
                  exit={motionProps.exit}
                  transition={motionProps.transition}
                  className="onboarding-panel-content flex min-h-0 w-full min-w-0 flex-1 flex-col"
                >
                  {step.id === "task-tabs" && welcomePhase !== "welcome" ? (
                    <OnboardingWorkspaceIllustration mobile={mobileApp} />
                  ) : null}
                  {step.id === "providers" ? (
                    <div className="onboarding-provider-panel flex h-full min-h-0 w-full flex-col">
                      <OnboardingHostPickerBar
                        picker={hostPicker}
                        className="onboarding-device-picker"
                      />
                      {onboardingHostIsUsable(hostPicker) ? (
                        <OnboardingDetectedAgents key={scope.hostId} />
                      ) : (
                        <OnboardingHostUnavailableNotice
                          picker={hostPicker}
                          refusal={null}
                        />
                      )}
                    </div>
                  ) : null}
                  {step.id === "session-import" ? (
                    <OnboardingSessionImportStage
                      scan={sessionImportScan}
                      hostPicker={hostPicker}
                      onImportStarted={() => {
                        if (!replay && streamHostId !== null)
                          useFirstTaskGuideStore
                            .getState()
                            .rememberImport(streamHostId);
                      }}
                      onBeforeTaskOpen={() => {
                        Analytics.getInstance().track(
                          AnalyticsEvent.OnboardingCompleted,
                          { last_step: step.id },
                        );
                        // Mount AppShell before the import wizard requests its task tab.
                        if (!replay)
                          useFirstTaskGuideStore.getState().activate();
                        complete();
                        return Promise.resolve(true);
                      }}
                    />
                  ) : null}
                </m.div>
              </AnimatePresence>
            </div>
          </div>
          <OnboardingActions
            canGoBack={index > 0}
            isLastStep={isLastStep}
            skipImport={skipImport}
            onBack={back}
            onAdvance={advance}
          />
        </section>
      </div>
    </main>
  );
}

function segmentState(
  index: number,
  activeIndex: number,
): "active" | "done" | "todo" {
  if (index === activeIndex) return "active";
  return index < activeIndex ? "done" : "todo";
}

function ProgressRail(props: {
  readonly steps: ReadonlyArray<OnboardingStep>;
  readonly activeIndex: number;
}) {
  return (
    <div className="onboarding-progress flex items-center gap-3">
      <ol aria-label="Your introduction" className="flex items-center gap-1.5">
        {props.steps.map((step, index) => (
          <li
            key={step.id}
            aria-current={index === props.activeIndex ? "step" : undefined}
          >
            <span
              aria-hidden="true"
              data-state={segmentState(index, props.activeIndex)}
              className="onboarding-progress-segment block"
            >
              <span className="onboarding-progress-fill block" />
            </span>
            <span className="sr-only">{step.label}</span>
          </li>
        ))}
      </ol>
      <span
        key={props.activeIndex}
        aria-hidden="true"
        className="onboarding-progress-label text-sm font-medium"
      >
        {props.steps[props.activeIndex].label}
      </span>
    </div>
  );
}

function OnboardingActions(props: {
  readonly canGoBack: boolean;
  readonly isLastStep: boolean;
  readonly skipImport: boolean;
  readonly onBack: () => void;
  readonly onAdvance: () => void;
}) {
  const lastStepLabel = props.skipImport ? "Skip for now" : "Start building";
  return (
    <footer className="onboarding-actions flex shrink-0 items-center justify-end gap-2">
      {props.canGoBack ? (
        <button
          type="button"
          data-testid="onboarding-back"
          onClick={props.onBack}
          className="onboarding-button onboarding-button--quiet"
        >
          <ArrowLeft aria-hidden="true" className="size-4" /> Back
        </button>
      ) : null}
      <button
        type="button"
        data-testid="onboarding-advance"
        onClick={props.onAdvance}
        className={cn(
          "onboarding-button",
          props.skipImport
            ? "onboarding-button--quiet"
            : "onboarding-button--primary",
        )}
      >
        {props.isLastStep ? lastStepLabel : "Continue"}
        <ArrowRight aria-hidden="true" className="size-4" />
      </button>
    </footer>
  );
}
