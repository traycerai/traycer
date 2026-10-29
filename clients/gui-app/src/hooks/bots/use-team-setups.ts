import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { HomeBotsGroup } from "@/lib/home-bots/bots-model";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";

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
 * The teams among `groups` whose main bot is still to be set up, read through
 * `client` on `hostId` (`bot.onboarding.read`, answered from the cloud, so
 * any host gives the same answer). Only a team with no live bot is read: a
 * team with one has its main bot, and one whose bots pre-date onboarding is
 * never set up. `settled` once the host's methods and every read are known;
 * a read that fails, and a host without the method, set up nothing. `groups`
 * is `null` while the lists that build them have not answered.
 */
export function useTeamSetups(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly groups: ReadonlyArray<HomeBotsGroup> | null;
}): { readonly settled: boolean; readonly setups: ReadonlyArray<TeamSetup> } {
  const support = useHostMethodSupport(input.hostId, "bot.onboarding.read");
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
    options: { enabled: support === true, refetchOnWindowFocus: true },
  });
  const settled =
    input.groups !== null &&
    support !== null &&
    (!support || reads.every((read) => read.status !== "pending"));
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
  return { settled, setups: setups.length === 0 ? NO_SETUPS : setups };
}
