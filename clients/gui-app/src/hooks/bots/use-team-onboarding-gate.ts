import type { UseQueryResult } from "@tanstack/react-query";
import type { BotOnboardingReadResponse } from "@traycer/protocol/host/bot/onboarding-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useBotOnboardingQuery } from "@/hooks/bots/use-bot-onboarding-query";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import {
  teamOnboardingGate,
  type TeamOnboardingGate,
} from "@/lib/home-bots/team-onboarding-gate";

/**
 * A team environment's onboarding gate (`teamOnboardingGate`), read through
 * `client` on `hostId`: the card, "Add a bot" and the channel rows of one
 * environment all ask here, so they share one read and one answer. A
 * personal environment reads nothing.
 */
export function useTeamOnboardingGate(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly environmentId: string;
  readonly isTeam: boolean;
  readonly botCount: number;
}): {
  readonly gate: TeamOnboardingGate;
  readonly onboarding: UseQueryResult<BotOnboardingReadResponse, HostRpcError>;
} {
  const supported = useHostSupportsMethod(input.hostId, "bot.onboarding.read");
  const onboarding = useBotOnboardingQuery(
    input.client,
    input.environmentId,
    supported && input.isTeam,
  );
  return {
    gate: teamOnboardingGate({
      isTeam: input.isTeam,
      supported,
      read: { status: onboarding.status, data: onboarding.data },
      botCount: input.botCount,
    }),
    onboarding,
  };
}
