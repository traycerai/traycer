import {
  ArrowRight,
  Bot,
  Check,
  Cookie,
  Palette,
  PanelsTopLeft,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
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
    unavailableReason = "Available in the desktop app";
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

export function GettingStartedSettingsPanel() {
  const navigate = useNavigate();
  const completedAt = useOnboardingStore((state) => state.completedAt);
  const progress = useOnboardingStore((state) => state.setupProgress);
  const browserView = useRunnerHostOrNull()?.browserView ?? null;
  const hostBinding = useHostBinding();
  const availability = useSettingsAvailabilityContext();
  const shell = { browserView: browserView !== null };
  const complete = useOnboardingStore((state) =>
    onboardingCompletedCount(state, shell),
  );
  const guideCount = onboardingGuideCount(shell);
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
        {CARDS.map((card) => {
          const {
            done,
            started,
            completed,
            total,
            status,
            action,
            unavailableReason,
          } = cardPresentation(card.id, {
            completedAt,
            progress,
            shell,
            hostBound: hostBinding !== null,
          });
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
              aria-label={`${card.row.label}, ${status}${unavailableReason === null ? "" : `, ${unavailableReason}`}`}
              className={cn(
                "group flex min-w-0 flex-col items-start overflow-hidden rounded-xl border border-border/60 bg-card/40 p-5 text-left transition-[background-color,border-color] duration-150 hover:border-border hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-55 motion-reduce:transition-none",
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
              <h2 className="text-ui-sm font-medium">{card.row.label}</h2>
              <p className="mt-1 text-ui-sm leading-relaxed text-muted-foreground">
                {card.row.description}
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
    </SettingsPanelShell>
  );
}
