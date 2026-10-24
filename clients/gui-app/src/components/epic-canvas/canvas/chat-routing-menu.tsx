import { useSyncExternalStore } from "react";
import { Route } from "lucide-react";
import type { ChatRouting } from "@traycer/protocol/persistence/epic/foundation";
import type { ChatRunSettings } from "@traycer/protocol/persistence/epic/schemas";
import { chatRoutingSchema } from "@traycer/protocol/persistence/epic/foundation";
import {
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { useAgentConfigure } from "@/hooks/agent/use-configure-agent-mutation";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";
import {
  agentConfigureCarriesRouting,
  buildRoutingConfigureRequest,
  CHAT_ROUTING_OPTIONS,
  CHAT_ROUTING_SETTING_LABEL,
  chatRoutingOf,
} from "@/lib/chat/chat-routing-setting";

interface ChatRoutingRadioGroupProps {
  readonly value: ChatRouting;
  readonly disabled: boolean;
  readonly onChange: (routing: ChatRouting) => void;
}

/** The setting itself: what the chat does on a usage limit or an error. */
export function ChatRoutingContextMenuGroup(props: ChatRoutingRadioGroupProps) {
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger disabled={props.disabled}>
        <Route className="size-4" />
        {CHAT_ROUTING_SETTING_LABEL}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        <ContextMenuRadioGroup
          value={props.value}
          onValueChange={(next) => {
            const parsed = chatRoutingSchema.safeParse(next);
            if (parsed.success) props.onChange(parsed.data);
          }}
        >
          {CHAT_ROUTING_OPTIONS.map((option) => (
            <ContextMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </ContextMenuRadioItem>
          ))}
        </ContextMenuRadioGroup>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

const NO_SUBSCRIBE = (): (() => void) => () => {};

interface ChatRoutingTabMenuProps {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
}

/**
 * The tab menu's entry for one chat. Reads the chat's record from the session
 * the tab already holds and offers nothing when there is none to read or the
 * host's `agent.configure` predates the field. It is shown but not enabled for
 * a chat the person does not own (the host refuses to configure one) and for
 * a chat with no run tuple yet to restate.
 */
export function ChatRoutingTabMenu(props: ChatRoutingTabMenuProps) {
  const { epicId, chatId, hostId } = props;
  const handle = useExistingChatSessionHandle(epicId, chatId, hostId);
  const chat = useSyncExternalStore(
    handle === null ? NO_SUBSCRIBE : handle.store.subscribe,
    () => (handle === null ? null : handle.store.getState().chat),
  );
  const role = useSyncExternalStore(
    handle === null ? NO_SUBSCRIBE : handle.store.subscribe,
    () =>
      handle === null ? null : (handle.store.getState().access?.role ?? null),
  );
  const client = useHostClientForHostId(hostId);
  const configure = useAgentConfigure(client);
  const version = useHostMethodSchemaVersion(hostId, "agent.configure");
  if (chat === null || !agentConfigureCarriesRouting(version)) return null;
  const settings: ChatRunSettings | null = chat.settings;
  return (
    <ChatRoutingContextMenuGroup
      value={chatRoutingOf(chat)}
      disabled={role !== "owner" || settings === null || configure.isPending}
      onChange={(routing) => {
        const request = buildRoutingConfigureRequest({
          epicId,
          chatId,
          settings,
          routing,
        });
        if (request !== null) configure.mutate(request);
      }}
    />
  );
}
