import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { ChatRouting } from "@traycer/protocol/persistence/epic/foundation";
import type { ChatRunSettings } from "@traycer/protocol/persistence/epic/schemas";
import type { AgentConfigureRequestV71 } from "@traycer/protocol/host/index";

/** The label of the per-agent setting, as the menu and its tests print it. */
export const CHAT_ROUTING_SETTING_LABEL = "On a usage limit or error";

/**
 * The two choices, in menu order. `policy` is what every chat did before the
 * field existed, so it is the choice an absent value means.
 */
export const CHAT_ROUTING_OPTIONS: ReadonlyArray<{
  readonly value: ChatRouting;
  readonly label: string;
}> = [
  { value: "policy", label: "Follow the device routing" },
  { value: "hold", label: "Wait it out here" },
];

/** The chat's choice; a chat that never made one follows the device. */
export function chatRoutingOf(chat: {
  readonly routing?: ChatRouting | undefined;
}): ChatRouting {
  return chat.routing ?? "policy";
}

/**
 * Whether a host's negotiated `agent.configure` carries the routing field,
 * which arrived with 7.1. An older host would refuse the request body, so the
 * setting is not offered to it.
 */
export function agentConfigureCarriesRouting(
  version: SchemaVersion | null,
): boolean {
  if (version === null) return false;
  return version.major > 7 || (version.major === 7 && version.minor >= 1);
}

/**
 * The `agent.configure` request that changes ONLY the routing of a chat that
 * already has a persisted run tuple: the tuple is restated as it stands (the
 * host answers a restated tuple without touching the running chat) and the
 * permission mode is `null`, which keeps the stored one.
 *
 * The chat configures itself - it is both the calling agent and the target -
 * because the GUI is not an agent and the call has to name one the user owns.
 * `null` when the chat has no persisted tuple yet (nothing to restate).
 */
export function buildRoutingConfigureRequest(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly settings: ChatRunSettings | null;
  readonly routing: ChatRouting;
}): AgentConfigureRequestV71 | null {
  const { settings } = input;
  if (settings === null) return null;
  return {
    epicId: input.epicId,
    senderAgentId: input.chatId,
    agentId: input.chatId,
    harnessId: settings.harnessId,
    model: settings.model,
    profileSelection:
      settings.profileId === null
        ? { kind: "ambient" }
        : { kind: "profile", profileId: settings.profileId },
    reasoningEffort: settings.reasoningEffort,
    fastMode: settings.serviceTier !== null,
    permissionMode: null,
    routing: input.routing,
  };
}
