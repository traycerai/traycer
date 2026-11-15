import { useMemo, type ReactNode } from "react";
import type { EnvironmentProposalsResponse } from "@traycer/protocol/host/environment/settings-proposals";
import { tryAcquireReadyRemoteSession } from "@traycer-clients/shared/host-transport/remote/index";
import { readHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { createSettingsSaveCoordinator } from "@/lib/environment/settings-save-coordinator";
import { SettingsSaveCoordinatorContext } from "@/providers/settings-save-coordinator-context";
import { SettingsSaveMemoryPersistLifecycleBridge } from "@/providers/settings-save-memory-persist-lifecycle-bridge";
import { SettingsSaveReconcile } from "@/providers/settings-save-reconcile";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * `environment.proposals` on `hostId`, over a connection this window already
 * holds: this machine's host through its own requester while it can be asked,
 * a remote host only through a ready session another surface holds. Opens
 * nothing; null when there is no such connection.
 */
function proposalsReader(
  binding: HostRuntimeBinding<HostRpcRegistry> | null,
): (hostId: string) => Promise<EnvironmentProposalsResponse | null> {
  return async (hostId) => {
    if (binding === null) return null;
    if (hostId === binding.directory.getLocalHostId()) {
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
  };
}

function signedInAccount(): string | null {
  return useAuthStore.getState().contextMetadata?.userId ?? null;
}

function nowMs(): number {
  return Date.now();
}

/**
 * The window's one settings-save coordinator: every save made in a host's
 * settings remembers itself here, and the window applies the hold of each as
 * its host connects, with or without an editor open.
 */
export function SettingsSaveCoordinatorProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  const binding = useHostBinding();
  const coordinator = useMemo(
    () =>
      createSettingsSaveCoordinator({
        accountId: signedInAccount,
        cloud: () =>
          binding === null ? null : binding.auth.environmentCloud(),
        readProposals: proposalsReader(binding),
        now: nowMs,
      }),
    [binding],
  );
  return (
    <SettingsSaveMemoryPersistLifecycleBridge>
      <SettingsSaveCoordinatorContext.Provider value={coordinator}>
        <SettingsSaveReconcile coordinator={coordinator} />
        {props.children}
      </SettingsSaveCoordinatorContext.Provider>
    </SettingsSaveMemoryPersistLifecycleBridge>
  );
}
