import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import {
  readMcpPromoteIntent,
  recordMcpPromoteIntent,
  type McpPromoteIntentState,
} from "@traycer-clients/shared/environment/mcp-promote-intent";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import {
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import type {
  HostRpcError,
  RequiredHostMethodVersion,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  NativePromoteToPersonalMutationV15,
  ProviderNativeScope,
} from "@traycer/protocol/host/provider-native-schemas";
import type {
  ProviderId,
  ProvidersNativeMutateRequestV15,
} from "@traycer/protocol/host/provider-schemas";
import { negotiatedVersionMeetsRequirement } from "@traycer/protocol/host-transport/remote/rpc-types";
import {
  addToConfigurationFailure,
  promoteRefusalText,
} from "@/components/settings/environment/mcp-skills-copy";
import { invalidateConfigurationReads } from "@/hooks/environment/environment-host-list-key";
import { useEnvironmentCloud } from "@/hooks/environment/use-environment-cloud";
import { useExecutableWriteGrant } from "@/hooks/environment/use-executable-write-grant";
import { withHostMutationLifecycleBoundary } from "@/hooks/host/use-host-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { toastFromHostError } from "@/lib/host-error-toast";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";

const METHOD = "providers.nativeMutate";

/**
 * The floor at which the host takes the app's `mcp_promote` intent on the
 * promote arm. Below it the arm drops `intentOperationId`, so no intent is
 * recorded and the call is today's.
 */
const PROMOTE_INTENT_REQUIRED_HOST_VERSION: RequiredHostMethodVersion = {
  method: METHOD,
  version: { major: 1, minor: 5 },
};

/** The entry to add, as its row names it. */
export interface PromoteToEnvironmentVariables {
  readonly providerId: ProviderId;
  readonly entryKind: "mcp" | "skills";
  readonly scope: ProviderNativeScope;
  readonly workspaceRoot: string | null;
  readonly name: string;
  /** The environment the caller is editing; null writes wherever this host writes. */
  readonly expectedEnvironmentId: string | null;
}

/**
 * The click's answer: added, or the words of why not, shown beside the
 * button. `refreshLists` reads the lists again for an upload that may still
 * land, so it shows without a second press.
 */
export type PromoteToEnvironmentOutcome =
  | { readonly kind: "added" }
  | {
      readonly kind: "refused";
      readonly text: string;
      readonly refreshLists: boolean;
    };

interface PromoteContext {
  readonly hostId: string | null;
}

/** The intent the click recorded, to read back once the computer answers. */
interface RecordedIntent {
  readonly environmentId: string;
  readonly operationId: string;
  /** The click's sign-in, which the read back goes on too. */
  readonly operation: EnvironmentCloud;
}

/**
 * "Add to <environment>" on an MCP server or skill this host has and the
 * environment it serves does not (`providers.nativeMutate`'s
 * `promoteToPersonal`): the entry is uploaded so every computer of that
 * environment gets it. Never sent without the click.
 *
 * For an MCP server, on a host that takes it, the click first records an
 * `mcp_promote` intent on the person's sign-in for this computer at its
 * sharing generation and the server's name; the computer uploads on its own
 * token against it, and the intent is read back. The click is one operation
 * on the sign-in current when it was pressed: both authn calls go on it, and
 * the upload is not asked for once that sign-in is gone. A skill is promoted
 * as today, with no intent.
 *
 * A refusal is an answer, not a transport error: it comes back as
 * `refused` with its words, and only a failed send toasts.
 */
export function useProvidersPromoteToPersonal(
  environmentName: string,
): UseMutationResult<
  PromoteToEnvironmentOutcome,
  HostRpcError,
  PromoteToEnvironmentVariables,
  PromoteContext
> {
  const client = useHostClient();
  const cloud = useEnvironmentCloud();
  const grant = useExecutableWriteGrant();
  const queries = useQueryClient();
  return useMutation<
    PromoteToEnvironmentOutcome,
    HostRpcError,
    PromoteToEnvironmentVariables,
    PromoteContext
  >(
    withHostMutationLifecycleBoundary(METHOD, {
      mutationKey: providersMutationKeys.promoteToPersonal(),
      mutationFn: (variables) =>
        withHostQueryErrorBoundary(METHOD, async () => {
          let intent: RecordedIntent | null = null;
          if (variables.entryKind === "mcp" && takesIntent(client)) {
            if (cloud === null) return intentOutcome(null, environmentName);
            const operation = cloud();
            const operationId = crypto.randomUUID();
            const recorded = await recordIntent(
              client,
              operation,
              operationId,
              variables.name,
            );
            if (recorded === null || !operation.onOriginSignIn())
              return intentOutcome(null, environmentName);
            intent = { environmentId: recorded, operationId, operation };
          }
          const promote: NativePromoteToPersonalMutationV15 = {
            kind: "promoteToPersonal",
            entryKind: variables.entryKind,
            scope: variables.scope,
            workspaceRoot: variables.workspaceRoot,
            name: variables.name,
            intentOperationId: intent?.operationId ?? null,
          };
          const request: ProvidersNativeMutateRequestV15 = await grant(
            {
              providerId: variables.providerId,
              mutation: promote,
              executableWriteGrant: null,
              expectedEnvironmentId: variables.expectedEnvironmentId,
            },
            client,
          );
          const { result } = await client.request(METHOD, request);
          if (!result.ok) {
            return {
              kind: "refused",
              text: promoteRefusalText(
                result.code,
                result.detail,
                environmentName,
              ),
              refreshLists: false,
            };
          }
          if (intent === null) return { kind: "added" };
          return intentOutcome(await readIntentState(intent), environmentName);
        }),
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      onSuccess: (outcome, variables, context) => {
        if (outcome.kind === "refused" && !outcome.refreshLists) return;
        // The entry joins the configuration, so the MCP servers and Skills
        // pages' lists move too, on every host that read them.
        if (variables.expectedEnvironmentId !== null) {
          invalidateConfigurationReads(
            queries,
            variables.expectedEnvironmentId,
            [
              "environment.configuration.mcpServers.list",
              "environment.configuration.items",
              "environment.configuration.skills.list",
            ],
          );
        }
        if (context.hostId === null) return;
        // The native lists (the row's mark) and the host's status (where the
        // item now applies) both change, on the host the click was sent on.
        for (const method of [
          "providers.list",
          "environment.status",
        ] as const) {
          void queries.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(
              hostRpcServingTierHostId(
                method,
                context.hostId,
                readProcessHostRpcTierPlan(),
                null,
              ),
              method,
            ),
          });
        }
      },
      onError: (error) => {
        toastFromHostError(error, addToConfigurationFailure(environmentName));
      },
    }),
  );
}

