import { useMemo } from "react";
import type { BotOnboardingArrival } from "@traycer/protocol/host/bot/onboarding-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";

/**
 * How a team's main bot came to run, kept at the top of its channel once it
 * is live (Tracy Bots T67b): the setup the channel showed before the team had
 * a host, and how the host came.
 */
export interface TeamSetupHistory {
  readonly arrival: BotOnboardingArrival;
}

/**
 * The setup history of `botId`'s channel when the bot is its team's main bot
 * and its setup is live (`bot.onboarding.read`, answered from the cloud, so
 * any host gives the same answer; the read `useTeamSetups` makes for the same
 * team); `null` for any other bot, a team whose bots pre-date onboarding, a
 * host that does not answer the read, and while the read has not answered or
 * failed - the channel then shows no history. `team` is whether the bot is
 * its team environment's main bot: no other is read.
 */
export function useTeamSetupHistory(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly botId: string;
  readonly environmentId: string;
  readonly team: boolean;
}): TeamSetupHistory | null {
  const { botId, environmentId } = input;
  const supported =
    useHostMethodSupport(input.hostId, "bot.onboarding.read") === true;
  const [read] = useHostQueries<HostRpcRegistry, "bot.onboarding.read">({
    client: input.client,
    requests: [{ method: "bot.onboarding.read", params: { environmentId } }],
    cacheKeyIdentity: undefined,
    options: { enabled: supported && input.team, refetchOnWindowFocus: true },
  });
  const setup = read.data?.setup ?? null;
  return useMemo(
    () =>
      setup !== null &&
      setup.state === "live" &&
      setup.botId === botId &&
      setup.arrival !== null
        ? { arrival: setup.arrival }
        : null,
    [botId, setup],
  );
}
