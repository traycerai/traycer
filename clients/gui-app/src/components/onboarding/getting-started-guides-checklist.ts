import { Bot, Cookie, Palette, PanelsTopLeft } from "lucide-react";
import {
  useOnboardingStore,
  onboardingCompletedCount,
  onboardingGuideCount,
} from "@/stores/onboarding/onboarding-store";
import {
  isSetupGuideAvailable,
  setupGuideLength,
  setupGuideStepsFor,
  type SetupGuideId,
} from "@/stores/onboarding/setup-guides";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useHostBinding } from "@/lib/host";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import { isLayoutEditorAvailable } from "@/lib/settings/settings-availability";
import { GETTING_STARTED_GUIDES } from "@/components/settings/panels/getting-started-settings.definitions";

/**
 * The 1.5.1 Getting started checklist: the tour and the three setup guides,
 * read from the onboarding store. A build without environments
 * (`unreleased-features.ts`) shows this one on Home and in Settings; the
 * build with them shows the first steps (`getting-started-checklist.ts`).
 */

const CARDS = [
  {
    id: "tour",
    icon: PanelsTopLeft,
    row: GETTING_STARTED_GUIDES.definitions.productTour,
  },
  {
    id: "agents",
    icon: Bot,
    row: GETTING_STARTED_GUIDES.definitions.agentSelection,
  },
  {
    id: "appearance",
    icon: Palette,
    row: GETTING_STARTED_GUIDES.definitions.appearanceAndLayout,
  },
  {
    id: "cookies",
    icon: Cookie,
    row: GETTING_STARTED_GUIDES.definitions.browserSignIns,
  },
] as const;

export type GettingStartedGuideCard = (typeof CARDS)[number];
export type GettingStartedGuideCardId = GettingStartedGuideCard["id"];

/**
 * The one unavailability that is a fact about the BUILD rather than a state the
 * user can leave. Named, because the surfaces have to tell the two apart: a
 * reason that can change keeps its card, this one does not earn a full card
 * everywhere.
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
export const MOBILE_APP_TOUR_DESCRIPTION = "A quick tour of your tasks.";
export const MOBILE_APP_TOUR_LABEL = "Guided tour";

/** Everything a card prints, derived once so the markup only reads it. */
export interface GuideCardPresentation {
  readonly done: boolean;
  readonly started: boolean;
  /** Steps already completed, what the meter fills. */
  readonly completed: number;
  readonly total: number;
  readonly status: string;
  readonly action: string;
  readonly unavailableReason: string | null;
  /**
   * The guide cannot run on this shell at all (as opposed to being blocked
   * right now): the Home filter and the phone footnote key on this, not on
   * the reason's wording.
   */
  readonly permanentlyUnavailable: boolean;
}

export interface GettingStartedGuideEntry {
  readonly card: GettingStartedGuideCard;
  readonly presentation: GuideCardPresentation;
}

function cardPresentation(
  id: GettingStartedGuideCardId,
  input: {
    readonly completedAt: number | null;
    readonly progress: Record<SetupGuideId, number>;
    readonly shell: { readonly browserView: boolean };
    readonly layoutEditor: boolean;
    readonly hostBound: boolean;
  },
): GuideCardPresentation {
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
      permanentlyUnavailable: false,
    };
  }
  // Stored progress counts the guide's whole step list, so "done" compares
  // against that; the printed total counts only the steps this shell walks.
  const length = setupGuideLength(id);
  const total = setupGuideStepsFor(id, {
    layoutEditor: input.layoutEditor,
  }).length;
  const step = input.progress[id];
  const done = step === length;
  const started = step >= 0;
  const permanentlyUnavailable = !isSetupGuideAvailable(id, input.shell);
  let unavailableReason: string | null = null;
  if (permanentlyUnavailable) unavailableReason = UNAVAILABLE_ON_THIS_SHELL;
  else if (id === "cookies" && !input.hostBound)
    unavailableReason = "Connect a host to continue";
  let status = "Not started";
  let action = "Start guide";
  if (started) {
    status = `Step ${Math.min(step + 1, total)} of ${total}`;
    action = "Resume";
  }
  if (done) {
    status = "Complete";
    action = "Revisit";
  }
  return {
    done,
    started,
    completed: Math.min(Math.max(0, step), total),
    total,
    status,
    action,
    unavailableReason,
    permanentlyUnavailable,
  };
}

/**
 * A guide this shell cannot offer at all - browser sign-ins with no
 * `browserView` - as opposed to one that is merely blocked right now. It is
 * already out of the count (`onboardingGuideCount`), so dropping its card
 * changes nothing a surface counts - only what it draws.
 */
export function isPermanentlyUnavailable(
  entry: GettingStartedGuideEntry,
): boolean {
  return entry.presentation.permanentlyUnavailable;
}

export const UNAVAILABLE_ON_THIS_SHELL_NOTE =
  UNAVAILABLE_ON_THIS_SHELL.toLowerCase();

/**
 * The checklist as every surface reads it: one entry per card, plus the
 * "n of m" over the guides this shell can OFFER.
 */
export function useGettingStartedGuidesChecklist(): {
  readonly entries: readonly GettingStartedGuideEntry[];
  readonly complete: number;
  readonly guideCount: number;
} {
  const completedAt = useOnboardingStore((state) => state.completedAt);
  const progress = useOnboardingStore((state) => state.setupProgress);
  const browserView = useRunnerHostOrNull()?.browserView ?? null;
  const hostBinding = useHostBinding();
  const availability = useSettingsAvailabilityContext();
  const layoutEditor = isLayoutEditorAvailable(availability);
  const shell = { browserView: browserView !== null };
  const complete = useOnboardingStore((state) =>
    onboardingCompletedCount(state, shell),
  );
  return {
    entries: CARDS.map((card) => ({
      card,
      presentation: cardPresentation(card.id, {
        completedAt,
        progress,
        shell,
        layoutEditor,
        hostBound: hostBinding !== null,
      }),
    })),
    complete,
    guideCount: onboardingGuideCount(shell),
  };
}
