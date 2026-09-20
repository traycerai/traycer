import {
  ArrowRight,
  Bot,
  Check,
  Cookie,
  Palette,
  PanelsTopLeft,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";
import { activateTabIntent } from "@/lib/tab-navigation";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import {
  useOnboardingStore,
  onboardingCompletedCount,
  onboardingGuideCount,
} from "@/stores/onboarding/onboarding-store";
import {
  isSetupGuideAvailable,
  setupGuideLength,
  setupGuideStepSection,
  type SetupGuideId,
} from "@/stores/onboarding/setup-guides";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useHostBinding } from "@/lib/host";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { isMobileApp } from "@/lib/mobile-app";
import { cn } from "@/lib/utils";
import { GETTING_STARTED } from "./getting-started-settings.definitions";
import "./getting-started-settings.css";

const CARDS = [
  {
    id: "tour",
    icon: PanelsTopLeft,
    row: GETTING_STARTED.definitions.productTour,
  },
  {
    id: "agents",
    icon: Bot,
    row: GETTING_STARTED.definitions.agentSelection,
  },
  {
    id: "appearance",
    icon: Palette,
    row: GETTING_STARTED.definitions.appearanceAndLayout,
  },
  {
    id: "cookies",
    icon: Cookie,
    row: GETTING_STARTED.definitions.browserSignIns,
  },
] as const;

type CardId = (typeof CARDS)[number]["id"];

/**
 * The one unavailability that is a fact about the BUILD rather than a state the
 * user can leave. Named, because the phone branch below has to tell the two
 * apart: a reason that can change keeps its card, this one collapses to a
 * footnote.
 */
const UNAVAILABLE_ON_THIS_SHELL = "Available in the desktop app";

/**
 * What "Replay" replays on the installed app, which is not what the shared
 * definition says.
 *
 * The definition's "Your workspace, providers, and tasks." names the three acts,
 * and the installed app runs none of them - its tour is the welcome and then the
 * guided tour of the tasks over the real app. Overridden HERE rather than in the
 * definition because the definition is also the settings-search copy, which is
 * the desktop's and stays true there.
 */
const MOBILE_APP_TOUR_DESCRIPTION = "A quick tour of your tasks.";
const MOBILE_APP_TOUR_LABEL = "Guided tour";

/** Everything a card prints, derived once so the markup only reads it. */
function cardPresentation(
  id: CardId,
  input: {
    readonly completedAt: number | null;
    readonly progress: Record<SetupGuideId, number>;
    readonly shell: { readonly browserView: boolean };
    readonly hostBound: boolean;
  },
): {
  readonly done: boolean;
  readonly started: boolean;
  /** Steps already completed, what the meter fills. */
  readonly completed: number;
  readonly total: number;
  readonly status: string;
  readonly action: string;
  readonly unavailableReason: string | null;
} {
  if (id === "tour") {
    const done = input.completedAt !== null;
    return {
      done,
      started: false,
      completed: 0,
      total: 0,
      status: done ? "Complete" : "Not started",
      action: done ? "Replay" : "Start guide",
      unavailableReason: null,
    };
  }
  const total = setupGuideLength(id);
  const step = input.progress[id];
  const done = step === total;
  const started = step >= 0;
  let unavailableReason: string | null = null;
  if (!isSetupGuideAvailable(id, input.shell))
    unavailableReason = UNAVAILABLE_ON_THIS_SHELL;
  else if (id === "cookies" && !input.hostBound)
    unavailableReason = "Connect a host to continue";
  let status = "Not started";
  let action = "Start guide";
  if (started) {
    status = `Step ${step + 1} of ${total}`;
    action = "Resume";
  }
  if (done) {
    status = "Complete";
    action = "Revisit";
  }
  return {
    done,
    started,
    completed: Math.max(0, step),
    total,
    status,
    action,
    unavailableReason,
  };
}

/**
 * A guide this shell cannot offer at all - browser sign-ins with no
 * `browserView` - as opposed to one that is merely blocked right now.
 *
 * The distinction is what decides whether the card stays. "Connect a host to
 * continue" is a state the user can leave, so it keeps a card they can come
 * back to; the other is a fact about the build they are holding, and on a phone
 * a full disabled card for it is the largest thing on the screen saying the
 * least.
 */
function permanentlyUnavailable(reason: string | null): boolean {
  return reason === UNAVAILABLE_ON_THIS_SHELL;
}

