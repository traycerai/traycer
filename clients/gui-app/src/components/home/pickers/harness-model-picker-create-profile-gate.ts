import { useMemo } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";

const EMPTY_HOST_DIRECTORY: ReadonlyArray<HostDirectoryEntry> = [];

export const EMPTY_LOGIN_CAPABILITY_BY_HARNESS_ID: ReadonlyMap<
  GuiHarnessId,
  ProviderCliState["loginCapability"]
> = new Map();

/**
 * S8: host-scoped, capability-gated "Create new profile" support for the
 * picker. OAuth sign-in needs a local host that advertises login args for
 * the browsed provider - this mirrors Settings' `providerCanStartProfileOauth`
 * gate (`providers-settings-panel.tsx`), scoped to whichever host the
 * picker's `createProfileHostId` prop resolves to (a tab's host, or the
 * app-wide default when `null`) instead of always the renderer-default host.
 */

export function loginCapabilityByHarnessIdFromProviderStates(
  providers: ReadonlyArray<ProviderCliState>,
): ReadonlyMap<GuiHarnessId, ProviderCliState["loginCapability"]> {
  return new Map(
    providers.map((provider) => [
      providerIdToGuiHarnessId(provider.providerId),
      provider.loginCapability,
    ]),
  );
}

// A `null`/unresolved host id is treated as "not local" - the safe default
// while the directory is still loading.
function isHostLocal(
  directory: ReadonlyArray<HostDirectoryEntry>,
  hostId: string | null,
): boolean {
  if (hostId === null) return false;
  return directory.find((entry) => entry.hostId === hostId)?.kind === "local";
}

/** Whether the "Create new profile" target host (`createProfileHostId`, or
 *  the app-wide default when `null`) is local - OAuth sign-in needs a local
 *  host to spawn the browser flow on. */
export function useCreateProfileHostIsLocal(
  createProfileHostId: string | null,
): boolean {
  const defaultActiveHostId = useReactiveActiveHostId();
  const hostDirectory = useHostDirectoryList();
  return useMemo(
    () =>
      isHostLocal(
        hostDirectory.data ?? EMPTY_HOST_DIRECTORY,
        createProfileHostId ?? defaultActiveHostId,
      ),
    [hostDirectory.data, createProfileHostId, defaultActiveHostId],
  );
}

export function resolveCreateProfileGate(
  hostIsLocal: boolean,
  loginCapability: ProviderCliState["loginCapability"] | undefined,
): { readonly disabled: boolean; readonly reason: string | undefined } {
  const oauthArgs = loginCapability?.oauthArgs ?? null;
  const disabled = !hostIsLocal || oauthArgs === null || oauthArgs.length === 0;
  return {
    disabled,
    reason: disabled
      ? "Add profiles from a local host with browser sign-in available."
      : undefined,
  };
}
