import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { HomeBotsGroup } from "@/lib/home-bots/bots-model";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import {
  useHostMethodSchemaVersion,
  useHostMethodSupport,
} from "@/hooks/host/use-host-supports-method";

/**
 * A team whose main bot is still to be set up (Tracy Bots T67): the team has
 * no live bot, and its onboarding names the bot it will have (`setup`). Its
 * channel opens on that bot's id before the bot exists.
 */
export interface TeamSetup {
  readonly environmentId: string;
  readonly teamName: string;
  readonly botId: string;
  readonly title: string;
}

const NO_SETUPS: ReadonlyArray<TeamSetup> = [];

/**
 * The `bot.onboarding.read` line that names a team's main bot still to be set
 * up (`setup`): a `1.0` host answers none for every team, which says nothing.
 */
const BOT_ONBOARDING_SETUP_VERSION = { major: 1, minor: 1 } as const;

/**
 * The teams among `groups` whose main bot is still to be set up, read through
 * `client` on `hostId` (`bot.onboarding.read`, answered from the cloud, so
 * any host gives the same answer). Only a team with no live bot is read: a
 * team with one has its main bot, and one whose bots pre-date onboarding is
 * never set up. `settled` once the host's methods and every read are known;
 * `groups` is `null` while the lists that build them have not answered.
 *
 * `unresolved` when a team with no live bot cannot be told apart yet: its
 * read failed, or the host does not answer `setup` (no method, or a line
 * before it). Such a team sets up nothing, and a channel opened on its main
 * bot is neither shown nor taken for a deleted bot until `retry` reads it.
 * `readAt` is when the newest read answered (0 before any): a team's setup
 * gone in it means the team has a bot, which a list read before it may not
 * carry yet.
 */
export function useTeamSetups(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly groups: ReadonlyArray<HomeBotsGroup> | null;
}): {
  readonly settled: boolean;
  readonly setups: ReadonlyArray<TeamSetup>;
  readonly unresolved: boolean;
  readonly retry: () => void;
  readonly readAt: number;
} {
  const support = useHostMethodSupport(input.hostId, "bot.onboarding.read");
  const version = useHostMethodSchemaVersion(
    input.hostId,
    "bot.onboarding.read",
  );
  const answersSetup =
    support === true &&
    version !== null &&
    version.major === BOT_ONBOARDING_SETUP_VERSION.major &&
    version.minor >= BOT_ONBOARDING_SETUP_VERSION.minor;
  const teams = useMemo(
    () =>
      (input.groups ?? []).filter(
        (group) =>
          group.canCreate &&
          group.ownerKind === "organization" &&
          group.bots.length === 0,
      ),
    [input.groups],
  );
  const reads = useHostQueries<HostRpcRegistry, "bot.onboarding.read">({
    client: input.client,
    requests: teams.map((team) => ({
      method: "bot.onboarding.read",
      params: { environmentId: team.environmentId },
    })),
    cacheKeyIdentity: undefined,
    options: { enabled: answersSetup, refetchOnWindowFocus: true },
  });
  const settled =
    input.groups !== null &&
    support !== null &&
    (!answersSetup || reads.every((read) => read.status !== "pending"));
  const unresolved =
    settled &&
    teams.length > 0 &&
    (!answersSetup || reads.some((read) => read.status === "error"));
  const setups = teams.flatMap((team, index): TeamSetup[] => {
    const setup = reads[index]?.data?.setup ?? null;
    if (setup === null) return [];
    return [
      {
        environmentId: team.environmentId,
        teamName: team.label,
        botId: setup.botId,
        title: setup.title,
      },
    ];
  });
  const retry = (): void => {
    for (const read of reads) {
      if (read.status === "error") void read.refetch();
    }
  };
  return {
    settled,
    setups: setups.length === 0 ? NO_SETUPS : setups,
    unresolved,
    retry,
    readAt: Math.max(0, ...reads.map((read) => read.dataUpdatedAt)),
  };
}