export function GettingStartedSettingsPanel() {
  const navigate = useNavigate();
  const completedAt = useOnboardingStore((state) => state.completedAt);
  const progress = useOnboardingStore((state) => state.setupProgress);
  const browserView = useRunnerHostOrNull()?.browserView ?? null;
  const hostBinding = useHostBinding();
  const availability = useSettingsAvailabilityContext();
  const phone = useIsMobileViewport();
  const shell = { browserView: browserView !== null };
  const complete = useOnboardingStore((state) =>
    onboardingCompletedCount(state, shell),
  );
  const guideCount = onboardingGuideCount(shell);
  const cards = CARDS.map((card) => ({
    card,
    presentation: cardPresentation(card.id, {
      completedAt,
      progress,
      shell,
      hostBound: hostBinding !== null,
    }),
  }));
  // Already excluded from the denominator above (`onboardingGuideCount`), so
  // dropping the card changes nothing the panel counts - only what it draws.
  const footnoted = phone
    ? cards.filter(({ presentation }) =>
        permanentlyUnavailable(presentation.unavailableReason),
      )
    : [];
  const visible = cards.filter((entry) => !footnoted.includes(entry));
  return (
    <SettingsPanelShell
      title={GETTING_STARTED.page.label}
      description={GETTING_STARTED.page.description}
      bodyClassName="overflow-visible rounded-none border-0 bg-transparent"
      headerAction={
        <span
          className="text-ui-xs tabular-nums text-muted-foreground"
          role="status"
        >
          {complete} of {guideCount} complete
        </span>
      }
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-3">
        {visible.map(({ card, presentation }) => {
          const {
            done,
            started,
            completed,
            total,
            status,
            action,
            unavailableReason,
          } = presentation;
          const unavailable = unavailableReason !== null;
          return (
            <button
              key={card.id}
              type="button"
              disabled={unavailable}
              data-settings-anchor={card.row.anchor}
              data-testid={
                card.id === "tour" ? "settings-replay-onboarding" : undefined
              }
              onClick={() => {
                if (card.id === "tour") {
                  if (isMobileApp()) {
                    // The phone's tour is the guided one on the start page, so
                    // the card starts THAT rather than replaying a welcome
                    // that only leads back to it. A tab intent, not a route
                    // navigation: Settings is a tab here, and a bare navigate
                    // to the draft route leaves the user looking at Settings.
                    // Armed only once the tab has actually changed: a refused
                    // activation would otherwise leave a live guide running
                    // behind a Settings page that never went away.
                    const guide = useFirstTaskGuideStore.getState();
                    guide.prepare();
                    if (
                      activateTabIntent(
                        navigate,
                        openNewEpicIntent(),
                        undefined,
                      )
                    )
                      guide.activate();
                    return;
                  }
                  useOnboardingStore.getState().restart();
                  void navigate({
                    to: "/onboarding",
                    search: { replay: true },
                  });
                  return;
                }
                useOnboardingStore.getState().startSetup(card.id);
                navigateToSettingsSection(
                  setupGuideStepSection(
                    card.id,
                    useOnboardingStore.getState().activeSetup?.step ?? 0,
                    availability,
                  ),
                );
              }}
              aria-label={`${card.id === "tour" && isMobileApp() ? MOBILE_APP_TOUR_LABEL : card.row.label}, ${status}${unavailableReason === null ? "" : `, ${unavailableReason}`}`}
              className={cn(
                "settings-setup-card group flex min-w-0 flex-col items-start overflow-hidden rounded-xl border border-border/60 bg-card/40 p-5 text-left transition-[background-color,border-color] duration-150 hover:border-border hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-55 motion-reduce:transition-none",
                done && "border-primary/20",
              )}
            >
              <div className="mb-6 flex w-full items-center justify-between gap-2">
                <card.icon
                  className="size-5 text-muted-foreground"
                  aria-hidden="true"
                />
                <span
                  className={cn(
                    "flex items-center gap-1.5 text-ui-xs",
                    done ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {done ? (
                    <Check
                      className="size-3.5 text-[var(--term-ansi-green)]"
                      aria-hidden="true"
                    />
                  ) : null}
                  {status}
                </span>
              </div>
              <h2 className="text-ui-sm font-medium">
                {card.id === "tour" && isMobileApp()
                  ? MOBILE_APP_TOUR_LABEL
                  : card.row.label}
              </h2>
              <p className="mt-1 text-ui-sm leading-relaxed text-muted-foreground">
                {card.id === "tour" && isMobileApp()
                  ? MOBILE_APP_TOUR_DESCRIPTION
                  : card.row.description}
              </p>
              <span className="mt-auto flex w-full items-center justify-between gap-2 pt-7 text-ui-xs text-muted-foreground">
                {unavailableReason ?? action}
                {unavailable ? null : (
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                )}
              </span>
              {started && !done ? (
                // COMPLETED steps, not the one being shown: the status line
                // above already reads "Step n of total", and a full bar beside
                // "Step 5 of 5 · Resume" would claim a finish that has not
                // happened. The element computes its own fill, so no fraction
                // needs writing out. Decoration for that line rather than a
                // second reading of it, hence aria-hidden.
                <progress
                  aria-hidden="true"
                  value={completed}
                  max={total}
                  className="settings-setup-meter -mx-5 -mb-5 mt-4 h-0.5 self-stretch"
                />
              ) : null}
            </button>
          );
        })}
      </div>
      {/* One line, not a card each: these guides cannot run on this shell at
          all, and a phone has room for the guides it CAN offer. Named rather
          than counted, so the user can tell which one they are missing, and
          plain text rather than a disabled control, because there is nothing
          here to press. */}
      {footnoted.length > 0 ? (
        <p
          data-testid="getting-started-unavailable-note"
          className="mt-4 text-ui-xs text-muted-foreground"
        >
          {footnoted.map(({ card }) => card.row.label).join(", ")}:{" "}
          {UNAVAILABLE_ON_THIS_SHELL.toLowerCase()}.
        </p>
      ) : null}
    </SettingsPanelShell>
  );
}
