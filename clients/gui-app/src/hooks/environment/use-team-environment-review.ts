import {
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import {
  EnvironmentCloudError,
  NEEDS_CONNECTION_MESSAGE,
} from "@traycer-clients/shared/environment/environment-cloud";
import {
  applyReviewChoice,
  readProjectedReviewHolds,
  type ReviewChoiceOutcome,
  type ReviewHeldEntry,
} from "@traycer-clients/shared/environment/environment-review";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  projectTeamReview,
  type TeamReviewEntry,
} from "@/components/settings/move/team-review-values";
import type { HeldApplyChoice } from "@/components/settings/move/retrospective-copy";
import {
  invalidateConfigurationReads,
  REVISION_MOVED_READS,
} from "@/hooks/environment/environment-host-list-key";
import {
  useEnvironmentCloud,
  useEnvironmentCloudOwnRead,
} from "@/hooks/environment/use-environment-cloud";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { usePressCapturedMutation } from "@/hooks/use-press-captured-mutation";
import { environmentCloudHostError } from "@/lib/environment/environment-cloud-calls";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { environmentMutationKeys } from "@/lib/query-keys/environment-mutation-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useHostBinding } from "@/lib/host/runtime";

const READ_METHOD = "environment.review";
const APPLY_METHOD = "environment.review.applyChoice";

/** Shared room content has no proposal or review workflow (T13 ruling 1). */
function included(entry: TeamReviewEntry): boolean {
  return (
    entry.entry.kind !== "skill" && entry.entry.kind !== "agent_selection_guide"
  );
}

export function useTeamEnvironmentReviewRead(
  environmentId: string | null,
  enabled: boolean,
): UseQueryResult<readonly TeamReviewEntry[], HostRpcError> {
  const auth = useHostBinding()?.auth ?? null;
  const metadata = useAuthStore((state) => state.contextMetadata);
  const identityGeneration =
    metadata === null ? null : (auth?.getIdentityGeneration() ?? null);
  return useEnvironmentCloudOwnRead({
    method: READ_METHOD,
    params: { environmentId: environmentId ?? "", identityGeneration },
    enabled: enabled && environmentId !== null,
    staleTime: 0,
    read: async (cloud) => {
      const entries = await readProjectedReviewHolds(
        cloud,
        environmentId ?? "",
        projectTeamReview,
      );
      if (!cloud.onOriginSignIn()) {
        throw new EnvironmentCloudError(
          "no_response",
          NEEDS_CONNECTION_MESSAGE.settings,
        );
      }
      return entries.filter(included);
    },
  });
}

export interface TeamReviewChoice {
  readonly heldId: string;
  readonly choice: HeldApplyChoice;
}

export type TeamReviewMutation = UseMutationResult<
  ReviewChoiceOutcome,
  HostRpcError,
  TeamReviewChoice
>;

interface TeamReviewPress {
  readonly cloud: EnvironmentCloud;
  readonly environmentId: string;
  readonly choice: HeldApplyChoice;
  readonly entry: Pick<
    ReviewHeldEntry,
    "entryId" | "heldRevision" | "liveRevision"
  > | null;
  readonly allowed: boolean;
}

export function useTeamEnvironmentReviewApply(
  environmentId: string,
  viewerId: string,
  canEdit: boolean,
  entries: readonly TeamReviewEntry[],
): TeamReviewMutation {
  const queries = useQueryClient();
  const source = useEnvironmentCloud();
  const auth = useHostBinding()?.auth ?? null;
  const metadata = useAuthStore((state) => state.contextMetadata);
  const identityGeneration =
    metadata === null ? null : (auth?.getIdentityGeneration() ?? null);
  return usePressCapturedMutation<
    ReviewChoiceOutcome,
    HostRpcError,
    TeamReviewChoice,
    TeamReviewPress
  >(
    ({ heldId, choice }) => {
      cloudVerdictPreflight(APPLY_METHOD)();
      if (
        source === null ||
        useAuthStore.getState().contextMetadata?.userId !== viewerId ||
        auth?.getIdentityGeneration() !== identityGeneration
      ) {
        throw hostClientUnavailableError(APPLY_METHOD);
      }
      const cloud = source();
      const row = entries.find(
        (candidate) => candidate.entry.entryId === heldId,
      );
      const entry =
        row === undefined
          ? null
          : {
              entryId: row.entry.entryId,
              heldRevision: row.entry.heldRevision,
              liveRevision: row.entry.liveRevision,
            };
      return {
        cloud,
        environmentId,
        choice,
        entry,
        allowed:
          canEdit &&
          row?.proposed?.kind !== "unreadable" &&
          row?.current?.kind !== "unreadable",
      };
    },
    {
      mutationKey: environmentMutationKeys.teamReviewApplyChoice(
        environmentId,
        viewerId,
      ),
      mutationFn: (_variables, press) =>
        withHostQueryErrorBoundary(
          APPLY_METHOD,
          async (): Promise<ReviewChoiceOutcome> => {
            if (press.entry === null) return { outcome: "gone" };
            if (!press.allowed) return { outcome: "forbidden" };
            try {
              return await applyReviewChoice(
                press.cloud,
                press.environmentId,
                press.entry,
                press.choice,
              );
            } catch (error) {
              throw environmentCloudHostError(APPLY_METHOD, error);
            } finally {
              if (press.cloud.onOriginSignIn()) {
                invalidateConfigurationReads(
                  queries,
                  press.environmentId,
                  REVISION_MOVED_READS,
                );
              }
            }
          },
        ),
    },
  );
}
