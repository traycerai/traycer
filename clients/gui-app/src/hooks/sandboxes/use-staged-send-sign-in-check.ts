import { useCallback, useMemo } from "react";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { useOpenLink } from "@/lib/links/open-link";
import { useRunnerHost } from "@/providers/use-runner-host";
import { sandboxAddCreditsUrl } from "@/lib/sandboxes/sandbox-row-lines";
import {
  stageBalanceMc,
  stageNeedsCredits,
  stagePrice,
} from "@/lib/sandboxes/sandbox-stage-model";
import {
  ADD_CREDITS_LINK,
  CHOOSE_ANOTHER_HOST,
  notEnoughCreditsLine,
  teamAllowanceShortLine,
} from "@/lib/sandboxes/sandbox-strings";
import type { ComposerHostNoticeState } from "@/components/home/composer/composer-host-notice";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import {
  sandboxAgentNotOfferedNotice,
  type SandboxAgentRemedies,
} from "@/lib/sandboxes/sandbox-agent-refusal";
import type { StagedSandbox } from "@/stores/composer/staged-sandbox-store";

export interface StagedSendSignInCheck {
  /** Advisory render-time copy; Send always verifies the balance afresh. */
  readonly check: (stage: StagedSandbox) => ComposerHostNoticeState | null;
  readonly beforeSend: (
    stage: StagedSandbox,
  ) => Promise<ComposerHostNoticeState | null>;
}

/** One agent/credit gate for render-time advice and fresh Send-time decisions. */
export function useStagedSendSignInCheck(
  input: {
    readonly harnessId: GuiHarnessId | null;
    readonly active: boolean;
  } & SandboxAgentRemedies,
): StagedSendSignInCheck {
  const {
    harnessId,
    active,
    onChooseModel,
    onOpenTerminalInstead,
    onChooseAnotherHost,
  } = input;
  const catalogue = useSandboxCatalogue(active);
  const authUser = useAuthUser();
  const runnerHost = useRunnerHost();
  const openLink = useOpenLink();
  const offeredAgents = catalogue.data?.offeredAgents;
  const pending = catalogue.data === undefined && catalogue.isFetching;
  const checkWithUser = useCallback(
    (
      stage: StagedSandbox,
      user: AuthenticatedUser | null,
    ): ComposerHostNoticeState | null => {
      if (
        active &&
        stage.target.kind === "new" &&
        catalogue.data !== undefined
      ) {
        const { configuration, shape } = stage.target;
        const price = stagePrice(catalogue.data, shape);
        const balance = stageBalanceMc(user, configuration);
        if (
          stageNeedsCredits(balance, price) &&
          price !== null &&
          balance !== null
        ) {
          const shortfall = Math.max(1, price.awakeMcPerHour - balance);
          return {
            kind: "refused",
            message:
              configuration.kind === "team"
                ? teamAllowanceShortLine(configuration.teamName, shortfall)
                : notEnoughCreditsLine(shortfall),
            action: {
              label: ADD_CREDITS_LINK,
              onAction: () =>
                void openLink(
                  sandboxAddCreditsUrl(
                    runnerHost.signInUrl,
                    configuration.kind === "team"
                      ? { ...configuration, environmentId: null }
                      : configuration,
                  ),
                  "account",
                  null,
                ),
            },
            secondaryActions:
              onChooseAnotherHost === undefined
                ? []
                : [
                    {
                      label: CHOOSE_ANOTHER_HOST,
                      onAction: onChooseAnotherHost,
                    },
                  ],
          };
        }
      }
      if (!active || harnessId === null) return null;
      if (pending)
        return {
          kind: "mirror",
          pending: true,
          message: "Checking which agents run on sandboxes.",
          action: null,
        };
      if (offeredAgents === undefined || offeredAgents.includes(harnessId))
        return null;
      return sandboxAgentNotOfferedNotice(harnessId, {
        onChooseModel,
        onOpenTerminalInstead,
        onChooseAnotherHost,
      });
    },
    [
      active,
      catalogue.data,
      runnerHost.signInUrl,
      openLink,
      harnessId,
      pending,
      offeredAgents,
      onChooseModel,
      onOpenTerminalInstead,
      onChooseAnotherHost,
    ],
  );
  const check = useCallback(
    (stage: StagedSandbox) => checkWithUser(stage, authUser.data ?? null),
    [checkWithUser, authUser.data],
  );
  const refetch = authUser.refetch;
  const beforeSend = useCallback(
    async (stage: StagedSandbox): Promise<ComposerHostNoticeState | null> => {
      if (!active || stage.target.kind !== "new") {
        return checkWithUser(stage, null);
      }
      // Cached balances are advice; a failed read leaves the spend gate authoritative.
      const fresh = await refetch({ cancelRefetch: true }).catch(() => null);
      return checkWithUser(
        stage,
        fresh === null || fresh.isError ? null : (fresh.data ?? null),
      );
    },
    [active, checkWithUser, refetch],
  );
  return useMemo(() => ({ check, beforeSend }), [check, beforeSend]);
}
