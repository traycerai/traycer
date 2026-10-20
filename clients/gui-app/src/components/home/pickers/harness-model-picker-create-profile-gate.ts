import { useMemo } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import {
  providerDisplayName,
  providerIdToGuiHarnessId,
} from "@/lib/provider-ordering";
import {
  providerHostBlock,
  providerHostBlockLabel,
  providerLoginIsRemoteSafe,
  providerSupportsTerminalLogin,
} from "@/components/providers/provider-signin-availability";

const EMPTY_HOST_DIRECTORY: ReadonlyArray<HostDirectoryEntry> = [];

export const EMPTY_PROVIDER_STATE_BY_HARNESS_ID: ReadonlyMap<
  GuiHarnessId,
  ProviderCliState
> = new Map();

/**
 * S8: host-scoped, capability-gated "Create new profile" support for the
 * picker. OAuth sign-in needs a local host that advertises login args for
 * the browsed provider - this mirrors Settings' `providerCanStartProfileOauth`
 * gate (`providers-settings-panel.tsx`), scoped to whichever host the
 * picker's `createProfileHostId` prop resolves to (a tab's host, or the
 * app-wide default when `null`) instead of always the renderer-default host.
 *
 * The whole row, not its `loginCapability` alone: whether the host would act
 * on the click (the provider is on, a CLI is there to run) is on the row
 * beside the capability, and a gate that read only the capability offered a
 * profile the host then refused to sign in.
 */

export function providerStateByHarnessIdFromProviderStates(
  providers: ReadonlyArray<ProviderCliState>,
): ReadonlyMap<GuiHarnessId, ProviderCliState> {
  return new Map(
    providers.map((provider) => [
      providerIdToGuiHarnessId(provider.providerId),
      provider,
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
  const defaultActiveHostId = useAddressableHostId();
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
  credentialRefusal: string | null,
  hostIsLocal: boolean,
  state: ProviderCliState | undefined,
): { readonly disabled: boolean; readonly reason: string | undefined } {
  // First, and whatever the provider: a sandbox takes no sign-in at all
  // (`useHostCredentialRefusal`).
  if (credentialRefusal !== null) {
    return { disabled: true, reason: credentialRefusal };
  }
  const loginCapability = state?.loginCapability;
  // A terminal-login provider is answered before the `oauthArgs` gate below,
  // whichever way its `oauthArgs` point. Copilot carries real ones (its
  // headless command exists, the host just refuses it), so without this it
  // would read as gate-passing and offer a "Create new profile" flow the host
  // refuses; Qwen, Droid, OMP and OpenCode carry none, and would fall to the
  // generic copy - which names browser sign-in, exactly the thing none of
  // these providers do. Ordering is safe against a null/absent capability
  // because the helper answers false for both.
  if (providerSupportsTerminalLogin(loginCapability)) {
    return {
      disabled: true,
      reason: "This provider is signed in from a terminal, not the browser.",
    };
  }
  const oauthArgs = loginCapability?.oauthArgs ?? null;
  // Non-null, empty included: an ACP-authenticate provider's headless sign-in
  // carries no login subcommand at all (the host drives ACP `authenticate`),
  // so `[]` is capability, not absence. See `providerSignInUnavailableHint`
  // for the full reasoning - these two gates must not disagree about whether a
  // provider can browser-sign-in.
  const remoteSafe = providerLoginIsRemoteSafe(loginCapability);
  if (oauthArgs === null || (!hostIsLocal && !remoteSafe)) {
    return {
      disabled: true,
      reason: "Add profiles from a local host with browser sign-in available.",
    };
  }
  // After the permanent reasons, as in `providerSignInUnavailableReason`. A
  // row that has not arrived never reaches here: it has no capability either.
  const block =
    state === undefined ? null : providerHostBlock(state, "sign-in");
  if (block === null) return { disabled: false, reason: undefined };
  return {
    disabled: true,
    reason: providerHostBlockLabel(
      block,
      state === undefined ? "" : providerDisplayName(state.providerId),
    ),
  };
}
