import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import { useCallback } from "react";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { usePreviewFeature } from "@/hooks/auth/use-preview-feature";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { usePersonalEnvironment } from "@/hooks/environment/use-addressed-environment";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { localPickerRow } from "@/components/settings/environment/environment-picker-model";
import {
  hostsRunningConfiguration,
  type FirsthandHost,
  type HostsRunningConfiguration,
} from "@/components/settings/environment/hosts-running-configuration-model";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { usePersonalComputers } from "@/components/settings/personal/use-personal-computers";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";

const PERSONAL_TARGET = { kind: "personal" } as const;

function firsthandHost(host: HostScopeOption): FirsthandHost {
  return {
    hostId: host.hostId,
    name: host.name,
    isLocalMachine: host.isLocalMachine,
    sandbox: host.sandbox !== null,
  };
}

/**
 * THE hosts running a configuration: its host list from the cloud
 * (`environment.host.list`, the binding records), read through the serving
 * tier on the viewer's session. Presence never decides membership: a
 * computer with remote access off reports only when its revision moves, so
 * the cloud calls it offline minutes later while it still runs the
 * configuration. For Personal, a host with a Local row is left out, by its
 * own status, by what it last reported, or because it never reported; this
 * computer is named only once its own status has answered; and a computer
 * that runs Personal by its own status is added when the list does not name
 * it (`hostsRunningConfiguration`).
 *
 * Every surface that names or counts these hosts reads this: the status
 * chip and its popover, Personal's dropdown row, Getting started, the move
 * sheet's reach line.
 */
export function useHostsRunningConfiguration(
  target:
    | { readonly kind: "personal" }
    | { readonly kind: "team"; readonly environmentId: string },
): HostsRunningConfiguration {
  const client = usePoolTierHostClient(useHostClient());
  // Without environments (unread included) no configuration runs anywhere:
  // nothing is read and the list stays empty.
  const environments = usePreviewFeature("environments") === "on";
  const personalTarget = target.kind === "personal" && environments;
  const personal = usePersonalEnvironment(client, personalTarget);
  const environmentId =
    target.kind === "team" ? target.environmentId : personal.environmentId;
  const viewerUserId = useCloudChatViewerId();
  const list = useHostQuery<HostRpcRegistry, "environment.host.list">({
    client,
    method: "environment.host.list",
    params: { environmentId: environmentId ?? "" },
    cacheKeyIdentity: [viewerUserId],
    options: {
      enabled:
        environments && environmentId !== null && viewerUserId.length > 0,
      poll: true,
    },
  });
  const scope = useHostScope();
  const computers = usePersonalComputers(personalTarget);
  const { refetch } = list;
  const retryPersonal = personal.retry;
  const retry = useCallback(() => {
    if (environmentId === null) {
      if (personalTarget) retryPersonal();
      return;
    }
    void refetch();
  }, [environmentId, personalTarget, retryPersonal, refetch]);
  const reread = useCallback(() => {
    if (environmentId === null) return;
    void refetch({ cancelRefetch: false });
  }, [environmentId, refetch]);
  const localHostIds = new Set(
    computers.computers
      .filter(
        (host) =>
          localPickerRow(
            host,
            computers.statuses.get(host.hostId) ?? null,
            computers.versions.get(host.hostId) ?? null,
          ) !== null,
      )
      .map((host) => host.hostId),
  );
  // This computer is named only once its own status has answered: until then
  // it may still hold a Local row.
  const unreadHostIds = new Set(
    computers.computers
      .filter(
        (host) =>
          host.isLocalMachine &&
          (computers.statuses.get(host.hostId) ?? null) === null,
      )
      .map((host) => host.hostId),
  );
  const model = hostsRunningConfiguration({
    rows: list.data?.hosts ?? [],
    personal: personalTarget,
    localHostIds,
    unreadHostIds,
    runningByStatus: computers.participants.map(firsthandHost),
    firsthand: scope.hosts.map(firsthandHost),
  });
  let state: HostsRunningConfiguration["state"] = "loading";
  if (list.data !== undefined) state = "ready";
  else if (
    list.isError ||
    (personalTarget && personal.resolved && environmentId === null)
  )
    state = "failed";
  return {
    hosts: model.hosts,
    collisions: model.collisions,
    state,
    retry,
    reread,
  };
}

/**
 * The computers and sandboxes running Personal
 * ({@link useHostsRunningConfiguration}).
 */
export function useHostsRunningPersonal(): HostsRunningConfiguration {
  return useHostsRunningConfiguration(PERSONAL_TARGET);
}
