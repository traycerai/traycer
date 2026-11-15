import { useCallback, useMemo } from "react";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";
import { useTeamBillingAdminOf } from "@/hooks/sandboxes/use-team-billing-admin";
import {
  useReadTeamBundleBalance,
  useTeamBundleBalances,
} from "@/hooks/sandboxes/use-team-bundle-balances";
import { useOpenLink } from "@/lib/links/open-link";
import { useRunnerHost } from "@/providers/use-runner-host";
import { sandboxAddCreditsUrl } from "@/lib/sandboxes/sandbox-row-lines";
import {
  stageBalanceMc,
  stageNeedsCredits,
  stagePrice,
  type StageConfiguration,
  type TeamBalanceMc,
} from "@/lib/sandboxes/sandbox-stage-model";
import {
  ADD_CREDITS_LINK,
  CHECKING_SANDBOX_AGENTS,
  notEnoughCreditsLine,
  teamCreditsShortLine,
} from "@/lib/sandboxes/sandbox-strings";
import type {
  ComposerHostNoticeAction,
  ComposerHostNoticeState,
} from "@/components/home/composer/composer-host-notice";
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

const NO_TEAMS: readonly string[] = [];

/** No team balance known: a check that reads none. */
const NO_TEAM_BALANCE: TeamBalanceMc = () => null;

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
    readonly chooseAnotherHostLabel: string;
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
    chooseAnotherHostLabel,
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
  const teamIds = useMemo(
    () =>
      authUser.data?.teamSubscriptions.map((entry) => entry.team.id) ??
      NO_TEAMS,
    [authUser.data],
  );
  const isTeamAdmin = useTeamBillingAdminOf(teamIds);
  const teamBalanceMc = useTeamBundleBalances();
  const readTeamBalance = useReadTeamBundleBalance();
  const runnerHost = useRunnerHost();
  const openLink = useOpenLink();
  // A team's credits are offered to its Admin only: anyone else reads the
  // same notice with no action.
  const addCreditsAction = useCallback(
    (configuration: StageConfiguration): ComposerHostNoticeAction | null => {
      if (configuration.kind === "team" && !isTeamAdmin(configuration.teamId))
        return null;
      const url = sandboxAddCreditsUrl(
        runnerHost.signInUrl,
        configuration.kind === "team"
          ? { ...configuration, environmentId: null }
          : configuration,
      );
      return {
        label: ADD_CREDITS_LINK,
        onAction: () => void openLink(url, "account", null),
      };
    },
    [isTeamAdmin, openLink, runnerHost.signInUrl],
  );
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
      teamBalance: TeamBalanceMc,
    ): ComposerHostNoticeState | null => {
      if (
        active &&
        stage.target.kind === "new" &&
        catalogue.data !== undefined
      ) {
        const { configuration, shape } = stage.target;
        const price = stagePrice(catalogue.data, shape);
        const balance = stageBalanceMc(user, configuration, teamBalance);
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
                ? teamCreditsShortLine(configuration.teamName, shortfall)
                : notEnoughCreditsLine(shortfall),
            action: addCreditsAction(configuration),
            secondaryActions:
              onChooseAnotherHost === undefined
                ? []
                : [
                    {
                      label: chooseAnotherHostLabel,
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
        chooseAnotherHostLabel,
      };
      if (offeredAgents !== undefined && !offeredAgents.includes(harnessId))
        return sandboxAgentNotOfferedNotice(harnessId, offeredAgents, remedies);
      return checksModel ? modelNotice(remedies) : null;
    },
    [
      active,
      catalogue.data,
      addCreditsAction,
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
      chooseAnotherHostLabel,
    ],
  );
  const check = useCallback(
    (stage: StagedSandbox) =>
      checkWithUser(stage, authUser.data ?? null, teamBalanceMc),
    [checkWithUser, authUser.data, teamBalanceMc],
  );
  const refetch = authUser.refetch;
  const beforeSend = useCallback(
    async (stage: StagedSandbox): Promise<ComposerHostNoticeState | null> => {
      if (!active || stage.target.kind !== "new") {
        return checkWithUser(stage, null, NO_TEAM_BALANCE);
      }
      // Cached balances are advice; a failed read leaves the spend gate authoritative.
      const { configuration } = stage.target;
      const [fresh, freshTeam] = await Promise.all([
        refetch({ cancelRefetch: true }).catch(() => null),
        configuration.kind === "team"
          ? readTeamBalance(configuration.teamId)
          : Promise.resolve(null),
      ]);
      return checkWithUser(
        stage,
        fresh === null || fresh.isError ? null : (fresh.data ?? null),
        () => freshTeam,
      );
    },
    [active, checkWithUser, readTeamBalance, refetch],
  );
  return useMemo(() => ({ check, beforeSend }), [check, beforeSend]);
}
