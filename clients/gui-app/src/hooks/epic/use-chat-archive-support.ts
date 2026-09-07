import {
  useHostMethodSupport,
  useHostSupportsMethod,
} from "@/hooks/host/use-host-supports-method";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";

/** The archive RPC's method name, shared by the capability gate and the mutation so the two can never name different methods. */
export const SET_CHAT_ARCHIVED_METHOD = "epic.setChatArchived";

/**
 * Archive affordances fail closed while the host manifest is unknown. Per-record actions check the record's owning host, which may differ from the epic list host.
 */
export function useChatArchiveSupported(): boolean {
  const epicHostId = useEpicSessionHostId();
  return useHostSupportsMethod(epicHostId, SET_CHAT_ARCHIVED_METHOD);
}

/**
 * Known-absent host stops hiding archived rows so they stay reachable. `null` (pre-handshake) keeps hiding to avoid a flash.
 */
export function useChatArchiveSupportState(): boolean | null {
  const epicHostId = useEpicSessionHostId();
  return useHostMethodSupport(epicHostId, SET_CHAT_ARCHIVED_METHOD);
}
