import {
  Coins,
  Download,
  KeyRound,
  Lock,
  MonitorUp,
  SquarePen,
} from "lucide-react";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { LIST_CLOUD_TASKS_REQUEST } from "@/lib/cloud-epic-tasks-query";
import { useOptionalHostClient, type HostRpcRegistry } from "@/lib/host";
import { sandboxBalanceMc } from "@/lib/sandboxes/sandbox-balance";
import {
  sandboxIsStagedInThisWindow,
  useStagedSandboxInThisWindow,
} from "@/lib/sandboxes/staged-sandbox-in-window";
import { providerSetUp } from "@/components/onboarding/set-up-personal";
import { GETTING_STARTED } from "@/components/settings/panels/getting-started-settings.definitions";
import { useHostsRunningPersonal } from "@/components/settings/environment/use-hosts-running-configuration";
import { useThisComputer } from "@/components/settings/move/this-computer";
import {
  useThisComputersMove,
  type ThisComputersMove,
} from "@/components/settings/move/use-this-computers-move";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

const CARDS = [
  {
    id: "provider",
    icon: KeyRound,
    row: GETTING_STARTED.definitions.provider,
    action: "Open Providers",
  },
  {
    id: "task",
    icon: SquarePen,
    row: GETTING_STARTED.definitions.task,
    action: "Start a task",
  },
  {
    id: "secret",
    icon: Lock,
    row: GETTING_STARTED.definitions.secret,
    action: "Open Secrets",
  },
  {
    id: "move",
    icon: MonitorUp,
    row: GETTING_STARTED.definitions.move,
    action: "Show me what moves",
  },
  {
    id: "install",
    icon: Download,
    row: GETTING_STARTED.definitions.install,
    action: "Download",
  },
  {
    id: "credits",
    icon: Coins,
    row: GETTING_STARTED.definitions.credits,
    action: "Add credits",
  },
] as const;

export type GettingStartedCard = (typeof CARDS)[number];
export type GettingStartedCardId = GettingStartedCard["id"];

export interface GettingStartedFacts {
  readonly providerSetUp: boolean;
  readonly hasTask: boolean;
  readonly hasSecret: boolean;
  readonly hasSecondPersonalComputer: boolean;
  readonly sandboxStaged: boolean;
  readonly creditsAboveZero: boolean;
  /** Where this computer's own settings stand against Personal. */
  readonly thisComputersMove: ThisComputersMove;
}

/** Everything a card prints, derived once so the markup only reads it. */
export interface CardPresentation {
  readonly done: boolean;
  readonly status: string;
  readonly action: string;
}

export interface GettingStartedEntry {
  readonly card: GettingStartedCard;
  readonly presentation: CardPresentation;
}

function stepIsDone(
  id: GettingStartedCardId,
  facts: GettingStartedFacts,
): boolean {
  switch (id) {
    case "provider":
      return facts.providerSetUp;
    case "task":
      return facts.hasTask;
    case "secret":
      return facts.hasSecret;
    case "move":
      return facts.thisComputersMove === "moved";
    case "install":
      return facts.hasSecondPersonalComputer;
    case "credits":
      return facts.creditsAboveZero;
  }
}

/**
 * Whether a card is shown at all. Two are conditional, each on a fact about
 * whether the step EXISTS for this person rather than whether it is done:
 * credits while a sandbox is staged in this window, and the move while this
 * computer can say where its settings stand - a card nobody can finish would
 * hold the checklist open for ever.
 */
function cardApplies(
  card: GettingStartedCard,
  facts: GettingStartedFacts,
): boolean {
  if (card.id === "credits") return facts.sandboxStaged;
  if (card.id === "move") {
    const move = facts.thisComputersMove;
    return move === "not_moved" || move === "moved";
  }
  return true;
}

export function gettingStartedVisibleCards(
  facts: GettingStartedFacts,
): readonly GettingStartedCard[] {
  return CARDS.filter((card) => cardApplies(card, facts));
}

/**
 * True when every step the Guide group currently shows is done. E4 hides
 * the group from this. Credits is in the count only while a sandbox is
 * staged in this window, and the move only while this computer can answer it.
 */
