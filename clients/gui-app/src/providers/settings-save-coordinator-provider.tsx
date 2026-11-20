import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import type { EnvironmentProposalsResponse } from "@traycer/protocol/host/environment/settings-proposals";
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
): Promise<EnvironmentProposalsResponse | null> {
  if (binding === null) return null;
  const entry = binding.hostClient.resolveHostById(hostId);
  if (entry !== null && servesOverLocalSocket(entry)) {
    const local = resolveNamedHostClient(binding, hostId);
    if (local === null || !readHostReadiness(local).canExecute) return null;
    return local.request("environment.proposals", {});
  }
  const borrowed = tryAcquireReadyRemoteSession<HostRpcRegistry>(hostId);
  if (borrowed === null) return null;
  try {
    return await borrowed.sendUnary(
      "environment.proposals",
      {},
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
    readProposals: (hostId) => readProposals(binding, hostId),
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
