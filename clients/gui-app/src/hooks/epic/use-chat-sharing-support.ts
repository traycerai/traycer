import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";

/**
 * The visibility RPC's method name, shared by the capability gate and the
 * mutation so the two can never name different methods.
 */
export const SET_CLOUD_CHAT_VISIBILITY_METHOD = "epic.setCloudChatVisibility";

/**
 * The per-task sharing-default RPC's method name, shared by the capability
 * gate and the mutation so the two can never name different methods.
 */
export const SET_CHAT_SHARING_DEFAULT_METHOD = "epic.setChatSharingDefault";

/**
 * Whether the per-chat Share / Make private affordance should be offered.
 *
 * `epic.setCloudChatVisibility` is registered OFF the released floor with
 * `degrade: { kind: "unsupported" }`, so a host predating it negotiates the
 * method away rather than failing the handshake — and the row-menu entry
 * disappears on such a host instead of offering an action that cannot work.
 *
 * Scoped to the surrounding Epic session's owning host, matching
 * `useEpicSetCloudChatVisibility`. The sidebar is a sibling of the canvas and
 * therefore sits outside every tile-level `TabHostProvider`; its writes belong
 * to the same host that owns the Epic stream.
 *
 * Fails closed while the host's manifest is still unknown - see
 * {@link useHostSupportsMethod}.
 */
export function useCloudChatVisibilitySupported(): boolean {
  const epicHostId = useEpicSessionHostId();
  return useHostSupportsMethod(epicHostId, SET_CLOUD_CHAT_VISIBILITY_METHOD);
}

/**
 * Whether the sharing panel's "My agents" master toggle should be offered.
 *
 * Same degrade / hide-never-error rule as {@link useCloudChatVisibilitySupported},
 * for `epic.setChatSharingDefault`. The sharing panel is also outside every
 * tile-level `TabHostProvider`, so this checks the Epic session host.
 */
export function useChatSharingDefaultSupported(): boolean {
  const epicHostId = useEpicSessionHostId();
  return useHostSupportsMethod(epicHostId, SET_CHAT_SHARING_DEFAULT_METHOD);
}
