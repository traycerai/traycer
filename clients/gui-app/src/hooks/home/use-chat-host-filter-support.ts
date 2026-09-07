import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";

/**
 * Gate on `epic.listTasks` minor, not presence: older minors silently strip `chatHostIds` and return a well-formed unfiltered list.
 */
export type ChatHostFilterSupport = "supported" | "unsupported" | "unknown";

const CHAT_HOST_FILTER_MINOR = 3;

export function useChatHostFilterSupport(
  hostId: string | null,
): ChatHostFilterSupport {
  const version = useHostMethodSchemaVersion(hostId, "epic.listTasks");
  if (version === null) return "unknown";
  if (version.major !== 1) return "unsupported";
  return version.minor >= CHAT_HOST_FILTER_MINOR ? "supported" : "unsupported";
}
