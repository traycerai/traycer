import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import type {
  EnvironmentProposalsRequest,
  EnvironmentProposalsResponse,
} from "@traycer/protocol/host/environment/settings-proposals";
import { tryAcquireReadyRemoteSession } from "@traycer-clients/shared/host-transport/remote/index";
import { readHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { servesOverLocalSocket } from "@/lib/host/host-messenger";
import {
  createSettingsSaveCoordinator,
  scheduleFollowUp,
  type SettingsSaveCoordinator,
} from "@/lib/environment/settings-save-coordinator";
import { SettingsSaveCoordinatorContext } from "@/providers/settings-save-coordinator-context";
import { SettingsSaveMemoryPersistLifecycleBridge } from "@/providers/settings-save-memory-persist-lifecycle-bridge";
import { SettingsSaveReconcile } from "@/providers/settings-save-reconcile";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Opens nothing: a host the transport serves over the local socket through
 * its own requester, any other only through a ready session another surface
 * holds. Decided by the directory row the transport routes by, not by this
 * machine's id: a shell with no local host of its own can still list a local
 * row.
 */
async function readProposals(
  binding: HostRuntimeBinding<HostRpcRegistry> | null,
  hostId: string,
  profileNameSaveIds: readonly string[],
): Promise<EnvironmentProposalsResponse | null> {
  if (binding === null) return null;
  const request: EnvironmentProposalsRequest =
    profileNameSaveIds.length === 0
      ? {}
      : { profileNameSaveIds: [...profileNameSaveIds] };
  const entry = binding.hostClient.resolveHostById(hostId);
  if (entry !== null && servesOverLocalSocket(entry)) {
    const local = resolveNamedHostClient(binding, hostId);
    if (local === null || !readHostReadiness(local).canExecute) return null;
    return local.request("environment.proposals", request);
  }
  const borrowed = tryAcquireReadyRemoteSession<HostRpcRegistry>(hostId);
  if (borrowed === null) return null;
  try {
    return await borrowed.sendUnary(
      "environment.proposals",
      request,
      null,
      undefined,
    );
  } finally {
    borrowed.release();
  }
}

function signedInAccount(): string | null {
  return useAuthStore.getState().contextMetadata?.userId ?? null;
}

function nowMs(): number {
  return Date.now();
}

/**
 * One coordinator for the window, reading through whichever binding is
 * current: a save begun under one binding settles, and is followed up, under
 * the next.
 */
function windowCoordinator(
  initial: HostRuntimeBinding<HostRpcRegistry> | null,
): {
  readonly coordinator: SettingsSaveCoordinator;
  readonly bind: (binding: HostRuntimeBinding<HostRpcRegistry> | null) => void;
} {
  let binding = initial;
  const coordinator = createSettingsSaveCoordinator({
    accountId: signedInAccount,
    cloud: () => (binding === null ? null : binding.auth.environmentCloud()),
    readProposals: (hostId, ids) => readProposals(binding, hostId, ids),
    profileNames: {
      read: async ({ environmentId, providerId, profileId }) => {
        if (binding === null) return null;
        const result = await binding.auth.readProfileRecords(
          environmentId,
          null,
        );
        if (result.kind !== "ok") return null;
        const provider = result.list.providers.find(
          (row) => row.providerId === providerId,
        );
        return (
          provider?.profiles.find((row) => row.profileId === profileId)
            ?.label ?? null
        );
      },
      write: async ({ environmentId, providerId, profileId, name }) => {
        if (binding === null) return false;
        const result = await binding.auth.nameProfileRecord(
          environmentId,
          providerId,
          { profileId, name },
          null,
        );
        return result.kind === "ok";
      },
    },
    now: nowMs,
    schedule: scheduleFollowUp,
  });
  return {
    coordinator,
    bind: (next) => {
      binding = next;
    },
  };
}

/** Applies each hold as its host connects, with or without an editor open. */
export function SettingsSaveCoordinatorProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  const binding = useHostBinding();
  const [{ coordinator, bind }] = useState(() => windowCoordinator(binding));
  useLayoutEffect(() => bind(binding), [bind, binding]);
  useEffect(() => () => coordinator.stop(), [coordinator]);
  return (
    <SettingsSaveMemoryPersistLifecycleBridge>
      <SettingsSaveCoordinatorContext.Provider value={coordinator}>
        <SettingsSaveReconcile coordinator={coordinator} />
        {props.children}
      </SettingsSaveCoordinatorContext.Provider>
    </SettingsSaveMemoryPersistLifecycleBridge>
  );
}
