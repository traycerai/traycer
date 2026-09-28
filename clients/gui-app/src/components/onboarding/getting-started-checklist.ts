import { Bot, Cookie, Palette, PanelsTopLeft } from "lucide-react";
import {
  useOnboardingStore,
  onboardingCompletedCount,
  onboardingGuideCount,
} from "@/stores/onboarding/onboarding-store";
import {
  isSetupGuideAvailable,
  setupGuideLength,
  type SetupGuideId,
} from "@/stores/onboarding/setup-guides";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useHostBinding } from "@/lib/host";
import { GETTING_STARTED } from "@/components/settings/panels/getting-started-settings.definitions";

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

export type GettingStartedCard = (typeof CARDS)[number];
export type GettingStartedCardId = GettingStartedCard["id"];

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
export interface CardPresentation {
  readonly done: boolean;
  readonly started: boolean;
  /** Steps already completed, what the meter fills. */
  readonly completed: number;
  readonly total: number;
  readonly status: string;
  readonly action: string;
  readonly unavailableReason: string | null;
}

export interface GettingStartedEntry {
  readonly card: GettingStartedCard;
  readonly presentation: CardPresentation;
}

function cardPresentation(
  id: GettingStartedCardId,
  input: {
    readonly completedAt: number | null;
    readonly progress: Record<SetupGuideId, number>;
    readonly shell: { readonly browserView: boolean };
    readonly hostBound: boolean;
  },
): CardPresentation {
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
 * `browserView` - as opposed to one that is merely blocked right now. It is
 * already out of the count (`onboardingGuideCount`), so dropping its card
 * changes nothing a surface counts - only what it draws.
 */
export function isPermanentlyUnavailable(entry: GettingStartedEntry): boolean {
  return entry.presentation.unavailableReason === UNAVAILABLE_ON_THIS_SHELL;
}

export const UNAVAILABLE_ON_THIS_SHELL_NOTE =
  UNAVAILABLE_ON_THIS_SHELL.toLowerCase();

/**
 * The checklist as every surface reads it: one entry per card, plus the
 * "n of m" over the guides this shell can OFFER.
 */
export function useGettingStartedChecklist(): {
  readonly entries: readonly GettingStartedEntry[];
  readonly complete: number;
  readonly guideCount: number;
} {
  const completedAt = useOnboardingStore((state) => state.completedAt);
  const progress = useOnboardingStore((state) => state.setupProgress);
  const browserView = useRunnerHostOrNull()?.browserView ?? null;
  const hostBinding = useHostBinding();
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
        hostBound: hostBinding !== null,
      }),
    })),
    complete,
    guideCount: onboardingGuideCount(shell),
  };
}
