import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { useGuiHarnessesQueryForClient } from "@/hooks/harnesses/use-gui-harness-catalog";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import type { ComposerHostNoticeState } from "@/components/home/composer/composer-host-notice";
import { useConfigurationProvidersOpener } from "@/hooks/sandboxes/use-open-configuration-providers";
import { useSandboxHostConfiguration } from "@/hooks/sandboxes/use-on-team-sandbox";
import type { HostRpcRegistry } from "@/lib/host";
import { requestedAgentReadiness } from "@/lib/sandboxes/pending-sandbox-send";
import { stageConfigurationCopy } from "@/lib/sandboxes/sandbox-stage-model";
import {
  configurationLabel,
  openProvidersLabel,
  signInToCodingAgentLine,
} from "@/lib/sandboxes/sandbox-strings";

export interface SandboxAgentGate {
  /** The send is held: the agent picked cannot run on this sandbox. */
  readonly blocked: boolean;
  /** Why, for a disabled send's hint; `null` when nothing is held. */
  readonly hint: string | null;
  /**
   * The same refusal as the composer's notice, with the configuration's own
   * Providers, for a surface that refuses at Send; `null` when nothing is held.
   */
  readonly notice: ComposerHostNoticeState | null;
}

const NOT_BLOCKED: SandboxAgentGate = {
  blocked: false,
  hint: null,
  notice: null,
};

/**
 * "Can the agent picked run on this sandbox?" for a composer whose host is a
 * sandbox (sandboxes redesign Flow 1). A sandbox's toolbar keeps the person's
 * pick whatever the host reports (`keepsUnavailablePick`), so a pick that
 * cannot run there is refused here, never swapped. An install still running
 * is the pack gate's wait, and an availability still being probed holds
 * nothing. Every other host passes, as does a host whose lists have not
 * answered: the host has the final word.
 */
export function useSandboxAgentGate(input: {
  readonly hostId: string | null;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly harnessId: GuiHarnessId | null;
  readonly active: boolean;
}): SandboxAgentGate {
  const configuration = useSandboxHostConfiguration(input.hostId);
  const watching = input.active && configuration !== null;
  const activity = { enabled: watching, subscribed: watching };
  const harnesses = useGuiHarnessesQueryForClient(input.client, activity);
  const providers = useProvidersListForClient(input.client, activity);
  const providersOpener = useConfigurationProvidersOpener(
    input.active && configuration !== null && configuration.kind === "team",
  );
  if (configuration === null || input.harnessId === null) return NOT_BLOCKED;
  const readiness = requestedAgentReadiness(
    input.harnessId,
    harnesses.data?.harnesses,
    providers.data?.providers,
  );
  if (readiness.kind !== "unusable") return NOT_BLOCKED;
  const label = configurationLabel(stageConfigurationCopy(configuration));
  const hint = signInToCodingAgentLine(label);
  const openProviders = providersOpener(configuration);
  return {
    blocked: true,
    hint,
    notice: {
      kind: "refused",
      message: hint,
      action:
        openProviders === null
          ? null
          : { label: openProvidersLabel(label), onAction: openProviders },
    },
  };
}
