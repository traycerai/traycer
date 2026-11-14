import { useCallback } from "react";
import { usePersonalEnvironment } from "@/hooks/environment/use-addressed-environment";
import { useEnvironmentCloudQuery } from "@/hooks/environment/use-environment-cloud";
import { localPickerRow } from "@/components/settings/environment/environment-picker-model";
import {
  hostsRunningConfiguration,
  type FirsthandHost,
  type HostsRunningConfiguration,
} from "@/components/settings/environment/hosts-running-configuration-model";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { usePersonalComputers } from "@/components/settings/personal/use-personal-computers";
import {
  useHostScopeFor,
  WINDOW_HOST_SELECTION,
} from "@/components/settings/host-scope/use-host-scope";

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
 * THE hosts running a configuration: its host list, the app's own read of
 * authn (`environment.host.list`) on the viewer's session. Presence never decides membership: a
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
 *
 * `enabled` is the caller's own: a Local row's save reaches only this
 * computer and never reads `hosts`, so it passes `false` rather than firing
 * the polled `environment.host.list` read for a result it discards.
 */
export function useHostsRunningConfiguration(
  target:
    | { readonly kind: "personal" }
    | { readonly kind: "team"; readonly environmentId: string },
  enabled: boolean,
): HostsRunningConfiguration {
  const personalTarget = target.kind === "personal";
  const personal = usePersonalEnvironment(personalTarget);
  const environmentId =
    target.kind === "team" ? target.environmentId : personal.environmentId;
  const list = useEnvironmentCloudQuery({
    method: "environment.host.list",
    params: { environmentId: environmentId ?? "" },
    cacheKeyIdentity: [],
    mapResponse: (response) => response,
    enabled: enabled && environmentId !== null,
    poll: true,
  });
  const scope = useHostScopeFor(WINDOW_HOST_SELECTION);
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
    thisComputerUnread: unreadHostIds.size > 0,
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
export function useHostsRunningPersonal(
  enabled: boolean,
): HostsRunningConfiguration {
  return useHostsRunningConfiguration(PERSONAL_TARGET, enabled);
}
