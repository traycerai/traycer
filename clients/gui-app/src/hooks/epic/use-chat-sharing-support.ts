import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";

/** The visibility RPC's method name, shared by the capability gate and the mutation so the two can never name different methods. */
export const SET_CLOUD_CHAT_VISIBILITY_METHOD = "epic.setCloudChatVisibility";

/** The per-task sharing-default RPC's method name, shared by the capability gate and the mutation so the two can never name different methods. */
export const SET_CHAT_SHARING_DEFAULT_METHOD = "epic.setChatSharingDefault";

/**
 * Share affordances fail closed while the host manifest is unknown. Writes go to the epic session's owning host; the sidebar sits outside every tile `TabHostProvider`.
 */
export function useCloudChatVisibilitySupported(): boolean {
  const epicHostId = useEpicSessionHostId();
  return useHostSupportsMethod(epicHostId, SET_CLOUD_CHAT_VISIBILITY_METHOD);
}

/** Whether the sharing panel's "My agents" master toggle should be offered. */
export function useChatSharingDefaultSupported(): boolean {
  const epicHostId = useEpicSessionHostId();
  return useHostSupportsMethod(epicHostId, SET_CHAT_SHARING_DEFAULT_METHOD);
}