/** Whether the host the request goes to takes the intent on the promote arm. */
function takesIntent(client: HostRequester<HostRpcRegistry>): boolean {
  const hostId = client.getActiveHostId();
  if (hostId === null) return false;
  const version = readNegotiatedMethodVersion(hostId, METHOD);
  return (
    version !== null &&
    version !== false &&
    negotiatedVersionMeetsRequirement(
      version,
      PROMOTE_INTENT_REQUIRED_HOST_VERSION,
    )
  );
}

/**
 * Records the intent in the environment this computer serves, for this
 * computer at its sharing generation. Answers that environment's id, or null
 * when the computer cannot name its generation or authn did not hold the
 * intent.
 */
async function recordIntent(
  client: HostRequester<HostRpcRegistry>,
  operation: EnvironmentCloud,
  operationId: string,
  serverName: string,
): Promise<string | null> {
  const binding = await client.request("environment.host.read", {});
  if (binding.sharingGeneration === null) return null;
  const environmentId = binding.environment.environmentId;
  try {
    await recordMcpPromoteIntent(operation, environmentId, {
      operationId,
      sourceHostId: binding.hostId,
      sourceSharingGeneration: binding.sharingGeneration,
      serverName,
    });
  } catch {
    return null;
  }
  return environmentId;
}

/** The intent's state, or null when it could not be read. */
async function readIntentState(
  intent: RecordedIntent,
): Promise<McpPromoteIntentState | null> {
  try {
    return await readMcpPromoteIntent(
      intent.operation,
      intent.environmentId,
      intent.operationId,
    );
  } catch {
    return null;
  }
}

/**
 * What the person is shown for the intent, null when it could not be
 * recorded or read: added once the computer's upload was accepted against
 * it, and the failure line otherwise. A pending intent may still be used
 * a moment later, so its lists are read again.
 */
function intentOutcome(
  state: McpPromoteIntentState | null,
  environmentName: string,
): PromoteToEnvironmentOutcome {
  if (state?.state === "consumed") return { kind: "added" };
  return {
    kind: "refused",
    text: addToConfigurationFailure(environmentName),
    refreshLists: state?.state === "pending",
  };
}
