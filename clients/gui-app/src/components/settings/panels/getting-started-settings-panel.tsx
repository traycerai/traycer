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
  SETUP_GUIDE_LENGTHS,
  onboardingCompletedCount,
  ONBOARDING_GUIDE_COUNT,
} from "@/stores/onboarding/onboarding-store";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useHostBinding } from "@/lib/host";
import { cn } from "@/lib/utils";
import { GETTING_STARTED } from "./getting-started-settings.definitions";

const CARDS = [
  {
    id: "tour",
    icon: PanelsTopLeft,
    title: "Initial tour",
    description: "Your workspace, providers, and tasks.",
  },
  {
    id: "agents",
    icon: Bot,
    title: "Agent selection",
    description: "Choose how agents delegate work.",
  },
  {
    id: "appearance",
    icon: Palette,
    title: "Appearance",
    description: "Themes, start page, and fonts.",
  },
  {
    id: "cookies",
    icon: Cookie,
    title: "Browser sign-ins",
    description: "Bring your cookies from another browser.",
  },
] as const;

export function GettingStartedSettingsPanel() {
  const navigate = useNavigate();
  const completedAt = useOnboardingStore((state) => state.completedAt);
  const progress = useOnboardingStore((state) => state.setupProgress);
  const browserView = useRunnerHostOrNull()?.browserView ?? null;
  const hostBinding = useHostBinding();
  const complete = useOnboardingStore(onboardingCompletedCount);
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
          {complete} of {ONBOARDING_GUIDE_COUNT} complete
        </span>
      }
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-3">
        {CARDS.map((card) => {
          const done =
            card.id === "tour"
              ? completedAt !== null
              : progress[card.id] === SETUP_GUIDE_LENGTHS[card.id];
          const started = card.id !== "tour" && progress[card.id] >= 0;
          let unavailableReason: string | null = null;
          if (card.id === "cookies") {
            if (browserView === null)
              unavailableReason = "Available in the desktop app";
            else if (hostBinding === null)
              unavailableReason = "Connect a host to continue";
          }
          const unavailable = unavailableReason !== null;
          let status = "Not started";
          let action = "Start guide";
          if (started) {
            status = "In progress";
            action = "Resume";
          }
          if (done) {
            status = "Complete";
            action = card.id === "tour" ? "Replay" : "Revisit";
          }
          return (
            <button
              key={card.id}
              type="button"
              disabled={unavailable}
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
                  card.id === "cookies" ? "general" : card.id,
                );
              }}
              aria-label={`${card.title}, ${status}${unavailableReason === null ? "" : `, ${unavailableReason}`}`}
              className={cn(
                "group flex min-w-0 flex-col items-start rounded-xl border border-border/60 bg-card/40 p-5 text-left transition-[background-color,border-color] duration-150 hover:border-border hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-55 motion-reduce:transition-none",
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
              <h2 className="text-ui-sm font-medium">{card.title}</h2>
              <p className="mt-1 text-ui-sm leading-relaxed text-muted-foreground">
                {card.description}
              </p>
              <span className="mt-auto flex w-full items-center justify-between gap-2 pt-7 text-ui-xs text-muted-foreground">
                {unavailableReason ?? action}
                {unavailable ? null : (
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                )}
              </span>
            </button>
          );
        })}
      </div>
    </SettingsPanelShell>
  );
}
