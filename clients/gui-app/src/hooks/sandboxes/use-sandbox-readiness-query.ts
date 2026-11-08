import { useQuery } from "@tanstack/react-query";
import type { SandboxCatalogueReadinessRequest } from "@traycer/protocol/host/sandbox-control";
import { useHostBinding } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { sandboxCatalogueQueryOptions } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import { useTeamEnvironment } from "@/hooks/sandboxes/use-team-environment-query";
import { useSandboxControlUnavailableReason } from "@/hooks/sandboxes/use-sandbox-control-unavailable-reason";
import { sandboxReadinessLine } from "@/lib/sandboxes/sandbox-readiness";
import type {
  StageConfiguration,
  StageSize,
} from "@/lib/sandboxes/sandbox-stage-model";

/** Each opened create surface and changed selection reads inventory afresh, without polling. */
export function useSandboxReadiness(
  configuration: StageConfiguration | null,
  shape: StageSize | null,
): string | null {
  const binding = useHostBinding();
  const auth = binding?.auth ?? null;
  const signedIn = useAuthStore((state) => state.status === "signed-in");
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const unavailable = useSandboxControlUnavailableReason() !== null;
  const team = useTeamEnvironment(
    configuration?.kind === "team" ? configuration.teamId : null,
  );
  let environmentId: string | null | undefined;
  if (configuration?.kind === "personal") environmentId = null;
  else if (team.data?.kind === "ok") environmentId = team.data.environmentId;
  const context: SandboxCatalogueReadinessRequest | null =
    shape === null || environmentId === undefined
      ? null
      : { environmentId, ...shape };
  const enabled = signedIn && context !== null && !unavailable;
  const query = useQuery(
    sandboxCatalogueQueryOptions(auth, userId, enabled, context),
  );
  if (!enabled || query.isFetching || !query.isSuccess) return null;
  return sandboxReadinessLine(query.data, shape);
}
