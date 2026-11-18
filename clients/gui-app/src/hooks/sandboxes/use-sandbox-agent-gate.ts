import { useCallback, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { useGuiHarnessesQueryForClient } from "@/hooks/harnesses/use-gui-harness-catalog";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import type {
  ComposerHostNoticeAction,
  ComposerHostNoticeState,
} from "@/components/home/composer/composer-host-notice";
import { useConfigurationProvidersOpener } from "@/hooks/sandboxes/use-open-configuration-providers";
import { useSandboxHostConfiguration } from "@/hooks/sandboxes/use-on-team-sandbox";
import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import {
  sandboxAgentNotOfferedNotice,
  sandboxAgentRefusedNotice,
  sandboxAgentsUncheckedNotice,
  type SandboxAgentRemedies,
} from "@/lib/sandboxes/sandbox-agent-refusal";
import type { HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";
import {
  requestedAgentReadiness,
  traycerInferenceOff,
  type RequestedAgentReadiness,
} from "@/lib/sandboxes/pending-sandbox-send";
import { useChatOpencodeLine } from "@/hooks/harnesses/chat-opencode-line-context";
import {
  guiHarnessIdToProviderId,
  providerDisplayName,
} from "@/lib/provider-ordering";
import { stageConfigurationCopy } from "@/lib/sandboxes/sandbox-stage-model";
import {
  agentsCantRunOnSandboxLine,
  CHECKING_SANDBOX_AGENTS,
  configurationLabel,
  openProvidersLabel,
  traycerOffOnSandboxLine,
} from "@/lib/sandboxes/sandbox-strings";

export interface SandboxAgentGate {
  /** The send is held: the agent picked cannot run on this sandbox. */
  readonly blocked: boolean;
  /** Why, for a disabled send's hint; `null` when nothing is held. */
  readonly hint: string | null;
  /**
   * The same refusal as the composer's notice, with its remedies, for a
   * surface that refuses at Send; `null` when nothing is held.
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
 * sandbox. A sandbox's toolbar keeps the person's
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
  const label = configurationLabel(stageConfigurationCopy(configuration));
  const openProviders = providersOpener(configuration);
  return sandboxAgentGateFor({
    harnessId: input.harnessId,
    readiness: requestedAgentReadiness(
      input.harnessId,
      harnesses.data?.harnesses,
      providers.data?.providers,
      opencodeLine,
    ),
    offeredAgents,
    setupFailedAction:
      openProviders === null
        ? null
        : { label: openProvidersLabel(label), onAction: openProviders },
    remedies: input,
  });
}

/** The sandbox host's own answer for the pick, in the order it is refused. */
function sandboxAgentGateFor(args: {
  readonly harnessId: GuiHarnessId;
  readonly readiness: RequestedAgentReadiness;
  readonly offeredAgents: ReadonlyArray<string> | undefined;
  /** The configuration's Providers, for an install that failed there. */
  readonly setupFailedAction: ComposerHostNoticeAction | null;
  readonly remedies: SandboxAgentRemedies;
}): SandboxAgentGate {
  const { harnessId, readiness, offeredAgents, remedies } = args;
  const offered = offeredAgents ?? null;
  // Before the catalogue: with the sandbox's own switch off no agent runs
  // there, whatever the pick, so that is what the refusal says.
  if (readiness.kind === "traycer-off")
    return refusedOnSandboxGate(
      traycerOffOnSandboxLine(null),
      offered,
      null,
      remedies,
    );
  if (
    readiness.kind === "not-offered" ||
    (offeredAgents !== undefined && !offeredAgents.includes(harnessId))
  )
    return notOfferedGate(harnessId, offeredAgents, remedies);
  switch (readiness.kind) {
    case "ready":
      return NOT_BLOCKED;
    case "waiting":
      return sandboxAgentPreparingGate(harnessId);
    case "unusable":
      return refusedOnSandboxGate(
        agentsCantRunOnSandboxLine(null),
        offered,
        null,
        remedies,
      );
    case "setup-failed":
      return refusedOnSandboxGate(
        readiness.detail,
        offered,
        args.setupFailedAction,
        remedies,
      );
  }
}

/** A pick the sandbox cannot run, refused with every remedy beside it. */
function refusedOnSandboxGate(
  message: string,
  offeredAgents: ReadonlyArray<string> | null,
  extra: ComposerHostNoticeAction | null,
  remedies: SandboxAgentRemedies,
): SandboxAgentGate {
  return {
    blocked: true,
    hint: message,
    notice: sandboxAgentRefusedNotice(message, offeredAgents, remedies, extra),
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
 * What this client last read of a host's own Traycer Inference switch: its
 * providers list as the cache still holds it, never a read of its own, since
 * a resting sandbox answers nothing and asking would wake it. `false` when
 * nothing is held, as a sandbox seeds the switch on.
 *
 * Read off the cache rather than through an observer: an observer's options
 * become the shared query's, and a refetch of that host's list that ran on
 * them would find no way to read it.
 */
function useLastKnownTraycerInferenceOff(hostId: string | null): boolean {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  const read = useCallback((): boolean => {
    if (hostId === null) return false;
    const cached = queryClient.getQueryData<
      ResponseOfMethod<HostRpcRegistry, "providers.list">
    >(
      queryKeys.hostMethod<HostRpcRegistry, "providers.list">(
        hostId,
        "providers.list",
        { native: null },
      ),
    );
    return traycerInferenceOff(cached?.providers);
  }, [hostId, queryClient]);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * `useSandboxAgentGate` for a chat whose sandbox rests. Its chat is drawn by
 * the published copy, bound to the host SERVING that copy, so no host this
 * composer can read is the one the send runs on, and the sandbox itself
 * answers nothing until it is awake. Two things decide here, before any wake.
 * The sandbox's own Traycer Inference switch, as last read while it was awake:
 * off is refused, and unknown passes. Then the cloud catalogue: an agent
 * sandboxes don't offer is refused, and an offered one passes, leaving its
 * readiness to the woken sandbox. So does every agent when an older server's
 * catalogue names none. A read that ended with no catalogue holds Send with
 * Retry, since a pass would wake the sandbox unchecked.
 *
 * Read whenever the chat rests, focused or not, so a pane that never asked is
 * not mistaken for one whose read failed. Inert while `resting` is false.
 */
export function useRestingSandboxAgentGate(
  input: {
    readonly resting: boolean;
    /** The resting sandbox's own host. */
    readonly hostId: string | null;
    readonly harnessId: GuiHarnessId | null;
  } & SandboxAgentRemedies,
): SandboxAgentGate {
  const catalogue = useSandboxCatalogue(input.resting);
  const traycerOff = useLastKnownTraycerInferenceOff(
    input.resting ? input.hostId : null,
  );
  if (!input.resting || input.harnessId === null) return NOT_BLOCKED;
  if (traycerOff)
    return refusedOnSandboxGate(
      traycerOffOnSandboxLine(null),
      catalogue.data?.offeredAgents ?? null,
      null,
      input,
    );
  if (catalogue.data === undefined) {
    if (catalogue.isFetching) return CHECKING_OFFERED_AGENTS;
    const notice = sandboxAgentsUncheckedNotice(() => {
      void catalogue.refetch();
    });
    return { blocked: true, hint: notice.message, notice };
  }
  const offeredAgents = catalogue.data.offeredAgents;
  if (offeredAgents === undefined || offeredAgents.includes(input.harnessId))
    return NOT_BLOCKED;
  return notOfferedGate(input.harnessId, offeredAgents, input);
}
