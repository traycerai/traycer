import { z } from "zod";
import type { EnvironmentConfigurationItemsResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

const METHOD = "environment.configuration.items";

/** The item every reader and the Providers switch address. */
export const TRAYCER_INFERENCE_KIND = "traycer_inference";
export const TRAYCER_INFERENCE_KEY = "traycer";

/** The item's value as authn validates it (`items.ts`). */
const traycerInferenceValueSchema = z.strictObject({ enabled: z.boolean() });

/**
 * A configuration's Traycer Inference setting, which every host of the
 * configuration follows, sandboxes included:
 *  - `unknown`: the host this window reads through cannot say (a host or a
 *    cloud older than the setting); nothing may be refused on it.
 *  - `ready`: on or off, with the revision a save quotes (`null` when no
 *    item is written yet, which is off).
 */
export type TraycerInferenceRead =
  | { readonly kind: "pending" }
  | { readonly kind: "failed"; readonly retry: () => void }
  | { readonly kind: "unknown" }
  | {
      readonly kind: "ready";
      readonly enabled: boolean;
      readonly revision: number | null;
    };

type AnsweredRead = Extract<
  TraycerInferenceRead,
  { readonly kind: "unknown" | "ready" }
>;

function traycerInferenceOf(
  response: EnvironmentConfigurationItemsResponse,
): AnsweredRead {
  if (response.servedKinds?.includes(TRAYCER_INFERENCE_KIND) !== true) {
    return { kind: "unknown" };
  }
  const item = response.items.find(
    (row) =>
      row.kind === TRAYCER_INFERENCE_KIND && row.key === TRAYCER_INFERENCE_KEY,
  );
  if (item === undefined) {
    return { kind: "ready", enabled: false, revision: null };
  }
  const parsed = traycerInferenceValueSchema.safeParse(item.value);
  // A value authn would not have written reads as off: Traycer is opt-in.
  return {
    kind: "ready",
    enabled: parsed.success && parsed.data.enabled,
    revision: item.revision,
  };
}

/**
 * One environment's Traycer Inference setting, read from the cloud through
 * the window's own host on the viewer's session, so no host of that
 * configuration needs to exist or be awake. `null` reads nothing. A save
 * through `useConfigurationItemMutations` rereads it.
 */
export function useEnvironmentTraycerInference(
  environmentId: string | null,
): TraycerInferenceRead {
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const query = useHostQueryWithResponseMap<
    HostRpcRegistry,
    typeof METHOD,
    AnsweredRead
  >({
    cacheKeyIdentity: [viewerId, "traycer-inference"],
    client: useHostClient(),
    method: METHOD,
    params: { environmentId: environmentId ?? "" },
    preflight: cloudVerdictPreflight(METHOD),
    mapResponse: ({ response }) => traycerInferenceOf(response),
    options: {
      enabled: environmentId !== null && viewerId.length > 0 && authorized,
    },
  });
  if (query.status === "error") {
    return {
      kind: "failed",
      retry: () => {
        void query.refetch();
      },
    };
  }
  return query.data ?? { kind: "pending" };
}

/**
 * A configuration's Traycer Inference setting by `personal` or team id, for
 * a send to a sandbox of it, staged or bound. A configuration the account's
 * list answers without an environment has no setting, which is off.
 */
export function useConfigurationTraycerInference(
  configurationKey: string,
): TraycerInferenceRead {
  const list = useEnvironmentListQuery(useHostClient(), true);
  const environment =
    list.data?.environments.find((descriptor) =>
      descriptor.ownerKind === "user"
        ? configurationKey === "personal"
        : descriptor.ownerId === configurationKey,
    ) ?? null;
  const read = useEnvironmentTraycerInference(
    environment === null ? null : environment.environmentId,
  );
  if (list.status === "error") {
    return {
      kind: "failed",
      retry: () => {
        void list.refetch();
      },
    };
  }
  if (list.data === undefined) return { kind: "pending" };
  if (environment === null) {
    return { kind: "ready", enabled: false, revision: null };
  }
  return read;
}
