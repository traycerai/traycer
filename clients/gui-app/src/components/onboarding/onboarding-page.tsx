import {
  type MouseEvent,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { AnimatePresence, m } from "motion/react";
import { traycerInfo } from "@traycer-clients/shared/platform/traycer-info";
import geistPixelSquareUrl from "@/assets/fonts/GeistPixel-Square.woff2?url";
import onboardingBackdropUrl from "@/assets/brand/gradient-bg.jpg?url";
import { BrandMark } from "@/components/auth/cinematic-backdrop";
import {
  ONBOARDING_ACTS,
  type OnboardingAct,
} from "@/components/onboarding/onboarding-acts";
import { OnboardingDetectedAgents } from "@/components/onboarding/onboarding-detected-agents";
import {
  OnboardingDiorama,
  type OnboardingAgentGuideState,
} from "@/components/onboarding/onboarding-diorama";
import { OnboardingThemePicker } from "@/components/onboarding/onboarding-theme-picker";
import { useAgentSelectionGuideGlobalOnboardingDraftQuery } from "@/hooks/agent/use-agent-selection-guide-global-onboarding-draft-query";
import { useAgentSelectionGuideSetGlobalMutation } from "@/hooks/agent/use-agent-selection-guide-set-global-mutation";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { getClientAppVersionLabel } from "@/lib/app-version";
import {
  selectIsLastStep,
  selectStep,
  useOnboardingStore,
} from "@/stores/onboarding/onboarding-store";
import { cn } from "@/lib/utils";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

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

/* When the mini-app is dropped (providers act), the providers list owns the
   remaining space so long provider catalogs can scroll. */
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
}`;

function ActCopy(props: { act: OnboardingAct }) {
  const { act } = props;
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const isAgentsAct = act.addon === "agents";

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <m.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.28, ease: ACT_EASE }}
      className={cn(
        "onboarding-copy flex min-h-0 w-full flex-col items-center text-center lg:items-start lg:text-left",
        isAgentsAct && "h-full",
      )}
    >
      <p className="onboarding-copy-kicker hidden font-mono leading-normal font-medium tracking-[0.07em] text-white/55 uppercase lg:block">
        {act.eyebrow}
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
      {isAgentsAct ? (
        <div className="onboarding-addon flex min-h-0 w-full flex-1 flex-col self-center overflow-hidden pt-1 text-left lg:self-start">
          <OnboardingDetectedAgents />
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

function ProgressRail(props: { activeIndex: number }) {
  const { activeIndex } = props;
  return (
    <div
      aria-hidden="true"
      className="onboarding-progress flex items-center gap-0.5"
    >
      {ONBOARDING_ACTS.map((act, index) => (
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

function Kbd(props: {
  readonly children: ReactNode;
  readonly tone: "light" | "dark";
}) {
  const { children, tone } = props;
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
  const navigate = useNavigate();
  const router = useRouter();
  const { replay } = props;
  const step = useOnboardingStore(selectStep);
  const isLastAct = useOnboardingStore(selectIsLastStep);
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

  const act = ONBOARDING_ACTS[step];
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
  const advanceDisabled = (isAgentGuideAct || isLastAct) && agentGuideSaving;

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
    const destination = ONBOARDING_ACTS[Math.max(0, step - 1)] ?? act;
    retreat();
    Analytics.getInstance().track(AnalyticsEvent.OnboardingNavigated, {
      direction: "back",
      step: destination.id,
    });
  }, [act, retreat, step]);

  const advance = useCallback((): void => {
    if (advanceDisabled) return;
    const advancePastCurrent = (): void => {
      if (isLastAct) {
        finish("completed");
        return;
      }
      const destination = ONBOARDING_ACTS[step + 1] ?? act;
      advanceStep();
      Analytics.getInstance().track(AnalyticsEvent.OnboardingNavigated, {
        direction: "continue",
        step: destination.id,
      });
    };
    advancePastCurrent();
  }, [act, advanceDisabled, advanceStep, finish, isLastAct, step]);
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

  return (
    <main className="onboarding-shell relative isolate flex h-svh flex-1 overflow-hidden bg-[#0f1917] text-white">
      <style>{ONBOARDING_STYLE}</style>
      <div
        className="pointer-events-none absolute inset-0 bg-cover bg-center opacity-40"
        style={{ backgroundImage: `url(${onboardingBackdropUrl})` }}
      />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(14,27,24,0.88),rgba(14,27,24,0.88)),radial-gradient(120%_90%_at_50%_-18%,rgba(95,125,113,0.18),transparent_58%)]" />

      <div className="relative z-10 grid h-svh w-full grid-rows-[var(--onboarding-shell-rows)] overflow-hidden">
        <header className="relative z-10">
          <div className="relative flex h-full items-center justify-center px-10 max-sm:px-5">
            <OnboardingWordmark />
            <button
              type="button"
              data-testid="onboarding-skip"
              onClick={() => finish("skipped")}
              disabled={agentGuideSaving}
              className="absolute right-10 flex h-9 items-center justify-center gap-2 rounded px-2 font-heading text-[0.875rem] leading-[1.125rem] font-normal tracking-normal text-white transition-colors hover:bg-white/10 disabled:pointer-events-none disabled:opacity-55 [@media(min-height:920px)]:h-10 [@media(min-height:920px)]:text-[0.9375rem] max-sm:right-5"
            >
              <span>Skip intro</span>
              <Kbd tone="light">Esc</Kbd>
            </button>
          </div>
        </header>

        <section className="min-h-0 px-[var(--onboarding-section-x)]">
          <div
            className="relative h-full min-h-0 overflow-hidden rounded-[0.875rem] bg-[#303b37] bg-cover bg-center shadow-[0_2rem_6rem_rgba(0,0,0,0.34),inset_0_1px_0_rgba(255,255,255,0.05)]"
            style={{ backgroundImage: `url(${onboardingBackdropUrl})` }}
          >
            <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(0deg,rgba(48,59,55,0.72),rgba(48,59,55,0.72)),linear-gradient(135deg,rgba(12,30,26,0)_27%,rgba(188,205,197,0.13)_53%,rgba(12,30,26,0)_72%)]" />
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(82%_68%_at_47%_87%,rgba(16,40,36,0.82),transparent_68%)]" />
            <div
              className={cn(
                "onboarding-stage-content relative mx-auto grid h-full min-h-0 w-full max-w-[104rem] items-start overflow-hidden",
                // The providers act needs a stretched copy rail so its list can scroll.
                act.addon === "agents" && "onboarding-stage-content--solo",
              )}
            >
              <div className="onboarding-copy-rail flex min-h-0 min-w-0 flex-col items-center lg:items-start">
                <div className="hidden w-full justify-center lg:flex lg:justify-start">
                  <ProgressRail activeIndex={step} />
                </div>

                <div className="mt-7 w-full min-w-0">
                  <AnimatePresence mode="wait" initial={false}>
                    <ActCopy key={act.id} act={act} />
                  </AnimatePresence>
                </div>
              </div>

              {/*
                The live miniature follows the user's real theme on every act, so
                the preview always matches what the app looks like for them. It
                renders with the same semantic tokens as the real shell.
              */}
              <div
                className={cn(
                  "onboarding-diorama-wrap mx-auto w-full min-w-0 self-start lg:mx-0 lg:self-center",
                  // The providers list carries the act on its own; drop the
                  // mini-app when stacked. (Command-theme keeps its diorama,
                  // which itself shows just the Cmd+K palette when stacked.)
                  act.addon === "agents" && "max-lg:hidden",
                )}
              >
                {/* Fade the mini-app in place on each act so it never slides up
                    from the bottom when reappearing (e.g. providers → handoff). */}
                <m.div
                  key={step}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.25, ease: ACT_EASE }}
                  className="w-full min-w-0"
                >
                  <OnboardingDiorama
                    stage={step}
                    agentGuide={agentGuideState}
                  />
                </m.div>
              </div>
            </div>
            {/* Stacked screens: blur + fade the mini-app's lower edge behind the
                actions bar so it reads as a clean footer, not a cut-off pane. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 z-[5] h-[6rem] bg-gradient-to-t from-[#303b37] via-[#303b37]/75 to-transparent backdrop-blur-sm [mask-image:linear-gradient(to_top,black_55%,transparent)] lg:hidden"
            />
            <div className="onboarding-actions absolute z-10 flex items-center justify-end gap-3">
              <div className="mr-auto flex min-w-0 max-w-[14rem] flex-1 flex-col gap-1.5 lg:hidden">
                <p className="truncate font-mono text-[0.6875rem] leading-none font-medium tracking-[0.07em] text-white/55 uppercase">
                  {act.eyebrow}
                </p>
                <ProgressRail activeIndex={step} />
              </div>
              {step > 0 ? (
                <button
                  type="button"
                  onClick={retreatWithAnalytics}
                  className="flex h-9 items-center justify-center gap-2 rounded px-3 font-heading text-[0.875rem] leading-[1.125rem] font-medium text-white transition-colors hover:bg-white/10 [@media(min-height:920px)]:h-10 [@media(min-height:920px)]:px-4 [@media(min-height:920px)]:text-[0.9375rem]"
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
  const runnerHost = use(RunnerHostContext);

  const openInBrowser = useCallback((url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  const openFooterLink = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, url: string) => {
      event.preventDefault();
      if (runnerHost !== null) {
        void runnerHost.openExternalLink(url).catch(() => {
          openInBrowser(url);
        });
        return;
      }
      openInBrowser(url);
    },
    [openInBrowser, runnerHost],
  );

  return (
    <nav aria-label="Traycer footer links" className="hidden sm:block">
      <ul className="flex items-center gap-8">
        {ONBOARDING_FOOTER_LINKS.map((link) => (
          <li key={link.label}>
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => openFooterLink(event, link.url)}
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
