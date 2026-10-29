import { Coins, Download, KeyRound, Lock, SquarePen } from "lucide-react";
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
    case "install":
      return facts.hasSecondPersonalComputer;
    case "credits":
      return facts.creditsAboveZero;
  }
}

export function gettingStartedVisibleCards(
  facts: GettingStartedFacts,
): readonly GettingStartedCard[] {
  return CARDS.filter((card) => card.id !== "credits" || facts.sandboxStaged);
}

/**
 * True when every step the Guide group currently shows is done. E4 hides
 * the group from this. Credits is in the count only while a sandbox is
 * staged in this window.
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
  return {
    providerSetUp:
      providers.data !== undefined && providerSetUp(providers.data.providers),
    hasTask: tasks.length > 0,
    hasSecret: secrets.data?.secrets.some((secret) => !secret.revoked) === true,
    hasSecondPersonalComputer:
      running.hosts.filter((host) => host.kind === "personal").length >= 2,
    sandboxStaged: sandboxIsStagedInThisWindow(staged),
    creditsAboveZero: (sandboxBalanceMc(user) ?? 0) > 0,
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
  const cards = gettingStartedVisibleCards(facts);
  const entries = cards.map((card) => ({
    card,
    presentation: cardPresentation(card, facts),
  }));
  const complete = entries.filter((entry) => entry.presentation.done).length;
  return {
    entries,
    complete,
    guideCount: cards.length,
    allDone: gettingStartedGuideIsComplete(facts),
  };
}