export function gettingStartedGuideIsComplete(
  facts: GettingStartedFacts,
): boolean {
  return gettingStartedVisibleCards(facts).every((card) =>
    stepIsDone(card.id, facts),
  );
}

function cardPresentation(
  card: GettingStartedCard,
  facts: GettingStartedFacts,
): CardPresentation {
  const done = stepIsDone(card.id, facts);
  return {
    done,
    status: done ? "Complete" : "Not started",
    action: card.action,
  };
}

/** One entry per visible card, everything a card prints already derived. */
function gettingStartedEntries(
  facts: GettingStartedFacts,
): readonly GettingStartedEntry[] {
  return gettingStartedVisibleCards(facts).map((card) => ({
    card,
    presentation: cardPresentation(card, facts),
  }));
}

/**
 * Every fact the first steps are judged on.
 *
 * None of these reads carries an `UNRELEASED_FEATURES_ENABLED` gate of its
 * own, and none needs one: both surfaces that call this choose between this
 * checklist and the 1.5.1 guides on that flag
 * (`home-getting-started-section.tsx`, `getting-started-settings-panel.tsx`),
 * so a build without environments never renders a caller. The toast in
 * `first-task-guide.tsx` gates the same move read because ITS tree is mounted
 * either way.
 */
export function useGettingStartedFacts(): GettingStartedFacts {
  const client = useOptionalHostClient();
  const hostId = useRequesterHostId(client);
  const providers = useProvidersListForClient(client, {
    enabled: client !== null,
    subscribed: true,
  });
  const secretsSupported = useHostMethodSupport(
    hostId,
    "environment.secrets.list",
  );
  const secrets = useHostQuery<HostRpcRegistry, "environment.secrets.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.secrets.list",
    params: { environmentId: null },
    options: { enabled: secretsSupported === true },
  });
  const { tasks } = useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, {
    enabled: true,
  });
  // Complete once a second computer runs Personal: the computers Personal
  // reaches, not the account's host list, which leaves out a computer with
  // remote access off.
  const running = useHostsRunningPersonal(true);
  const user = useAuthUser().data ?? null;
  const staged = useStagedSandboxInThisWindow();
  // The move is about THIS computer, not the host this window happens to be
  // bound to: it is the computer whose settings the card offers to move, and
  // the one the sheet the card opens is for.
  const computer = useThisComputer();
  const thisComputersMove = useThisComputersMove(computer, true);
  return {
    providerSetUp:
      providers.data !== undefined && providerSetUp(providers.data.providers),
    hasTask: tasks.length > 0,
    hasSecret: secrets.data?.secrets.some((secret) => !secret.revoked) === true,
    hasSecondPersonalComputer:
      running.hosts.filter((host) => host.kind === "personal").length >= 2,
    sandboxStaged: sandboxIsStagedInThisWindow(staged),
    creditsAboveZero: (sandboxBalanceMc(user) ?? 0) > 0,
    thisComputersMove,
  };
}

function useFirstStepsAreComplete(): boolean {
  return gettingStartedGuideIsComplete(useGettingStartedFacts());
}

/**
 * Whether the Guide group has nothing left to show (E4). A build without
 * environments (`unreleased-features.ts`) shows the 1.5.1 guides
 * (`getting-started-guides-checklist.ts`), which never hide the group, and
 * reads none of the first steps' facts.
 */
export const useGettingStartedGuideIsComplete: () => boolean =
  UNRELEASED_FEATURES_ENABLED ? useFirstStepsAreComplete : () => false;

/**
 * The checklist as every surface reads it: one entry per visible card, plus
 * the "n of m" over those cards.
 */
export function useGettingStartedChecklist(): {
  readonly entries: readonly GettingStartedEntry[];
  readonly complete: number;
  readonly guideCount: number;
  readonly allDone: boolean;
} {
  const facts = useGettingStartedFacts();
  const entries = gettingStartedEntries(facts);
  const complete = entries.filter((entry) => entry.presentation.done).length;
  return {
    entries,
    complete,
    guideCount: entries.length,
    allDone: gettingStartedGuideIsComplete(facts),
  };
}
