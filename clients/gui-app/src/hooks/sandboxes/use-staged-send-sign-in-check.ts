import { useCallback } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ComposerHostNoticeState } from "@/components/home/composer/composer-host-notice";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useGuiHarnessesQueryForClient } from "@/hooks/harnesses/use-gui-harness-catalog";
import { useConfigurationProvidersOpener } from "@/hooks/sandboxes/use-open-configuration-providers";
import type { HostRpcRegistry } from "@/lib/host";
import {
  stageConfigurationCopy,
  type StageConfiguration,
} from "@/lib/sandboxes/sandbox-stage-model";
import {
  configurationLabel,
  openProvidersLabel,
  signInToCodingAgentLine,
} from "@/lib/sandboxes/sandbox-strings";
import type { StagedSandbox } from "@/stores/composer/staged-sandbox-store";

/**
 * Whether the agent picked can run on a staged sandbox, decided at Send from
 * the configuration's own sign-ins: a configuration's providers apply on
 * every computer and sandbox running it, so an agent signed out on a host
 * running that configuration is signed out on its sandbox too. The send is
 * refused before any create or wake, and the draft and the chip stay: the
 * composer's refusal notice says so, with the configuration's Providers.
 *
 * Read on the composer's own host, and only when that host runs the staged
 * configuration; otherwise this cannot say, and the sandbox's own check
 * (`requestedAgentReadiness`) refuses it once it is up.
 */
export function useStagedSendSignInCheck(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly harnessId: GuiHarnessId | null;
  readonly active: boolean;
}): (stage: StagedSandbox) => ComposerHostNoticeState | null {
  const { harnessId, active } = input;
  const harnesses = useGuiHarnessesQueryForClient(input.client, {
    enabled: active,
    subscribed: active,
  }).data?.harnesses;
  const principal =
    useEnvironmentStatusRead(input.client, input.hostId, active).data
      ?.principal ?? null;
  const providersOpener = useConfigurationProvidersOpener(
    active && principal?.kind === "team",
  );
  return useCallback(
    (stage: StagedSandbox): ComposerHostNoticeState | null => {
      if (harnessId === null) return null;
      const configuration = stage.target.configuration;
      if (!runsConfiguration(principal, configuration)) return null;
      const harness = harnesses?.find((row) => row.id === harnessId);
      if (harness?.authStatus !== "unauthenticated") return null;
      const label = configurationLabel(stageConfigurationCopy(configuration));
      const openProviders = providersOpener(configuration);
      return {
        kind: "refused",
        message: signInToCodingAgentLine(label),
        action:
          openProviders === null
            ? null
            : { label: openProvidersLabel(label), onAction: openProviders },
      };
    },
    [harnessId, harnesses, principal, providersOpener],
  );
}

function runsConfiguration(
  principal:
    | { readonly kind: "personal" }
    | { readonly kind: "team"; readonly teamName: string }
    | null,
  configuration: StageConfiguration,
): boolean {
  if (principal === null) return false;
  if (configuration.kind === "personal") return principal.kind === "personal";
  return (
    principal.kind === "team" && principal.teamName === configuration.teamName
  );
}
