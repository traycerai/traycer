import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { useGuiHarnessesQueryForClient } from "@/hooks/harnesses/use-gui-harness-catalog";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import type { ComposerHostNoticeState } from "@/components/home/composer/composer-host-notice";
import { useConfigurationProvidersOpener } from "@/hooks/sandboxes/use-open-configuration-providers";
import { useSandboxHostConfiguration } from "@/hooks/sandboxes/use-on-team-sandbox";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import {
  sandboxAgentNotOfferedNotice,
  sandboxAgentSecondaryActions,
  type SandboxAgentRemedies,
} from "@/lib/sandboxes/sandbox-agent-refusal";
import type { HostRpcRegistry } from "@/lib/host";
import { requestedAgentReadiness } from "@/lib/sandboxes/pending-sandbox-send";
import { useChatOpencodeLine } from "@/hooks/harnesses/chat-opencode-line-context";
import {
  guiHarnessIdToProviderId,
  providerDisplayName,
} from "@/lib/provider-ordering";
import { stageConfigurationCopy } from "@/lib/sandboxes/sandbox-stage-model";
import {
  CHECKING_SANDBOX_AGENTS,
  configurationLabel,
  openProvidersLabel,
  enableSandboxInferenceLine,
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

/** An agent sandboxes don't run, refused with "Choose a model" on what they do. */
function notOfferedGate(
  harnessId: GuiHarnessId,
  offeredAgents: ReadonlyArray<string> | undefined,
  remedies: SandboxAgentRemedies,
): SandboxAgentGate {
  const notice = sandboxAgentNotOfferedNotice(
    harnessId,
    offeredAgents ?? null,
    remedies,
  );
  return { blocked: true, hint: notice.message, notice };
}

/** The pending notice holds Send while the destination proves launch readiness. */
function sandboxAgentPreparingGate(harnessId: GuiHarnessId): SandboxAgentGate {
  const providerId = guiHarnessIdToProviderId(harnessId);
  const label =
    providerId === null ? harnessId : providerDisplayName(providerId);
  const hint = `Preparing ${label}…`;
  return {
    blocked: true,
    hint,
    notice: { kind: "mirror", message: hint, pending: true, action: null },
  };
}

/**
 * "Can the agent picked run on this sandbox?" for a composer whose host is a
 * sandbox (sandboxes redesign Flow 1). A sandbox's toolbar keeps the person's
 * pick whatever the host reports (`keepsUnavailablePick`), so a pick that
 * cannot run there is refused here, never swapped. Missing launch proof and
 * pending probes hold Send until the destination's own lists prove readiness.
 * A bound chat checks its recorded OpenCode line; a new chat follows the
 * destination's selection. Every other host passes.
 */
export function useSandboxAgentGate(
  input: {
    readonly hostId: string | null;
    readonly client: HostClient<HostRpcRegistry> | null;
    readonly harnessId: GuiHarnessId | null;
    readonly active: boolean;
  } & SandboxAgentRemedies,
): SandboxAgentGate {
  const configuration = useSandboxHostConfiguration(input.hostId);
  const opencodeLine = useChatOpencodeLine();
  const watching = input.active && configuration !== null;
  const activity = { enabled: watching, subscribed: watching };
  const harnesses = useGuiHarnessesQueryForClient(input.client, activity);
  const providers = useProvidersListForClient(input.client, activity);
  const offeredAgents = useSandboxCatalogue(watching).data?.offeredAgents;
  const providersOpener = useConfigurationProvidersOpener(
    input.active && configuration !== null && configuration.kind === "team",
  );
  if (configuration === null || input.harnessId === null) return NOT_BLOCKED;
  if (offeredAgents !== undefined && !offeredAgents.includes(input.harnessId))
    return notOfferedGate(input.harnessId, offeredAgents, input);
  const readiness = requestedAgentReadiness(
    input.harnessId,
    harnesses.data?.harnesses,
    providers.data?.providers,
    opencodeLine,
  );
  if (readiness.kind === "not-offered")
    return notOfferedGate(input.harnessId, offeredAgents, input);
  if (readiness.kind === "ready") return NOT_BLOCKED;
  if (readiness.kind === "waiting")
    return sandboxAgentPreparingGate(input.harnessId);
  const label = configurationLabel(stageConfigurationCopy(configuration));
  const hint =
    readiness.kind === "setup-failed"
      ? readiness.detail
      : enableSandboxInferenceLine(label);
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
      secondaryActions: sandboxAgentSecondaryActions(input),
    },
  };
}

const CHECKING_OFFERED_AGENTS: SandboxAgentGate = {
  blocked: true,
  hint: CHECKING_SANDBOX_AGENTS,
  notice: {
    kind: "mirror",
    message: CHECKING_SANDBOX_AGENTS,
    pending: true,
    action: null,
  },
};

/**
 * `useSandboxAgentGate` for a chat whose sandbox rests. Its chat is drawn by
 * the published copy, bound to the host SERVING that copy, so no host this
 * composer can read is the one the send runs on, and the sandbox itself
 * answers nothing until it is awake. The cloud catalogue decides here, before
 * any wake: an agent sandboxes don't offer is refused, and an offered one
 * passes, leaving its readiness to the woken sandbox. Inert while `resting`
 * is false.
 */
export function useRestingSandboxAgentGate(input: {
  readonly resting: boolean;
  readonly harnessId: GuiHarnessId | null;
  readonly active: boolean;
}): SandboxAgentGate {
  const catalogue = useSandboxCatalogue(input.active && input.resting);
  if (!input.resting || input.harnessId === null) return NOT_BLOCKED;
  if (catalogue.data === undefined && catalogue.isFetching)
    return CHECKING_OFFERED_AGENTS;
  const offeredAgents = catalogue.data?.offeredAgents;
  if (offeredAgents === undefined || offeredAgents.includes(input.harnessId))
    return NOT_BLOCKED;
  return notOfferedGate(input.harnessId, offeredAgents, {});
}
