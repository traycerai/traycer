import { useMemo, type ReactNode } from "react";
import type { EnvironmentProposalsResponse } from "@traycer/protocol/host/environment/settings-proposals";
import { useHostBinding } from "@/lib/host";
import { createSettingsSaveCoordinator } from "@/lib/environment/settings-save-coordinator";
import { SettingsSaveCoordinatorContext } from "@/providers/settings-save-coordinator-context";
import { SettingsSaveMemoryPersistLifecycleBridge } from "@/providers/settings-save-memory-persist-lifecycle-bridge";
import { SettingsSaveReconcile } from "@/providers/settings-save-reconcile";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * `environment.proposals` is not served by any host this app can name yet, so
 * every host answers as not connected and each remembered save waits for the
 * next connection.
 */
function readNoProposals(): Promise<EnvironmentProposalsResponse | null> {
  return Promise.resolve(null);
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
  const auth = useHostBinding()?.auth ?? null;
  const coordinator = useMemo(
    () =>
      createSettingsSaveCoordinator({
        accountId: signedInAccount,
        cloud: () => (auth === null ? null : auth.environmentCloud()),
        readProposals: readNoProposals,
        now: nowMs,
      }),
    [auth],
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
