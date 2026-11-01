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
  CHECKING_SANDBOX_AGENTS,
  CHOOSE_ANOTHER_HOST,
  notEnoughCreditsLine,
  teamAllowanceShortLine,
} from "@/lib/sandboxes/sandbox-strings";
import type { ComposerHostNoticeState } from "@/components/home/composer/composer-host-notice";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import { useSandboxTraycerModels } from "@/hooks/sandboxes/use-sandbox-traycer-models-query";
import {
  sandboxAgentNotOfferedNotice,
  sandboxAgentsUncheckedNotice,
  sandboxModelNotOfferedNotice,
  type SandboxAgentRemedies,
} from "@/lib/sandboxes/sandbox-agent-refusal";
import { modelCoveredByCatalog } from "@/stores/composer/composer-toolbar-store";
import type { StagedSandbox } from "@/stores/composer/staged-sandbox-store";

export interface StagedSendSignInCheck {
  /** Advisory render-time copy; Send always verifies the balance afresh. */
  readonly check: (stage: StagedSandbox) => ComposerHostNoticeState | null;
  readonly beforeSend: (
    stage: StagedSandbox,
  ) => Promise<ComposerHostNoticeState | null>;
}

const CHECKING_NOTICE: ComposerHostNoticeState = {
  kind: "mirror",
  pending: true,
  message: CHECKING_SANDBOX_AGENTS,
  action: null,
};

/** One agent/credit gate for render-time advice and fresh Send-time decisions. */
export function useStagedSendSignInCheck(
  input: {
    readonly harnessId: GuiHarnessId | null;
    /** The model the send carries, and its name on the chip. */
    readonly modelSlug: string;
    readonly modelName: string;
    readonly active: boolean;
  } & SandboxAgentRemedies,
): StagedSendSignInCheck {
  const {
    harnessId,
    modelSlug,
    modelName,
    active,
    onChooseModel,
    onOpenTerminalInstead,
    onChooseAnotherHost,
  } = input;
  const catalogue = useSandboxCatalogue(active);
  const checksModel = active && harnessId === "traycer" && modelSlug.length > 0;
  const traycerModels = useSandboxTraycerModels(checksModel);
  const models = traycerModels.data;
  // A read paused offline has not answered yet, so Send waits for it. One that
  // nothing will run, such as an unverified session's, is no read at all, and
  // passes as a failed one does.
  const modelsPending =
    traycerModels.isPending && traycerModels.fetchStatus !== "idle";
  const authUser = useAuthUser();
  const runnerHost = useRunnerHost();
  const openLink = useOpenLink();
  const offeredAgents = catalogue.data?.offeredAgents;
  const pending = catalogue.data === undefined && catalogue.isFetching;
  // A read that ended with no catalogue is not permission: creating or waking
  // for an agent nobody checked is the cost this gate exists to prevent.
  const unread = catalogue.data === undefined && !catalogue.isFetching;
  const refetchCatalogue = catalogue.refetch;
  // A Traycer model the sandbox's own list leaves out, once that list answers.
  const modelNotice = useCallback(
    (remedies: SandboxAgentRemedies): ComposerHostNoticeState | null => {
      if (modelsPending) return CHECKING_NOTICE;
      if (
        models === undefined ||
        modelCoveredByCatalog(models, "traycer", modelSlug)
      )
        return null;
      return sandboxModelNotOfferedNotice(
        modelName,
        offeredAgents ?? null,
        remedies,
      );
    },
    [modelName, modelSlug, models, modelsPending, offeredAgents],
  );
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
      if (pending) return CHECKING_NOTICE;
      if (unread)
        return sandboxAgentsUncheckedNotice(() => {
          void refetchCatalogue();
        });
      const remedies = {
        onChooseModel,
        onOpenTerminalInstead,
        onChooseAnotherHost,
      };
      if (offeredAgents !== undefined && !offeredAgents.includes(harnessId))
        return sandboxAgentNotOfferedNotice(harnessId, offeredAgents, remedies);
      return checksModel ? modelNotice(remedies) : null;
    },
    [
      active,
      catalogue.data,
      runnerHost.signInUrl,
      openLink,
      harnessId,
      pending,
      unread,
      refetchCatalogue,
      offeredAgents,
      checksModel,
      modelNotice,
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
