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
import { ChevronLeft } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { ShortcutHint } from "@/components/ui/shortcut-hint";
import { BrandMark } from "@/components/auth/cinematic-backdrop";
import {
  onboardingStepsFor,
  type OnboardingStep,
} from "@/components/onboarding/onboarding-steps";
import { OnboardingField } from "@/components/onboarding/onboarding-field";
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
import { useOnboardingHorizontalDrag } from "@/components/onboarding/use-onboarding-swipe";
import { escapeOwnedElsewhere } from "@/components/onboarding/guide-overlays";
import {
  useSessionImportScan,
  type SessionImportScanHandle,
} from "@/components/session-import/use-session-import-scan";
import { useSessionImportAvailable } from "@/hooks/session-import/use-session-import-available";
import { HostRuntimeContext, useHostBinding } from "@/lib/host";
import {
  useHostScopeFor,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import { useScopedStreamBinding } from "@/components/settings/host-scope/use-scoped-stream-binding";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
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
 * upward, Back mirrors it. Reduced motion keeps the crossfade while dropping
 * the travel, the scale and the blur; it is the only thing that changes the
 * swap, so an act reached by keyboard moves exactly as one reached by Continue.
 */
function stepMotion(direction: number, reduced: boolean): StepMotion {
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
        duration: STEP_EXIT_SECONDS,
        ease: ONBOARDING_EASE,
      },
    },
    transition: {
      duration: STEP_ENTER_SECONDS,
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
  // The phone layout is a VIEWPORT answer, not a product one: a narrow desktop
  // window gets the same shell, the same scenes and the same copy, and an
  // installed app on a tablet gets the desktop stage.
  const phone = useIsMobileViewport();
  const steps = onboardingStepsFor(sessionImportAvailable, phone);
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
          phone={phone}
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
  readonly phone: boolean;
  readonly scope: HostScope;
  readonly scopedHostId: string | null;
  readonly setScopedHostId: (hostId: string) => void;
}) {
  const { steps, phone, scope, scopedHostId, setScopedHostId, replay } = props;
  const [stepDirection, setStepDirection] = useState(1);
  const reducedMotion = useReducedMotion() === true;
  const [welcomePhase, setWelcomePhase] = useState<WelcomePhase>("welcome");
  useEffect(() => {
    if (welcomePhase === "ready") return;
    // Read the media query here rather than reuse `reducedMotion`: motion's
    // `useReducedMotion` samples the query once per module and only updates
    // through its own change listener, so the value at mount can lag a
    // preference that changed since the app loaded. The timings are decided
    // per phase, so they take the live answer.
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches
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
    setStepDirection(1);
    advanceStep(steps.length);
    Analytics.getInstance().track(AnalyticsEvent.OnboardingNavigated, {
      direction: "continue",
      step: steps[index + 1].id,
    });
  }, [advanceStep, finish, index, isLastStep, steps]);

  const handleKeyboard = useEffectEvent((event: KeyboardEvent): void => {
    if (welcomePhase !== "ready") return;
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    )
      return;
    // Escape is the Skip button, wherever focus happens to be: the tour IS the
    // screen, so an Escape aimed at one of its own controls is still aimed at
    // the tour. A picker or dialog that is open answers for itself first.
    if (event.key === "Escape") {
      if (escapeOwnedElsewhere([])) return;
      event.preventDefault();
      finish("skipped");
      return;
    }
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
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => handleKeyboard(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // The act follows the finger and springs back from wherever it was released;
  // the ends resist rather than stop, so the first and the last act tell you
  // there is nothing that way instead of ignoring the gesture. Act 1's scene
  // pager is nested inside this surface and declares itself, so a swipe over
  // the scenes pages them and only their last one hands an act swipe over.
  const actOffset = useOnboardingHorizontalDrag(stageRef, {
    enabled: phone && welcomePhase === "ready",
    canCommit: (direction) =>
      direction === "forward" ? !isLastStep : index > 0,
    onCommit: (direction) => {
      if (direction === "forward") advance();
      else back();
    },
    onRefused: () => undefined,
    respectsEdgeZones: true,
    yieldsToNestedPager: true,
  });

  const motionProps = stepMotion(stepDirection, reducedMotion);
  // Act 3's wizard owns the phone's primary action ("Import N tasks"), so the
  // shell's footer there is the quiet way past it and nothing else. Two
  // primaries on one 393pt column is one too many.
  const wizardOwnsPrimary = phone && step.id === "session-import";

  return (
    <main
      data-phone={phone}
      className="onboarding-shell relative isolate flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background font-heading text-foreground"
    >
      <OnboardingField welcoming={welcomePhase !== "ready"} />
      <div
        aria-hidden="true"
        className="onboarding-grain pointer-events-none absolute inset-0"
      />
      {step.id !== "providers" && onboardingHostIsUsable(hostPicker) ? (
        <OnboardingProviderPrefetch key={scope.hostId} />
      ) : null}
      <WelcomeLayer
        phase={welcomePhase}
        reducedMotion={reducedMotion}
        onSkip={() => setWelcomePhase("leaving")}
      />
      <div
        inert={welcomePhase !== "ready"}
        aria-hidden={welcomePhase !== "ready"}
        data-welcoming={welcomePhase !== "ready"}
        className="onboarding-tour-layer relative z-10 flex h-full min-h-0 w-full flex-col pt-safe-top pr-safe-right pb-safe-bottom pl-safe-left"
      >
        {/* The inline padding mirrors `AppHeader`: the tour is a full-bleed
            surface, so on a frameless shell the traffic lights sit on top of
            this row's leading edge and the brand mark has to start after them.
            `wco:` only matches while the controls are actually visible, so
            neither utility can fire at phone width. */}
        <TourHeader
          phone={phone}
          steps={steps}
          activeIndex={index}
          reducedMotion={reducedMotion}
          markVisible={welcomePhase === "ready"}
          onBack={back}
          onSkip={() => finish("skipped")}
        />
        <section
          aria-label="Your introduction to Traycer"
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
              {/* The eyebrow is the third progress system on a phone - the
                  dashes above it already say which act this is - and the act's
                  own name is what the title says. */}
              {phone ? null : (
                <p className="onboarding-eyebrow text-muted-foreground">
                  {step.label} · {index + 1} of {steps.length}
                </p>
              )}
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
              {/* Act 1 earns a line of orientation. Acts 2 and 3 do not: on a
                  phone the act itself is the explanation, and a second line of
                  copy costs it 22pt of the only region that matters. The ink is
                  `--foreground` rather than muted because there is no glass
                  under it here - see onboarding.css's phone block. */}
              {phone && step.id !== "task-tabs" ? null : (
                <p
                  className={cn(
                    "onboarding-subtitle",
                    phone ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {step.subtitle}
                </p>
              )}
            </m.div>
          </AnimatePresence>
          <div data-step={step.id} className="onboarding-panel flex min-h-0">
            <m.div
              ref={stageRef}
              style={phone ? { x: actOffset } : undefined}
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
                  <TourActStage
                    step={step}
                    welcomeStarted={welcomePhase !== "welcome"}
                    hostPicker={hostPicker}
                    scopeHostId={scope.hostId}
                    sessionImportScan={sessionImportScan}
                    onAdvance={advance}
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
                      if (!replay) useFirstTaskGuideStore.getState().activate();
                      complete();
                      return Promise.resolve(true);
                    }}
                  />
                </m.div>
              </AnimatePresence>
            </m.div>
          </div>
          <OnboardingActions
            phone={phone}
            canGoBack={index > 0}
            isLastStep={isLastStep}
            skipImport={skipImport}
            quietOnly={wizardOwnsPrimary}
            onBack={back}
            onAdvance={advance}
          />
        </section>
      </div>
    </main>
  );
}

/** Where the welcome screen is in its own three-beat life. */
type WelcomePhase = "welcome" | "leaving" | "ready";

/**
 * The welcome screen: the mark, the line, the dither field behind it, and the
 * way past it. It owns its own "am I still on screen" question so the tour does
 * not carry that branch.
 */
function WelcomeLayer(props: {
  readonly phase: WelcomePhase;
  readonly reducedMotion: boolean;
  readonly onSkip: () => void;
}) {
  const { phase, reducedMotion, onSkip } = props;
  if (phase === "ready") return null;
  return (
    <section
      aria-label="Welcome to Traycer"
      data-leaving={phase === "leaving"}
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
        onClick={onSkip}
        className="onboarding-button onboarding-button--quiet absolute bottom-[max(1.5rem,var(--safe-area-inset-bottom))] text-xs"
      >
        Skip welcome
      </button>
    </section>
  );
}

/**
 * The tour's top row. Three slots on a phone - Back or the mark, the dashes,
 * Skip - and the desktop's two runs otherwise. The wordmark is desktop-only:
 * 44pt of a 393pt row cannot hold a logotype AND the only control that leaves
 * the tour.
 */
function TourHeader(props: {
  readonly phone: boolean;
  readonly steps: ReadonlyArray<OnboardingStep>;
  readonly activeIndex: number;
  readonly reducedMotion: boolean;
  /** False until the welcome has left, so the shared mark lands once. */
  readonly markVisible: boolean;
  readonly onBack: () => void;
  readonly onSkip: () => void;
}) {
  const {
    phone,
    steps,
    activeIndex,
    reducedMotion,
    markVisible,
    onBack,
    onSkip,
  } = props;
  return (
    <header className="onboarding-header flex shrink-0 items-center justify-between gap-4 px-[var(--onboarding-header-gutter)] wco:pl-[env(titlebar-area-x,82px)] wco:pr-[max(12px,calc(100vw-env(titlebar-area-x,82px)-env(titlebar-area-width,100vw)+12px))]">
      {phone ? (
        <div className="onboarding-header-slot--lead flex items-center">
          {activeIndex === 0 ? (
            <TourBrandMark
              reducedMotion={reducedMotion}
              visible={markVisible}
            />
          ) : (
            <button
              type="button"
              data-testid="onboarding-back"
              aria-label="Back"
              onClick={onBack}
              className="onboarding-button onboarding-button--quiet onboarding-button--icon"
            >
              <ChevronLeft aria-hidden="true" className="size-5" />
            </button>
          )}
        </div>
      ) : (
        // The brand block is the header's only non-interactive run, so it is
        // also its drag handle - the same role AppHeader gives its title-bar
        // spacers.
        <div className="onboarding-brand flex items-center gap-2.5 [-webkit-app-region:drag]">
          <TourBrandMark reducedMotion={reducedMotion} visible={markVisible} />
          <span className="onboarding-wordmark text-xl font-medium tracking-tight">
            traycer
          </span>
        </div>
      )}
      <div className="onboarding-header-aside flex items-center justify-center gap-4">
        <ProgressRail
          steps={steps}
          activeIndex={activeIndex}
          showLabel={!phone}
        />
        {phone ? null : <TourSkip label="Skip intro" onSkip={onSkip} />}
      </div>
      {phone ? (
        <div className="onboarding-header-aside onboarding-header-slot--trail flex items-center">
          <TourSkip label="Skip" onSkip={onSkip} />
        </div>
      ) : null}
    </header>
  );
}

/**
 * Whichever act is on stage. One component so the tour's own body carries the
 * shell and the motion rather than every act's mount condition.
 */
function TourActStage(props: {
  readonly step: OnboardingStep;
  /** The workspace scenes wait for the welcome to start leaving, not to finish. */
  readonly welcomeStarted: boolean;
  readonly hostPicker: OnboardingHostPicker;
  readonly scopeHostId: string | null;
  readonly sessionImportScan: SessionImportScanHandle;
  readonly onAdvance: () => void;
  readonly onImportStarted: () => void;
  readonly onBeforeTaskOpen: () => Promise<boolean>;
}) {
  const {
    step,
    welcomeStarted,
    hostPicker,
    scopeHostId,
    sessionImportScan,
    onAdvance,
    onImportStarted,
    onBeforeTaskOpen,
  } = props;
  switch (step.id) {
    case "task-tabs":
      return welcomeStarted ? (
        <OnboardingWorkspaceIllustration onPassLastScene={onAdvance} />
      ) : null;
    case "providers":
      return (
        <div className="onboarding-provider-panel flex h-full min-h-0 w-full flex-col">
          <OnboardingHostPickerBar
            picker={hostPicker}
            className="onboarding-device-picker"
          />
          {onboardingHostIsUsable(hostPicker) ? (
            <OnboardingDetectedAgents key={scopeHostId} />
          ) : (
            <OnboardingHostUnavailableNotice
              picker={hostPicker}
              refusal={null}
            />
          )}
        </div>
      );
    case "session-import":
      return (
        <OnboardingSessionImportStage
          scan={sessionImportScan}
          hostPicker={hostPicker}
          onImportStarted={onImportStarted}
          onBeforeTaskOpen={onBeforeTaskOpen}
        />
      );
  }
}

/**
 * The mark that travels out of the welcome screen into the header's leading
 * slot. One component because both header shapes host the same shared element,
 * and a second `layoutId` for the same id would fight it for the landing.
 */
function TourBrandMark(props: {
  readonly reducedMotion: boolean;
  readonly visible: boolean;
}) {
  if (!props.visible) return null;
  return (
    <m.div
      layoutId={props.reducedMotion ? undefined : "onboarding-brand-mark"}
      transition={{ type: "spring", duration: 0.55, bounce: 0 }}
      className="flex"
    >
      <BrandMark className="h-6 w-auto text-foreground [&_g>path]:fill-current" />
    </m.div>
  );
}

function TourSkip(props: {
  readonly label: string;
  readonly onSkip: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="onboarding-skip"
      onClick={props.onSkip}
      className="onboarding-button onboarding-button--quiet"
    >
      {props.label}
    </button>
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
  /** The act's name beside the dashes. Desktop has the room for it; 393pt does not. */
  readonly showLabel: boolean;
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
      {props.showLabel ? (
        <span
          key={props.activeIndex}
          aria-hidden="true"
          className="onboarding-progress-label text-sm font-medium"
        >
          {props.steps[props.activeIndex].label}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The footer. One shape on every act and on both layouts, so the thumb finds
 * the same button in the same place all the way through: a full-width primary
 * on a phone, the desktop's right-hand pair otherwise. Back left the phone's
 * footer for its header, where a back affordance belongs on a phone and where
 * it costs the act nothing.
 */
function OnboardingActions(props: {
  readonly phone: boolean;
  readonly canGoBack: boolean;
  readonly isLastStep: boolean;
  readonly skipImport: boolean;
  readonly quietOnly: boolean;
  readonly onBack: () => void;
  readonly onAdvance: () => void;
}) {
  const quiet = props.quietOnly || props.skipImport;
  // "Skip for now" and "Skip intro" are the same word twice on a 393pt row, and
  // the header already carries one of them.
  const skipLabel = props.phone ? "Skip" : "Skip for now";
  const lastStepLabel = props.skipImport ? skipLabel : "Start building";
  return (
    <footer
      data-quiet={props.quietOnly}
      className={cn(
        "onboarding-actions flex shrink-0 items-center gap-2",
        // Act 3's lone text button belongs in the middle of the row; every
        // other footer is the desktop's right-hand cluster or one block button,
        // both of which read the same either way.
        props.quietOnly ? "justify-center" : "justify-end",
      )}
    >
      {props.canGoBack && !props.phone ? (
        <button
          type="button"
          data-testid="onboarding-back"
          onClick={props.onBack}
          className="onboarding-button onboarding-button--quiet"
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
          Back
        </button>
      ) : null}
      <button
        type="button"
        data-testid="onboarding-advance"
        onClick={props.onAdvance}
        className={cn(
          "onboarding-button",
          quiet ? "onboarding-button--quiet" : "onboarding-button--primary",
          props.phone && !props.quietOnly && "onboarding-button--block",
        )}
      >
        {props.isLastStep ? lastStepLabel : "Continue"}
        {/* The cap rides the button's own foreground: these are plain
            `.onboarding-button` elements, so `Kbd`'s in-Button rules - the ones
            that keep a cap readable on a filled primary - never fire here. */}
        <ShortcutHint>
          <Kbd
            aria-hidden="true"
            variant="inherit"
            className="hidden md:inline-flex"
          >
            ↵
          </Kbd>
        </ShortcutHint>
      </button>
    </footer>
  );
}
