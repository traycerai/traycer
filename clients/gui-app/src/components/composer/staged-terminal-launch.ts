import { TUI_HARNESS_ID_TO_PROVIDER_ID } from "@traycer/protocol/host/provider-schemas";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  providerPackBlocksExecution,
  providerPackPreparingForProvider,
} from "@/components/providers/provider-pack-readiness";
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
 * providers have answered too (they say whether its profile is offered) and
 * the Start's own harness's pack is not still being readied there. Until then
 * the line stays on its last step.
 */
export function stagedResubmitReady(input: {
  readonly catalogSettled: boolean;
  readonly launch: TerminalAgentLaunch | null;
  readonly canSubmit: boolean;
  readonly canStart: readonly boolean[];
  readonly providers: {
    readonly data: { readonly providers: HostProviders } | undefined;
    readonly isError: boolean;
  };
}): boolean {
  if (!input.catalogSettled) return false;
  if (input.launch === null) return input.canSubmit;
  const answered =
    input.providers.data !== undefined || input.providers.isError;
  if (!answered) return false;
  if (packPreparing(input.launch.harnessId, input.providers.data?.providers)) {
    return false;
  }
  return input.canStart.every(Boolean);
}

/** Whether the harness's pack is still being readied with nothing to run. */
function packPreparing(
  harnessId: GuiHarnessId,
  providers: HostProviders | undefined,
): boolean {
  if (!isTuiHarnessId(harnessId) || providers === undefined) return false;
  const providerId = TUI_HARNESS_ID_TO_PROVIDER_ID[harnessId];
  const provider = providers.find(
    (candidate) => candidate.providerId === providerId,
  );
  if (provider === undefined) return false;
  const preparing = providerPackPreparingForProvider(provider);
  return preparing !== null && providerPackBlocksExecution(preparing);
}

/**
 * A terminal agent's Start that a staged sandbox took, assembled again on the
 * new host once its catalog and providers have answered: the person's own
 * harness, model and arguments, never one the new host's toolbar would swap
 * in. The captured profile is kept only where the host offers it (else its
 * own login). `null` when that harness cannot run there: not in the host's
 * catalog, unavailable there, or not a terminal agent, as the terminal
 * panel's Start reads it. The line then says so, and offers a terminal.
 */
export function stagedTerminalLaunchOnHost(
  captured: TerminalAgentLaunch,
  toolbar: Pick<ComposerToolbarState, "catalog">,
  providers: HostProviders | undefined,
): TerminalAgentLaunch | null {
  const harness = toolbar.catalog.harnesses?.find(
    (option) => option.id === captured.harnessId,
  );
  if (harness === undefined || !harness.available) return null;
  if (!harness.modes.includes("tui")) return null;
  const providerId = TUI_HARNESS_ID_TO_PROVIDER_ID[captured.harnessId];
  const profiles = providers?.find(
    (provider) => provider.providerId === providerId,
  )?.profiles;
  return {
    ...captured,
    profileId: resolveSeededProfileId(captured.profileId, profiles, true),
  };
}
