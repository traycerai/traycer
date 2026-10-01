import { ArrowRight, Check } from "lucide-react";
import { useNavigate, type UseNavigateResult } from "@tanstack/react-router";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";
import { activateTabIntent } from "@/lib/tab-navigation";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { setupGuideStepSection } from "@/stores/onboarding/setup-guides";
import { isMobileApp } from "@/lib/mobile-app";
import { cn } from "@/lib/utils";
import {
  MOBILE_APP_TOUR_DESCRIPTION,
  MOBILE_APP_TOUR_LABEL,
  type GettingStartedCardId,
  type GettingStartedEntry,
} from "@/components/onboarding/getting-started-checklist";
import "@/components/settings/panels/getting-started-settings.css";

/**
 * The card grid. `settings` is the Getting started page itself; `home` is the
 * Home tab's copy of it, which is denser because it sits above the task
 * sections, and carries no search anchors - both surfaces can be mounted at
 * once (Settings over Home), and the anchor reveal must land on the Settings
 * card.
 */
export function GettingStartedCards(props: {
  readonly entries: readonly GettingStartedEntry[];
  readonly surface: CardSurface;
}) {
  const navigate = useNavigate();
  return (
    <div
      className={cn(
        "grid gap-3",
        cardGridColumns(props.surface, props.entries.length),
      )}
    >
      {props.entries.map((entry) => (
        <GettingStartedCardButton
          key={entry.card.id}
          entry={entry}
          surface={props.surface}
          onOpen={() => {
            openGettingStartedCard(entry.card.id, navigate);
          }}
        />
      ))}
    </div>
  );
}

function openGettingStartedCard(
  id: GettingStartedCardId,
  navigate: UseNavigateResult<string>,
): void {
  if (id === "tour") {
    if (isMobileApp()) {
      // The phone's tour is the guided one on the start page, so the card
      // starts THAT rather than replaying a welcome that only leads back to
      // it. A tab intent, not a route navigation: Settings is a tab here, and
      // a bare navigate to the draft route leaves the user looking at
      // Settings. Armed only once the tab has actually changed: a refused
      // activation would otherwise leave a live guide running behind a
      // Settings page that never went away.
      const guide = useFirstTaskGuideStore.getState();
      guide.prepare();
      if (activateTabIntent(navigate, openNewEpicIntent(), undefined))
        guide.activate();
      return;
    }
    useOnboardingStore.getState().restart();
    void navigate({ to: "/onboarding", search: { replay: true } });
    return;
  }
  useOnboardingStore.getState().startSetup(id);
  navigateToSettingsSection(
    setupGuideStepSection(
      id,
      useOnboardingStore.getState().activeSetup?.step ?? 0,
    ),
  );
}

type CardSurface = "settings" | "home";

/**
 * Settings lets the row find its own count. Home steps between whole rows
 * instead - four across, two by two, one - because Home can be a slim tile in
 * a wide window, and an auto-fit row there leaves a single card orphaned under
 * three. It reads its own width, not the viewport's, so the section around it
 * must be a `@container`.
 */
function cardGridColumns(surface: CardSurface, count: number): string {
  if (surface === "settings")
    return "grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))]";
  return count === 4
    ? "grid-cols-1 @xs:grid-cols-2 @2xl:grid-cols-4"
    : "grid-cols-1 @lg:grid-cols-3";
}

/** How much air a card has, the other thing the two surfaces draw differently. */
const CARD_SPACING: Record<
  CardSurface,
  {
    readonly card: string;
    readonly header: string;
    readonly footer: string;
    readonly meter: string;
  }
> = {
  settings: {
    card: "p-5",
    header: "mb-6",
    footer: "pt-7",
    meter: "-mx-5 -mb-5 mt-4",
  },
  home: {
    card: "p-4",
    header: "mb-3",
    footer: "pt-4",
    meter: "-mx-4 -mb-4 mt-3",
  },
};

function GettingStartedCardButton(props: {
  readonly entry: GettingStartedEntry;
  readonly surface: CardSurface;
  readonly onOpen: () => void;
}) {
  const { card, presentation } = props.entry;
  const spacing = CARD_SPACING[props.surface];
  const anchored = props.surface === "settings";
  const { done, started, completed, total, status, action, unavailableReason } =
    presentation;
  const unavailable = unavailableReason !== null;
  const mobileTour = card.id === "tour" && isMobileApp();
  const label = mobileTour ? MOBILE_APP_TOUR_LABEL : card.row.label;
  const description = mobileTour
    ? MOBILE_APP_TOUR_DESCRIPTION
    : card.row.description;
  return (
    <button
      type="button"
      disabled={unavailable}
      data-settings-anchor={anchored ? card.row.anchor : undefined}
      data-testid={
        anchored && card.id === "tour"
          ? "settings-replay-onboarding"
          : undefined
      }
      onClick={props.onOpen}
      aria-label={[label, status, unavailableReason]
        .filter((part) => part !== null)
        .join(", ")}
      className={cn(
        "settings-setup-card group flex min-w-0 flex-col items-start overflow-hidden rounded-xl border border-border/60 bg-card/40 text-left transition-[background-color,border-color] duration-150 hover:border-border hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-55 motion-reduce:transition-none",
        spacing.card,
        done && "border-primary/20",
      )}
    >
      <div
        className={cn(
          "flex w-full items-center justify-between gap-2",
          spacing.header,
        )}
      >
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
      <h2 className="text-ui-sm font-medium">{label}</h2>
      <p className="mt-1 text-ui-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
      <span
        className={cn(
          "mt-auto flex w-full items-center justify-between gap-2 text-ui-xs text-muted-foreground",
          spacing.footer,
        )}
      >
        {unavailableReason ?? action}
        {unavailable ? null : (
          <ArrowRight className="size-3.5" aria-hidden="true" />
        )}
      </span>
      {started && !done ? (
        // COMPLETED steps, not the one being shown: the status line above
        // already reads "Step n of total", and a full bar beside "Step 5 of 5 ·
        // Resume" would claim a finish that has not happened. The element
        // computes its own fill, so no fraction needs writing out. Decoration
        // for that line rather than a second reading of it, hence aria-hidden.
        <progress
          aria-hidden="true"
          value={completed}
          max={total}
          className={cn(
            "settings-setup-meter h-0.5 self-stretch",
            spacing.meter,
          )}
        />
      ) : null}
    </button>
  );
}
