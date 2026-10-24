import { TUI_HARNESS_ID_TO_PROVIDER_ID } from "@traycer/protocol/host/provider-schemas";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { isTuiHarnessId } from "@/components/home/data/landing-options";
import type { TerminalAgentLaunch } from "@/components/home/hooks/use-landing-composer-actions";
import { resolveSeededProfileId } from "@/lib/composer/resolve-seeded-profile-id";
import type { HostRpcRegistry } from "@/lib/host";
import type { ComposerToolbarState } from "@/stores/composer/composer-toolbar-store";

type HostProviders = ResponseOfMethod<
  HostRpcRegistry,
  "providers.list"
>["providers"];

/**
 * Whether phase 2 may resubmit on the new host: once its catalog has answered,
 * a send under its own gate, and a Start under its own gates once the host's
 * providers have answered too (they say whether its profile is offered).
 */
export function stagedResubmitReady(input: {
  readonly catalogSettled: boolean;
  readonly launch: TerminalAgentLaunch | null;
  readonly canSubmit: boolean;
  readonly canStart: readonly boolean[];
  readonly providers: { readonly data: unknown; readonly isError: boolean };
}): boolean {
  if (!input.catalogSettled) return false;
  if (input.launch === null) return input.canSubmit;
  const answered =
    input.providers.data !== undefined || input.providers.isError;
  return answered && input.canStart.every(Boolean);
}

/**
 * A terminal agent's Start that a staged sandbox took, assembled again on the
 * new host once its catalog and providers have answered. The toolbar's
 * selection is the person's harness and model where that catalog offers them
 * and the host's defaults where it does not. The captured profile and
 * arguments are kept for the same harness, the profile only where the host
 * offers it (else its own login). `null` when the host offers no terminal
 * agent.
 */
export function stagedTerminalLaunchOnHost(
  captured: TerminalAgentLaunch,
  toolbar: Pick<ComposerToolbarState, "selection" | "reasoning">,
  providers: HostProviders | undefined,
): TerminalAgentLaunch | null {
  const { harnessId, modelSlug } = toolbar.selection;
  if (!isTuiHarnessId(harnessId)) return null;
  const sameHarness = harnessId === captured.harnessId;
  const providerId = TUI_HARNESS_ID_TO_PROVIDER_ID[harnessId];
  const profiles = providers?.find(
    (provider) => provider.providerId === providerId,
  )?.profiles;
  return {
    harnessId,
    model: modelSlug.length > 0 ? modelSlug : null,
    reasoningEffort: toolbar.reasoning.length > 0 ? toolbar.reasoning : null,
    terminalAgentArgs: sameHarness ? captured.terminalAgentArgs : null,
    profileId: resolveSeededProfileId(
      sameHarness ? captured.profileId : toolbar.selection.profileId,
      profiles,
      true,
    ),
  };
}
