import { useFeatureAnnouncementsStore } from "@/stores/settings/feature-announcements-store";
import {
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
import { ArrowLeft, ArrowRight } from "lucide-react";
import onboardingBackdropUrl from "@/assets/brand/gradient-bg.jpg?url";
import { BrandMark } from "@/components/auth/cinematic-backdrop";
import { BrandEntrance } from "@/components/auth/brand-entrance";
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
import "./onboarding.css";

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
  const pointerNavigationRef = useRef(true);
  const [welcomePhase, setWelcomePhase] = useState<
    "welcome" | "leaving" | "ready"
  >("welcome");
  useEffect(() => {
    if (welcomePhase === "ready") return;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const duration = reducedMotion
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
        className="onboarding-atmosphere pointer-events-none absolute inset-0"
      />
      <div
        aria-hidden="true"
        className="onboarding-backdrop pointer-events-none absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: `url(${onboardingBackdropUrl})` }}
      />
      {step.id !== "providers" && onboardingHostIsUsable(hostPicker) ? (
        <OnboardingProviderPrefetch key={scope.hostId} />
      ) : null}
      {welcomePhase !== "ready" ? (
        <section
          aria-label="Welcome to Traycer"
          data-leaving={welcomePhase === "leaving"}
          className="onboarding-welcome absolute inset-0 z-20 flex flex-col items-center justify-center gap-6 pt-safe-top pr-safe-right pb-safe-bottom pl-safe-left"
        >
          <BrandEntrance size="welcome">
            <h1 className="brand-entrance-copy text-3xl font-medium tracking-tight">
              Welcome to Traycer.
            </h1>
          </BrandEntrance>
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
        data-welcoming={welcomePhase === "welcome"}
        className="onboarding-tour-layer relative z-10 flex h-full min-h-0 w-full flex-col pt-safe-top pr-safe-right pb-safe-bottom pl-safe-left"
      >
        <header className="onboarding-header flex shrink-0 items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <BrandMark className="h-6 w-auto text-foreground [&_g>path]:fill-current" />
            <span className="text-xl font-medium tracking-tight">traycer</span>
          </div>
          <ProgressRail steps={steps} activeIndex={index} />
          <button
            type="button"
            data-testid="onboarding-skip"
            onClick={() => finish("skipped")}
            className="onboarding-button onboarding-button--quiet"
          >
            Skip intro
          </button>
        </header>
        <section
          aria-label="Welcome to Traycer"
          className="onboarding-stage relative mx-auto flex min-h-0 w-full flex-1 flex-col overflow-hidden"
        >
          <div
            ref={stageRef}
            className="onboarding-stage-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            <div
              key={step.id}
              className="onboarding-content"
              data-step={step.id}
            >
              <div
                data-testid="onboarding-step"
                data-step-id={step.id}
                className="onboarding-copy min-w-0"
              >
                <h1
                  ref={headingRef}
                  tabIndex={-1}
                  className="onboarding-title font-medium outline-none"
                >
                  {step.title}
                </h1>
                {step.body !== null ? (
                  <p className="onboarding-description text-muted-foreground">
                    {step.body}
                  </p>
                ) : null}
              </div>
              <div className="onboarding-visual min-w-0">
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
                      if (!replay) useFirstTaskGuideStore.getState().activate();
                      complete();
                      return Promise.resolve(true);
                    }}
                  />
                ) : null}
              </div>
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
              className={cn(
                "onboarding-progress-segment block h-1 w-6 rounded-full bg-foreground/15",
                index < props.activeIndex && "bg-foreground/50",
                index === props.activeIndex && "bg-foreground",
              )}
            />
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
    <footer className="onboarding-actions flex shrink-0 items-center justify-end gap-3">
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
