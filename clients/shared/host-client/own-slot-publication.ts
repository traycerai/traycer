import type {
  EnvironmentOwnSlotChangeResponse,
  EnvironmentOwnSlotPublishRequest,
} from "@traycer/protocol/host/environment-schemas";
import type { HostRpcRegistry } from "@traycer/protocol/host/registry";
import { putConfigurationItem } from "../environment/configuration-settings";
import type { EnvironmentCloud } from "../environment/environment-cloud";
import type { HostRequester } from "./host-client";

export type OwnSlotPublishBegin = Extract<
  EnvironmentOwnSlotPublishRequest,
  { phase: "begin" }
>;

export async function publishOwnSlot(
  host: HostRequester<HostRpcRegistry>,
  hostId: string,
  request: OwnSlotPublishBegin,
  cloud: EnvironmentCloud,
): Promise<EnvironmentOwnSlotChangeResponse> {
  const context = host.getRequestContext();
  const current = (): boolean =>
    context !== null &&
    context.cloudAuthorized &&
    !context.abortSignal.aborted &&
    host.getRequestContext() === context &&
    host.getActiveHostId() === hostId &&
    cloud.onOriginSignIn();

  if (!current()) return { outcome: "forbidden" };
  try {
    const begin = await host.request("environment.ownSlots.publish", request);
    if (!current()) return { outcome: "conflict" };
    if (begin.outcome !== "ready") return begin;
    if (begin.write.environmentId !== request.environmentId)
      return { outcome: "conflict" };

    const committed: { status: number | null } = { status: null };
    const watched: EnvironmentCloud = {
      ...cloud,
      onOriginSignIn: current,
      transport: async (operation) => {
        const answer = await cloud.transport(operation);
        if (operation.method === "PUT") committed.status = answer.status;
        return answer;
      },
    };
    const saved = await putConfigurationItem(watched, {
      kind: request.kind,
      ...begin.write,
    });
    if (saved.outcome === "forbidden") return { outcome: "forbidden" };
    if (
      !current() ||
      committed.status !== 200 ||
      saved.outcome !== "saved" ||
      saved.revision === null
    )
      return { outcome: "conflict" };

    const settled = await host.request("environment.ownSlots.publish", {
      ...request,
      phase: "settle",
      changeToken: begin.changeToken,
      revision: saved.revision,
    });
    return current() && settled.outcome !== "ready"
      ? settled
      : { outcome: "conflict" };
  } catch {
    return { outcome: "conflict" };
  }
}
